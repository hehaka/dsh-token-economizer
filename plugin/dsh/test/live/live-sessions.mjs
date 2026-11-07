#!/usr/bin/env node
// Live check of how the DSH plugin behaves across sessions and processes (docs/dsh/adr/0004, plan task T5,
// criteria D4, D6, D9): a subagent, two dsh processes at once, and a process killed with SIGTERM.
// About 8-10 small `dsh headless` sessions against a real model.
//
//   node plugin/dsh/test/live/live-sessions.mjs [--profile headless] [--only subagent|concurrent|sigterm]
//
// Groups (all run by default):
//   subagent    REAL core, a repository whose `.dsh/token-economizer.local.json` denies `read_image` (a visible,
//               harmless tool of the headless profile). The prompt makes the model delegate a bash task to the
//               `subagent` tool. Checks: the root session's request tools lack `read_image` (the restriction
//               applied); a SUBAGENT session exists (log header `origin: subagent`, a parent session, or a
//               `subagent/descriptor` event; found by listing the sessions root before and after) and its request
//               tools contain `read_image` (a subagent is not restricted, ADR 0004); exactly one spool and one
//               ledger record of kind session, both the root session's (the subagent is not folded as a root
//               session); exactly one endpoint file existed during the process (polled), none is left after it.
//               A model that does not delegate FAILS the run (nothing passes silently).
//   concurrent  (1) two `dsh headless` processes started at once on ONE state home, each in its own repository,
//               with the stub core in TE_LIVE_ROUTE=1 mode (one side file per process): both exit 0, the rows'
//               `endpoint_file` values differ and carry each process's pid, the UserPromptSubmit and PostToolUse
//               side calls succeed, `hosts/dsh/catalog.json` is valid JSON. (2) two more on a second shared home
//               with the REAL core: exactly two ledger records of kind session, every ledger line is JSON.
//   sigterm     a `dsh headless` (stub core) whose model runs `sleep 25`; SIGTERM once its endpoint file exists.
//               INFO whether the file is still there. Then the core's real runner against that file (or, when it
//               was removed, a fabricated stale file of an exited pid) must answer ("", None) in < 10 s, and one
//               more short normal session on the same home must sweep the stale file and leave none of its own.
// State goes to temp directories (TOKENECONOMIZER_HOME, CLAUDE_CONFIG_DIR). Credentials come from the profile's
// `.env` and are never printed; provider-supplied text goes through redact().
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HERE, REPO, allSessions, arg, endpointFiles, fakeGitRepo, jsonl, loadProfileEnv, makeChecker, overlay as makeOverlay,
  prepareWork, readSessionEvents, redact, sleep, spawnDsh, spoolIds, tail, waitFor,
} from './common.mjs';
import { readLog } from './zstd-log.mjs';

const USAGE = 'usage: node plugin/dsh/test/live/live-sessions.mjs [--profile headless] [--only subagent|concurrent|sigterm]';
const KNOWN = new Set(['--profile', '--only']);
const GROUPS = ['subagent', 'concurrent', 'sigterm'];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (!KNOWN.has(argv[i]) || i + 1 >= argv.length) {
    console.error(`unknown or incomplete argument: ${argv[i]}\n${USAGE}`);
    process.exit(2);
  }
  i += 1;                                               // every flag takes a value
}
const only = arg('--only', undefined);
if (only !== undefined && !GROUPS.includes(only)) {
  console.error(`unknown --only value: ${only}\n${USAGE}`);
  process.exit(2);
}
const profile = arg('--profile', 'headless');
const { check, summary } = makeChecker();
const info = (name, value) => console.log(`INFO  ${name}: ${value}`);
const baseEnv = (work, home) => ({ TOKENECONOMIZER_HOME: home, CLAUDE_CONFIG_DIR: join(work, 'claude'), TE_FOLD_SYNC: '1' });

/** Every `ledger.jsonl` under `<home>/repos` (the per-repository, per-host layout), parsed line by line. */
function ledgerOf(home) {
  const files = [];
  const walk = (dir, depth) => {
    let names = [];
    try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      if (e.isFile() && e.name === 'ledger.jsonl') files.push(join(dir, e.name));
      else if (e.isDirectory() && depth < 3) walk(join(dir, e.name), depth + 1);
    }
  };
  walk(join(home, 'repos'), 0);
  const records = [];
  let bad = 0;
  let lines = 0;
  for (const f of files) {
    for (const line of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
      lines += 1;
      try { records.push(JSON.parse(line)); } catch { bad += 1; }
    }
  }
  return { records, bad, lines, files: files.length, sessions: records.filter((r) => r?.kind === 'session') };
}

/** The first request/header tool names of a session log, read from the log file itself. */
const toolsOf = (id) => {
  const f = allSessions().get(id);
  return f ? readLog(f).find((e) => e.type === 'request/header')?.data?.header?.tools?.map((t) => t.name) : undefined;
};

/** Collects the endpoint file names seen under `<home>` while a run is alive. */
function watchEndpoints(home) {
  const seen = new Set();
  let max = 0;
  const tick = () => { const now = endpointFiles(home); now.forEach((n) => seen.add(n)); max = Math.max(max, now.length); };
  const timer = setInterval(tick, 50);
  return { seen, get max() { return max; }, stop: () => { clearInterval(timer); tick(); } };
}

const succeeded = (x, route) => Boolean(x) && !x.error && typeof x.reply?.text === 'string' && Boolean(x.text)
  && x.reply.provider === route.provider && x.reply.model === route.model;
const rowDetail = (x, route) => (x ? `${x.reply?.provider}/${x.reply?.model} vs ${route.provider}/${route.model}, text ${JSON.stringify((x.text ?? '').slice(0, 20))}, error ${redact(x.error ?? x.reply?.error?.code ?? 'none')}` : 'no row');

/** The session id and route (`request/context`) of a stub-core run, from its hook log. */
function routeOf(hooksLog) {
  const spool = jsonl(hooksLog).map((x) => x.payload).find((p) => p.transcript_path)?.transcript_path;
  const sid = spool && /session-[0-9a-f-]+/.exec(spool)?.[0];
  const ctx = readSessionEvents(sid).find((e) => e.type === 'request/context');
  return { sid, provider: ctx?.data?.provider, model: ctx?.data?.model };
}

// -- (A) subagent -----------------------------------------------------------------------------------
const DENIED = 'read_image';

async function subagentGroup() {
  console.log('\n== subagent ==');
  loadProfileEnv(profile);
  const { work, entry } = prepareWork('te-dsh-live-sessions-subagent');
  const repo = fakeGitRepo(join(work, 'repo'));
  const home = join(work, 'state');
  mkdirSync(join(repo, '.dsh'), { recursive: true });
  writeFileSync(join(repo, '.dsh', 'token-economizer.local.json'), `${JSON.stringify({ tokeneconomizer: { deny: [DENIED] } })}\n`);
  const patch = makeOverlay(work, entry, 'real', {});          // the real core: no bootstrap
  const before = new Set(allSessions().keys());
  const watch = watchEndpoints(home);
  const run = spawnDsh(['--profile', profile, '--patch', patch,
    'Use the `subagent` tool exactly once to delegate this task to a subagent: `run bash: echo te-live-subagent, then reply done`. '
      + 'Wait for the subagent\'s result, then reply done yourself.'], baseEnv(work, home), repo);
  const r = await run.done;
  watch.stop();
  check('subagent: the headless run exited 0', r.status === 0, `exit ${r.status}${r.timedOut ? ' (timed out)' : ''}`);
  if (r.status !== 0) console.log(redact(tail(r.stderr)));

  const spools = spoolIds(home);
  const rootId = spools[0];
  const catalog = (() => { try { return JSON.parse(readFileSync(join(home, 'hosts', 'dsh', 'catalog.json'), 'utf8')).tools ?? []; } catch { return []; } })();
  check(`subagent: ${DENIED} is in the tool catalog (a visible, non-core tool)`, catalog.includes(DENIED), `${catalog.length} tools in the catalog`);

  // Sessions of this run: new ones whose log header names this run's repository.
  const repoReal = realpathSync(repo);
  const fresh = [...allSessions()].filter(([id]) => !before.has(id)).map(([id, file]) => ({ id, events: readLog(file) }))
    .filter(({ events }) => (events[0]?.cwd ?? '').startsWith(repoReal));
  const isSub = ({ events }) => events[0]?.origin === 'subagent' || events[0]?.parentSession !== undefined || events.some((e) => e.type === 'subagent/descriptor');
  const subs = fresh.filter(isSub);
  const roots = fresh.filter((s) => !isSub(s));
  console.log(`sessions of this run: ${roots.length} root, ${subs.length} subagent (${subs.map((s) => `${s.id} origin=${s.events[0]?.origin} parent=${s.events[0]?.parentSession ?? 'none'}`).join('; ') || 'none'})`);
  info('the model delegated to a subagent', subs.length > 0 ? 'yes' : 'no');

  const rootTools = rootId ? toolsOf(rootId) : undefined;
  check(`subagent: the root session's request tools lack ${DENIED} (the restriction applied to the root agent)`,
    Array.isArray(rootTools) && rootTools.length > 0 && !rootTools.includes(DENIED),
    rootTools ? `${rootTools.length} tools, subagent tool ${rootTools.includes('subagent') ? 'present' : 'ABSENT'}` : 'no request/header for the root session');

  check('subagent: at least one SUBAGENT session exists (the model delegated)', subs.length > 0,
    subs.length > 0 ? `${subs.length} subagent session(s)` : 'FAIL: the model did not delegate, so the subagent checks cannot run');
  const subTools = subs.map((s) => toolsOf(s.id)).find(Array.isArray);
  check(`subagent: the subagent's request tools CONTAIN ${DENIED} (a subagent is not restricted, ADR 0004)`,
    Array.isArray(subTools) && subTools.includes(DENIED),
    subTools ? `${subTools.length} tools` : (subs.length ? 'the subagent session has no request/header' : 'no subagent session'));

  check('subagent: exactly one spool file in <home>/dsh-sessions (only the root session is spooled)', spools.length === 1, `${spools.length}: ${spools.join(', ') || 'none'}`);
  check('subagent: the spool is the root session\'s, not a subagent\'s', Boolean(rootId) && roots.some((s) => s.id === rootId) && !subs.some((s) => s.id === rootId), rootId ?? 'no spool');
  const ledger = ledgerOf(home);
  check('subagent: exactly one ledger record of kind session, and it is the root session\'s (the subagent was not folded)',
    ledger.sessions.length === 1 && ledger.sessions[0].session_id === rootId,
    `${ledger.sessions.length} session record(s): ${ledger.sessions.map((x) => x.session_id).join(', ') || 'none'}`);

  check('subagent: exactly one endpoint file existed for the process while it ran (polled every 50 ms)',
    watch.seen.size === 1 && watch.max === 1, `${watch.seen.size} distinct file(s) seen, at most ${watch.max} at a time: ${[...watch.seen].join(', ') || 'none'}`);
  check('subagent: no endpoint file is left after the process exited', endpointFiles(home).length === 0, endpointFiles(home).join(', ') || 'none left');
  return work;
}

// -- (B) concurrent ---------------------------------------------------------------------------------
async function concurrentGroup() {
  console.log('\n== concurrent ==');
  loadProfileEnv(profile);

  // (1) the stub core in route mode: two processes, one home.
  const a = prepareWork('te-dsh-live-sessions-conc-stub');
  const stub = join(a.pkg, 'test-stub-core.py');
  writeFileSync(stub, readFileSync(join(HERE, 'stub_core.py')));
  const patchA = makeOverlay(a.work, a.entry, 'stub', { bootstrap: stub });
  const homeA = join(a.work, 'state');
  const procs = ['one', 'two'].map((k) => {
    const repo = fakeGitRepo(join(a.work, `repo-${k}`));
    const env = {
      ...baseEnv(a.work, homeA), TE_LIVE_LOG: join(a.work, `hooks-${k}.jsonl`), TE_LIVE_SIDE: join(a.work, `side-${k}.jsonl`),
      TE_LIVE_ROUTE: '1', TE_LIVE_RUNNER: '', TE_LIVE_REPO: REPO,
    };
    return { k, env, repo };
  });
  const watch = watchEndpoints(homeA);
  for (const p of procs) {                                      // started in the same tick
    Object.assign(p, spawnDsh(['--profile', profile, '--patch', patchA, 'Use the bash tool to run `echo te-live-concurrent`, then reply: done'], p.env, p.repo));
  }
  const results = await Promise.all(procs.map((p) => p.done));
  watch.stop();
  procs.forEach((p, i) => { p.result = results[i]; });
  info('endpoint files seen while the two processes ran', `${[...watch.seen].join(', ') || 'none'} (at most ${watch.max} at a time)`);

  const files = [];
  for (const p of procs) {
    check(`concurrent ${p.k}: the headless run exited 0`, p.result.status === 0, `pid ${p.pid}, exit ${p.result.status}${p.result.timedOut ? ' (timed out)' : ''}`);
    if (p.result.status !== 0) console.log(redact(tail(p.result.stderr)));
    const rows = jsonl(p.env.TE_LIVE_SIDE);
    const route = routeOf(p.env.TE_LIVE_LOG);
    const row = (phase) => rows.find((x) => x.phase === phase);
    const names = [...new Set(rows.map((x) => x.endpoint_file))];
    const own = `sidecall.${p.pid}.endpoint.json`;
    files.push(names.length === 1 ? names[0] : undefined);
    check(`concurrent ${p.k}: all its rows name one endpoint file, called ${own}`, names.length === 1 && typeof names[0] === 'string' && names[0].split('/').pop() === own,
      `${rows.length} row(s), endpoint_file ${names.map((n) => String(n).split('/').pop()).join(', ') || 'none'}`);
    check(`concurrent ${p.k}: the session log names the session's route`, Boolean(route.provider && route.model), route.provider ? `${route.provider}/${route.model}` : 'no request/context');
    for (const phase of ['UserPromptSubmit', 'PostToolUse']) {
      check(`concurrent ${p.k}: ${phase} side call succeeded on the session's route`, succeeded(row(phase), route), rowDetail(row(phase), route));
    }
    const ss = row('SessionStart');
    info(`concurrent ${p.k}: SessionStart call`, ss ? (ss.reply?.error?.code === 'NO_ROUTE' ? 'NO_ROUTE (before agent/created)' : (succeeded(ss, route) ? 'success (raced agent/created)' : 'neither')) : 'no row');
  }
  check('concurrent: the two processes used DIFFERENT endpoint files', files.every(Boolean) && files[0] !== files[1], files.map((f) => String(f).split('/').pop()).join(' vs '));
  let tools;
  try { tools = JSON.parse(readFileSync(join(homeA, 'hosts', 'dsh', 'catalog.json'), 'utf8'))?.tools; } catch { tools = undefined; }
  check('concurrent: hosts/dsh/catalog.json parses as JSON with > 5 tools after both ended', Array.isArray(tools) && tools.length > 5, `${tools?.length ?? 'unreadable'} tools`);
  check('concurrent: no endpoint file is left after both processes exited', endpointFiles(homeA).length === 0, endpointFiles(homeA).join(', ') || 'none left');

  // (2) the real core: two processes, a second shared home, one ledger.
  const b = prepareWork('te-dsh-live-sessions-conc-real');
  const patchB = makeOverlay(b.work, b.entry, 'real', {});
  const homeB = join(b.work, 'state');
  const runs = ['one', 'two'].map((k) => spawnDsh(['--profile', profile, '--patch', patchB, 'Use the bash tool to run `echo te-live-concurrent-real`, then reply: done'],
    baseEnv(b.work, homeB), fakeGitRepo(join(b.work, `repo-${k}`))));
  const outs = await Promise.all(runs.map((x) => x.done));
  outs.forEach((o, i) => {
    check(`concurrent real core ${i + 1}: the headless run exited 0`, o.status === 0, `exit ${o.status}${o.timedOut ? ' (timed out)' : ''}`);
    if (o.status !== 0) console.log(redact(tail(o.stderr)));
  });
  const ledger = ledgerOf(homeB);
  check('concurrent real core: exactly two ledger records of kind session', ledger.sessions.length === 2,
    `${ledger.sessions.length} session record(s): ${ledger.sessions.map((r) => r.session_id).join(', ') || 'none'}; ${ledger.records.length} record(s) in all`);
  check('concurrent real core: every ledger line parses as JSON', ledger.bad === 0 && ledger.lines > 0, `${ledger.lines} line(s) in ${ledger.files} file(s), ${ledger.bad} unparsable`);
  check('concurrent real core: the two records are two different sessions, both spooled', new Set(ledger.sessions.map((r) => r.session_id)).size === 2 && ledger.sessions.every((r) => spoolIds(homeB).includes(r.session_id)),
    `spools: ${spoolIds(homeB).length}`);
  return b.work;
}

// -- (C) sigterm ------------------------------------------------------------------------------------
const RUNNER = `
import json, sys, time
from tokeneconomizer.plugin import sidecall
class Cfg:
    paid_model = ""
t = time.time()
out = sidecall.runner_for("dsh", Cfg())("hi")
print(json.dumps([out[0], out[1], round(time.time() - t, 3)]))
`;

/** The real Python runner against one endpoint file: { text, effective, seconds, wall } (undefined fields on a crash). */
function runRunner(file, home) {
  const t0 = Date.now();
  const r = spawnSync('python3', ['-c', RUNNER], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, PYTHONPATH: REPO, TE_DSH_SIDECALL_FILE: file, TOKENECONOMIZER_HOME: home } });
  const wall = (Date.now() - t0) / 1000;
  try {
    const [text, effective, seconds] = JSON.parse(r.stdout.trim().split('\n').pop());
    return { text, effective, seconds, wall, status: r.status };
  } catch {
    return { wall, status: r.status, stderr: redact(tail(r.stderr)) };
  }
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };
const ppidOf = (pid) => Number(spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()) || undefined;

async function sigtermGroup() {
  console.log('\n== sigterm ==');
  loadProfileEnv(profile);
  const { work, pkg, entry } = prepareWork('te-dsh-live-sessions-sigterm');
  const stub = join(pkg, 'test-stub-core.py');
  writeFileSync(stub, readFileSync(join(HERE, 'stub_core.py')));
  const patch = makeOverlay(work, entry, 'stub', { bootstrap: stub });
  const home = join(work, 'state');
  const envFor = (tag) => ({
    ...baseEnv(work, home), TE_LIVE_LOG: join(work, `hooks-${tag}.jsonl`), TE_LIVE_SIDE: join(work, `side-${tag}.jsonl`),
    TE_LIVE_ROUTE: '1', TE_LIVE_RUNNER: '', TE_LIVE_REPO: REPO,
  });
  const dir = join(home, 'hosts', 'dsh');
  const spawned = [];                                              // pids of processes this group started
  let fileOf;
  try {
    // The long session.
    const long = spawnDsh(['--profile', profile, '--patch', patch,
      'Use the bash tool to run `sleep 25` (in the foreground; wait for it to finish, do not run it in the background), then reply: done'],
    envFor('long'), fakeGitRepo(join(work, 'repo-long')));
    spawned.push(long.pid);
    const name = await waitFor(() => endpointFiles(home)[0], 60_000, 100);
    check('sigterm: the endpoint file appeared within 60 s', Boolean(name), name ?? 'none');
    if (!name) { long.child.kill('SIGKILL'); await long.done; return work; }
    const filePid = Number(/^sidecall\.(\d+)\./.exec(name)[1]);
    fileOf = join(dir, name);
    info('endpoint file pid vs the spawned dsh pid', filePid === long.pid ? `same (${filePid})` : `file ${filePid}, spawned ${long.pid} (a child process; its parent is ${ppidOf(filePid)})`);
    if (filePid !== long.pid && ppidOf(filePid) === long.pid) spawned.push(filePid);
    await sleep(3000);                                              // let the model reach the bash call; SIGTERM lands mid-session
    long.child.kill('SIGTERM');
    const exited = await Promise.race([long.done, sleep(30_000).then(() => undefined)]);
    check('sigterm: the process exited after SIGTERM within 30 s', Boolean(exited), exited ? `signal ${exited.signal}, status ${exited.status}` : 'still running');
    if (!exited) { long.child.kill('SIGKILL'); await long.done; }
    await sleep(500);
    info('the long session had finished its bash call (PostToolUse hook ran) before SIGTERM', jsonl(join(work, 'hooks-long.jsonl')).some((x) => x.payload?.hook_event_name === 'PostToolUse') ? 'yes' : 'no');
    const remained = existsSync(fileOf);
    info('the endpoint file is still there after SIGTERM', remained ? 'yes' : 'no');
    info('the process that owned the endpoint is still running after SIGTERM', alive(filePid) ? 'yes' : 'no');

    // The core's runner on a stale endpoint file (real if it remained, else fabricated).
    let stale = fileOf;
    let kind = 'the file SIGTERM left';
    if (!remained) {
      const gone = spawn('node', ['-e', '0'], { stdio: 'ignore' });
      await new Promise((r) => gone.on('close', r));
      mkdirSync(dir, { recursive: true });
      stale = join(dir, `sidecall.${gone.pid}.endpoint.json`);
      writeFileSync(stale, `${JSON.stringify({ port: 9, token: 'te-live-stale', pid: gone.pid })}\n`, { mode: 0o600 });
      kind = `a fabricated file of the exited pid ${gone.pid}`;
    }
    const staleAlive = remained && alive(filePid);
    if (staleAlive) console.log(`note: the endpoint's process ${filePid} is still alive, so the file is not stale; it is killed below`);
    const rr = runRunner(stale, home);
    check(`sigterm: the real runner on ${kind} returns ("", None) in < 10 s`, rr.text === '' && rr.effective === null && rr.wall < 10 && rr.seconds < 10,
      rr.text === undefined ? `runner crashed: ${rr.stderr}` : `text ${JSON.stringify(rr.text)}, effective ${rr.effective}, ${rr.seconds} s (wall ${rr.wall.toFixed(1)} s)`);
    if (staleAlive) { try { process.kill(filePid, 'SIGTERM'); } catch { /* gone */ } await sleep(500); }

    // A new normal session on the same home sweeps the stale file.
    const watch = watchEndpoints(home);
    const short = spawnDsh(['--profile', profile, '--patch', patch, 'Reply with the single word ok'], envFor('short'), fakeGitRepo(join(work, 'repo-short')));
    spawned.push(short.pid);
    const out = await short.done;
    watch.stop();
    check('sigterm: the follow-up normal session exited 0', out.status === 0, `exit ${out.status}${out.timedOut ? ' (timed out)' : ''}`);
    if (out.status !== 0) console.log(redact(tail(out.stderr)));
    check('sigterm: the stale endpoint file is gone after the new process started (swept)', !existsSync(stale), existsSync(stale) ? 'still there' : 'removed');
    const mine = [...watch.seen].filter((n) => n !== name && join(dir, n) !== stale);
    info('the new run\'s own endpoint file was seen while it ran', mine.length ? `yes (${mine.join(', ')})` : 'no');
    const left = endpointFiles(home);
    check('sigterm: the new run left no endpoint file of its own after a normal exit', left.length === 0 || (staleAlive && left.every((n) => n === name)), left.join(', ') || 'none left');
    info('the new run\'s own endpoint file after normal exit', left.length === 0 ? 'removed' : `left: ${left.join(', ')}`);
  } finally {
    for (const pid of spawned) {                                  // only processes this group started
      if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    }
  }
  return work;
}

// ---------------------------------------------------------------------------------------------------
let work = '(none)';
if (only === undefined || only === 'subagent') work = await subagentGroup();
if (only === undefined || only === 'concurrent') work = await concurrentGroup();
if (only === undefined || only === 'sigterm') work = await sigtermGroup();
process.exit(summary(work) ? 1 : 0);
