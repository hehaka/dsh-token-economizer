// Shared helpers for the live DSH check scripts (live-check.mjs and its siblings).
// Each script runs a real `dsh headless` against a real model; this module holds the setup
// they have in common: CLI parsing, PASS/FAIL reporting, profile `.env`, package build,
// the `--patch` overlay, the dsh process, and reading DSH's own session log.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readLog } from './zstd-log.mjs';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, '..', '..', '..', '..');

// -- CLI -------------------------------------------------------------------------------------
export const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
export const flag = (n) => process.argv.includes(n);

// -- reporting -------------------------------------------------------------------------------
// check() is graded (PASS/FAIL); info() reports model behaviour without grading it: a model may
// decline to echo a code from an automated note (one did, live), which says nothing about
// whether the plugin delivered it.
export function makeChecker() {
  const checks = [];
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  };
  const info = (name, ok) => console.log(`INFO  ${name}: ${ok ? 'yes' : 'no'}`);
  const failedCount = () => checks.filter((c) => !c.ok).length;
  // Prints the closing line and returns the number of failed checks (callers exit on it).
  const summary = (workDir) => {
    const failed = failedCount();
    console.log(`\n${checks.length - failed}/${checks.length} passed. Work directory: ${workDir}`);
    return failed;
  };
  return { check, info, failedCount, summary };
}

// The last few lines of a dsh stderr that say what went wrong.
export const tail = (t) => String(t || '').split('\n').filter((l) => /dsh:|Error|error/.test(l)).slice(-5).join('\n');

/** Best-effort scrub of provider-supplied text before printing: 200 chars, long token-like runs hidden. */
export const redact = (v) => String(v ?? '').slice(0, 200).replace(/[A-Za-z0-9_-]{24,}/g, '<redacted>');

export const jsonl = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// -- environment and workspace ---------------------------------------------------------------
// DSH reads `.env` from the directory it runs in; the checks run in a temp repository, so the
// profile's own `.env` (the credential its models name) is loaded here and inherited by the dsh
// processes. Values are never printed or copied.
export function loadProfileEnv(profile) {
  const envFile = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', profile, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  else console.log(`note: no ${envFile}; relying on the ambient environment for credentials`);
}

// Recreates the temp work directory and builds the plugin package into <work>/pkg.
export function prepareWork(name = 'te-dsh-live') {
  const work = join(tmpdir(), name);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const pkg = join(work, 'pkg');
  const b = spawnSync('python3', [join(REPO, 'scripts', 'build_dsh_plugin.py'), '--out', pkg], { encoding: 'utf8' });
  if (b.status !== 0) throw new Error(`build failed: ${b.stderr}`);
  const entry = pathToFileURL(join(pkg, 'index.mjs')).href;
  return { work, pkg, entry };
}

// A tiny git repository with a github remote, so the plugin resolves a repository name.
export function fakeGitRepo(dir) {
  mkdirSync(join(dir, '.git', 'info'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(dir, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/widget.git\n');
  return dir;
}

// Writes a `--patch` overlay that inserts the plugin entry (with optional config) into the profile.
export function overlay(work, entry, name, config) {
  const file = join(work, `${name}.patch.yml`);
  const cfg = Object.entries(config).map(([k, v]) => `        ${k}: ${JSON.stringify(v)}`).join('\n');
  const block = cfg ? `      config:\n${cfg}\n` : '';
  writeFileSync(file, `- insert:\n    - id: te-live\n      name: ${JSON.stringify(entry)}\n${block}`);
  return file;
}

// Runs `dsh` (default cwd: <work>/repo) with extra environment variables.
export const dsh = (work, args, env, timeout, cwd = join(work, 'repo')) =>
  spawnSync('dsh', args, { encoding: 'utf8', timeout, env: { ...process.env, ...env }, cwd });

// -- DSH's own session log -------------------------------------------------------------------
const sessionsRoot = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions');

// Path of a session's zstd log, or undefined when it is not (yet) on disk.
export function sessionLogFile(sessionId) {
  const root = sessionsRoot();
  return sessionId && existsSync(root)
    ? readdirSync(root).map((d) => join(root, d, sessionId, 'session.v4.jsonl.zstd')).find(existsSync)
    : undefined;
}

// All decoded events of a session's log ([] when the log is not found).
export function readSessionEvents(sessionId) {
  const f = sessionLogFile(sessionId);
  return f ? readLog(f) : [];
}

// Tool names in the first model request of a session (request/header), or undefined.
export function requestTools(sessionId) {
  const header = readSessionEvents(sessionId).find((e) => e.type === 'request/header');
  return header?.data?.header?.tools?.map((t) => t.name);
}
