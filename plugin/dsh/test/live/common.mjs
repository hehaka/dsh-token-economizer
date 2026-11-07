// Shared helpers for the live DSH check scripts (live-check.mjs and its siblings).
// Each script runs a real `dsh headless` against a real model; this module holds the setup
// they have in common: CLI parsing, PASS/FAIL reporting, profile `.env`, package build,
// the `--patch` overlay, the dsh process, and reading DSH's own session log.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

// -- `dsh web` helpers (live-multisession.mjs, browser-check.mjs) --------------------------------------
export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };

/**
 * The web profile's `--patch` overlay that carries the `profile`'s models (default headless): the top-level entries
 * `llm-pi-ai` and `agent-default-model` of its `cordis.patch.yml`, copied as text (no YAML library; the
 * entries name the key's environment variable, not the key, and the MCP servers of that file are left out).
 */
export function profileModelPatch(work, profile = 'headless') {
  const file = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', profile, 'cordis.patch.yml');
  if (!existsSync(file)) throw new Error(`no ${file}: pass --patch with a model configuration`);
  const keep = [];
  let on = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const id = /^- id: (\S+)/.exec(line)?.[1];
    if (id) on = id === 'llm-pi-ai' || id === 'agent-default-model';
    else if (/^\S/.test(line) && !line.startsWith('#')) on = false;
    if (on) keep.push(line);
  }
  const text = keep.join('\n');
  if (!/^- id: llm-pi-ai/m.test(text) || !/^- id: agent-default-model/m.test(text)) throw new Error(`${file} has no llm-pi-ai / agent-default-model entry`);
  const out = join(work, 'headless-models.patch.yml');
  writeFileSync(out, `${text}\n`);
  return out;
}

/**
 * An isolated `dsh web` (own DSH_HOME, own TokenEconomizer state, random port) with the plugin of `prep`
 * (`prepareWork`'s result) and the headless profile's models; the session workspace is a temp git repository
 * (DSH puts new sessions in `<Documents>/deepseek-harness/default-workspace`; the workspace controller's
 * `documentsDirectory` moves Documents into the work directory). The profile `.env` must be loaded already
 * (`loadProfileEnv`, before DSH_HOME is touched). `extraEnv` is added to the server's environment.
 * Resolves to `{ server, url, home, state, repo, logFile }` (url carries the launch token: never print it).
 */
export async function startWeb(prep, extraEnv = {}, profile = 'headless') {
  const { work, entry } = prep;
  const documents = join(work, 'documents');
  const repo = fakeGitRepo(join(documents, 'deepseek-harness', 'default-workspace'));
  const patch = join(work, 'te.yml');
  writeFileSync(patch, `- insert:\n    - id: te-live\n      name: ${JSON.stringify(entry)}\n- id: workspace-controller\n  name: '@deepseek-ai/dsh-api-workspace-controller'\n  config:\n    documentsDirectory: ${JSON.stringify(documents)}\n`);
  const home = join(work, 'home');
  const state = join(work, 'state');
  const env = { ...process.env, DSH_HOME: home, TOKENECONOMIZER_HOME: state, CLAUDE_CONFIG_DIR: join(work, 'claude'), TE_FOLD_SYNC: '1', ...extraEnv };
  for (const k of ['DSH_WEB_URL', 'DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_SHELL']) delete env[k];   // belong to a parent dsh session
  const server = spawn('dsh', ['--profile', 'web', '--patch', patch, '--patch', profileModelPatch(work, profile), '--port', '0', '--no-open'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logFile = join(work, 'server.log');
  let out = '';
  server.stdout.on('data', (d) => { out += d; appendFileSync(logFile, d); });
  server.stderr.on('data', (d) => { appendFileSync(logFile, d); });
  for (let i = 0; i < 80 && !/dsh web: \S+/.test(out); i += 1) await sleep(500);
  const url = /dsh web: (\S+)/.exec(out)?.[1];
  if (!url) { try { server.kill('SIGKILL'); } catch { /* gone */ } throw new Error(`dsh web did not start; see ${logFile}`); }
  return { server, url, home, state, repo, logFile };
}

/**
 * The JSON RPC of `dsh web` without a browser: the launch token is exchanged for the auth cookie, then every
 * call is `POST /api/<method>` with `{type:'client-request', rpcId, method, payload:{args}}`. `rpc(method, args)`
 * resolves to `{ status, ok, value, error }` (`error` is `{code, message}`; never print the token or the cookie).
 */
export async function webClient(url) {
  const u = new URL(url);
  const first = await fetch(`${u.origin}/${u.search}`, { redirect: 'manual' });
  const cookie = first.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error(`the launch-token exchange gave no cookie (HTTP ${first.status})`);
  const rpc = async (method, args = {}) => {
    const res = await fetch(`${u.origin}/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }), signal: AbortSignal.timeout(60_000),
    });
    let body;
    try { body = JSON.parse(await res.text()); } catch { body = {}; }
    const result = body?.result ?? {};
    return { status: res.status, ok: result.ok === true, value: result.value, error: result.ok === false ? result.error : undefined };
  };
  return { rpc };
}

/**
 * One `POST /v1/complete` to the plugin's side-call endpoint of the state root `home` (the file is
 * `<home>/hosts/dsh/sidecall.<pid>.endpoint.json`, the token goes in `Authorization`, never printed).
 * Resolves to `{ status, provider, model, text, usage, code }` (`status` 0 when there was no endpoint or no answer).
 */
export async function endpointPost(home, body, timeoutMs = 120_000) {
  const name = endpointFiles(home)[0];
  if (!name) return { status: 0, code: 'NO_ENDPOINT_FILE' };
  let ep;
  try { ep = JSON.parse(readFileSync(join(home, 'hosts', 'dsh', name), 'utf8')); } catch { return { status: 0, code: 'UNREADABLE_ENDPOINT_FILE' }; }
  try {
    const res = await fetch(`http://127.0.0.1:${ep.port}/v1/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.token}`, Host: `127.0.0.1:${ep.port}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    let j = {};
    try { j = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, provider: j.provider, model: j.model, text: typeof j.text === 'string' ? j.text : undefined, usage: j.usage, code: j.error?.code };
  } catch (e) {
    return { status: 0, code: redact(e?.message ?? e) };
  }
}
