// Shared helpers for the live DSH check scripts (live-check.mjs and its siblings).
// Each script runs a real `dsh headless` against a real model; this module holds the setup
// they have in common: CLI parsing, PASS/FAIL reporting, profile `.env`, package build,
// the `--patch` overlay, the dsh process, and reading DSH's own session log.
import { spawn, spawnSync } from 'node:child_process';
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
export const sessionsRoot = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions');

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

// -- generic helpers for scripts that run several dsh processes (live-sessions.mjs) ----------------
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` every `stepMs` until it returns something truthy (returned) or `timeoutMs` passes (undefined). */
export async function waitFor(fn, timeoutMs, stepMs = 100) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 >= timeoutMs) return undefined;
    await sleep(stepMs);
  }
}

/**
 * Starts `dsh` without waiting for it (spawn, as runDsh is spawnSync). Returns `{ child, pid, done }`;
 * `done` resolves to `{ status, signal, stdout, stderr, timedOut }` once the process has closed. A process
 * still running after `timeoutMs` is killed with SIGKILL (`timedOut: true`).
 */
export function spawnDsh(args, env, cwd, timeoutMs = 300_000) {
  const child = spawn('dsh', args, { env: { ...process.env, ...env }, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdin.on('error', () => {});
  child.stdin.end();
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  const done = new Promise((resolve) => {
    child.on('error', (e) => { clearTimeout(timer); resolve({ status: null, signal: null, stdout, stderr: `${stderr}${e}`, timedOut }); });
    child.on('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr, timedOut }); });
  });
  return { child, pid: child.pid, done };
}

/** Names of the side-call endpoint files (`sidecall.<pid>.endpoint.json`) under `<home>/hosts/dsh`. */
export function endpointFiles(home) {
  try {
    return readdirSync(join(home, 'hosts', 'dsh')).filter((n) => /^sidecall\.\d+\.endpoint\.json$/.test(n)).sort();
  } catch {
    return [];
  }
}

/** Every session on disk under DSH's sessions root: Map of session id -> log file. */
export function allSessions() {
  const root = sessionsRoot();
  const out = new Map();
  if (!existsSync(root)) return out;
  for (const d of readdirSync(root)) {
    let ids = [];
    try { ids = readdirSync(join(root, d)); } catch { continue; }
    for (const id of ids) {
      const f = join(root, d, id, 'session.v4.jsonl.zstd');
      if (existsSync(f)) out.set(id, f);
    }
  }
  return out;
}

/** Ids of the spool files (`<home>/dsh-sessions/<session id>.jsonl`) of a state root: the root sessions it saw. */
export function spoolIds(home) {
  const dir = join(home, 'dsh-sessions');
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.jsonl')).map((n) => n.replace(/\.jsonl$/, '')).sort() : [];
}
