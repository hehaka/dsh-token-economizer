#!/usr/bin/env node
// Live check of the DSH plugin against a real `dsh headless` run (two tiny model calls).
//
//   node plugin/dsh/test/live/live-check.mjs [--profile headless] [--dump-only]
//
// What it settles (docs/dsh/spike-phase-b.md, B3 and the shapes the plugin assumes):
//   1. the plugin loads from a --patch overlay (your profile is not edited);
//   2. the hook payloads the plugin builds from real DSH events have the shape the core expects;
//   3. the model SEES the facts (system-prompt/assemble) and the context after a tool
//      (tools/post-execute additionalContexts);
//   4. with the real core, a finished session ends up as a ledger record.
// State goes to a temp directory (TOKENECONOMIZER_HOME, CLAUDE_CONFIG_DIR). It does start
// whatever MCP servers the chosen profile starts, as any `dsh headless` run does.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readLog } from './zstd-log.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const profile = arg('--profile', 'headless');
const dumpOnly = process.argv.includes('--dump-only');
const work = join(tmpdir(), 'te-dsh-live');
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const tail = (t) => String(t || '').split('\n').filter((l) => /dsh:|Error|error/.test(l)).slice(-5).join('\n');
// Model behaviour is reported, not graded: a model may decline to echo a code from an automated
// note (one did, live), which says nothing about whether the plugin delivered it.
const info = (name, ok) => console.log(`INFO  ${name}: ${ok ? 'yes' : 'no'}`);
const jsonl = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// DSH reads `.env` from the directory it runs in; this check runs in a temp repository, so the
// profile's own `.env` (the credential its models name) is loaded here and inherited by the dsh
// processes. Values are never printed or copied.
const envFile = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', profile, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
else console.log(`note: no ${envFile}; relying on the ambient environment for credentials`);

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const pkg = join(work, 'pkg');
const b = spawnSync('python3', [join(REPO, 'scripts', 'build_dsh_plugin.py'), '--out', pkg], { encoding: 'utf8' });
if (b.status !== 0) throw new Error(`build failed: ${b.stderr}`);
const entry = pathToFileURL(join(pkg, 'index.mjs')).href;

function overlay(name, config) {
  const file = join(work, `${name}.patch.yml`);
  const cfg = Object.entries(config).map(([k, v]) => `        ${k}: ${JSON.stringify(v)}`).join('\n');
  const block = cfg ? `      config:\n${cfg}\n` : '';
  writeFileSync(file, `- insert:\n    - id: te-live\n      name: ${JSON.stringify(entry)}\n${block}`);
  return file;
}
const dsh = (args, env, timeout) =>
  spawnSync('dsh', args, { encoding: 'utf8', timeout, env: { ...process.env, ...env }, cwd: join(work, 'repo') });

const repo = join(work, 'repo');
mkdirSync(join(repo, '.git', 'info'), { recursive: true });
writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
writeFileSync(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/widget.git\n');

const stub = join(pkg, 'test-stub-core.py');
writeFileSync(stub, readFileSync(join(HERE, 'stub_core.py')));
const logFile = join(work, 'hooks.jsonl');
const sideFile = join(work, 'side.jsonl');
const env = (state) => ({ TOKENECONOMIZER_HOME: state, CLAUDE_CONFIG_DIR: join(work, 'claude'), TE_LIVE_LOG: logFile, TE_LIVE_SIDE: sideFile, TE_FOLD_SYNC: '1' });

// -- 1. the entry composes into the profile tree --------------------------------------------
const patch1 = overlay('stub', { bootstrap: stub });
const dump = dsh(['--profile', profile, '--patch', patch1, '--dump-config'], env(join(work, 'state1')), 60_000);
check('the plugin entry composes into the profile tree', dump.status === 0 && /te-live/.test(dump.stdout), dump.status === 0 ? '' : dump.stderr.slice(0, 200));
if (dumpOnly || dump.status !== 0) process.exit(dump.status === 0 ? 0 : 1);

// -- 2. a run with the stub core: shapes and delivery ---------------------------------------
const task = 'Use the bash tool to run exactly: echo te-live-check . Then answer with one line in this exact format and nothing else: ' +
  'FACTS=<the code starting with TE-LIVE-FACTS that appears anywhere in your instructions or context, or NONE>; ' +
  'REDIRECT=<the code starting with TE-LIVE-REDIRECT from a TokenEconomizer note that arrived after the tool result, or NONE>';
const r1 = dsh(['--profile', profile, '--patch', patch1, task], env(join(work, 'state1')), 240_000);
console.log(`\n-- model answer --\n${(r1.stdout || '').trim().slice(-600)}\n`);
check('the headless run finished', r1.status === 0, `exit ${r1.status}`);
if (r1.status !== 0) console.log(tail(r1.stderr));
const calls = jsonl(logFile).map((x) => x.payload);
const by = (e) => calls.filter((p) => p.hook_event_name === e);
check('SessionStart reached the core', by('SessionStart').length >= 1);
const prompts = by('UserPromptSubmit');
check('exactly one UserPromptSubmit, with prompt_id p1 and the typed text', prompts.length === 1 && prompts[0].prompt_id === 'p1' && /te-live-check/.test(prompts[0].prompt || ''), `${prompts.length} seen`);
const tools = by('PostToolUse');
const bash = tools.find((p) => p.tool_name === 'bash');
check('PostToolUse for bash, arguments as an object, output in tool_response', Boolean(bash) && typeof bash.tool_input === 'object' && /te-live-check/.test(JSON.stringify(bash.tool_response)), bash ? JSON.stringify(bash.tool_input).slice(0, 80) : 'no bash call seen');
check('Stop and SessionEnd reached the core', by('Stop').length >= 1 && by('SessionEnd').length === 1, `Stop ${by('Stop').length}, SessionEnd ${by('SessionEnd').length}`);
const spool = calls.find((p) => p.transcript_path)?.transcript_path;
check('the spool file exists', Boolean(spool) && existsSync(spool), spool ?? '');
if (spool && existsSync(spool)) {
  const rows = jsonl(spool);
  const users = rows.filter((x) => x.message?.role === 'user');
  check('the spool holds the one typed prompt, not injected context', users.length === 1, `${users.length} user entries`);
}
// What DSH itself recorded (deterministic, unlike the model's answer): the session log holds the
// facts inside the runtime-context message and the note as a next-step inbox message.
const sid = spool && /session-[0-9a-f-]+/.exec(spool)?.[0];
const sessionsRoot = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions');
const logFile1 = sid && existsSync(sessionsRoot)
  ? readdirSync(sessionsRoot).map((d) => join(sessionsRoot, d, sid, 'session.v4.jsonl.zstd')).find(existsSync) : undefined;
const events = logFile1 ? readLog(logFile1) : [];
const spliced = events.find((e) => e.type === 'agent/inbox/spliced' && JSON.stringify(e).includes('TE-LIVE-REDIRECT-91bc'));
check('DSH recorded the facts in the model-facing context', events.some((e) => e.type === 'user/message' && e.data?.source?.kind === 'runtime-context' && JSON.stringify(e).includes('TE-LIVE-FACTS-7f3a')), logFile1 ? `${events.length} events` : 'session log not found');
check('DSH queued the post-tool context for the next step', Boolean(spliced) && spliced.data?.target === 'next-step', spliced ? `target ${spliced.data.target}` : 'no inbox event');
// The note must sit in the conversation after the tool result and before the next model answer.
const seqOf = (pred) => events.find(pred)?.seq;
const toolSeq = seqOf((e) => e.type === 'tool/result');
const noteSeq = seqOf((e) => e.type === 'user/message' && e.data?.source?.kind === 'token-economizer');
const lastAnswer = [...events].reverse().find((e) => e.type === 'assistant/message')?.seq;
check('the note follows the tool result and precedes the next answer', toolSeq < noteSeq && noteSeq < lastAnswer, `tool ${toolSeq} < note ${noteSeq} < answer ${lastAnswer}`);
// The core's own model call (docs/dsh/adr/0004): the stub core makes one through the endpoint the
// plugin put in the hook's environment, after the tool result (when a request has named a route).
const side = jsonl(sideFile);
const sc = side.find((x) => x.reply || x.error);
check('the hook\'s environment names the side-call endpoint', side.length > 0 && side.every((x) => x.endpoint_env), `${side.length} call(s)`);
check('a side call through the endpoint returns text and token usage', Boolean(sc?.reply?.text) && Number.isFinite(sc.reply.usage?.input_tokens), sc?.error ?? `${JSON.stringify(sc?.reply ?? {}).slice(0, 200)}`);
check('the side call ran on the session\'s route (a model is named)', typeof sc?.reply?.model === 'string' && sc.reply.model.length > 0, sc?.reply?.model ?? '');
const answer = r1.stdout || '';
info('the model reported the facts', /FACTS=TE-LIVE-FACTS-7f3a/.test(answer));
info('the model reported the note', /REDIRECT=TE-LIVE-REDIRECT-91bc/.test(answer));

// -- 3. a run with the real core: the session folds into the ledger -------------------------
const state2 = join(work, 'state2');
const patch2 = overlay('real', {});
const r2 = dsh(['--profile', profile, '--patch', patch2, 'Use the bash tool to run exactly: echo te-live-real . Then reply: done'], env(state2), 240_000);
check('the second headless run finished', r2.status === 0, `exit ${r2.status}`);
if (r2.status !== 0) console.log(tail(r2.stderr));
const ledgers = existsSync(state2) ? spawnSync('find', [state2, '-name', 'ledger.jsonl'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean) : [];
const rec = ledgers.flatMap(jsonl).find((x) => x.kind === 'session');
check('a ledger record for the DSH session', Boolean(rec) && /dsh/.test(ledgers[0]), rec ? `requests ${rec.requests}, model ${rec.model}, priced_by ${rec.priced_by}` : 'none');

// -- 4. /te through DSH's command executor -------------------------------------------------------
const diagFile = join(work, 'command_diag.mjs');
writeFileSync(diagFile, readFileSync(join(HERE, 'command_diag.mjs')));
const patch3 = join(work, 'cmd.patch.yml');
writeFileSync(patch3, `- insert:\n    - id: te-cmd-diag\n      name: ${JSON.stringify(pathToFileURL(diagFile).href)}\n    - id: te-live\n      name: ${JSON.stringify(entry)}\n`);
const diagLog = join(work, 'cmd.log');
const r3 = dsh(['--profile', profile, '--patch', patch3, 'Reply with the single word ok'], { ...env(join(work, 'state3')), TE_DIAG_LOG: diagLog }, 240_000);
check('the third headless run finished', r3.status === 0, `exit ${r3.status}`);
const lines = existsSync(diagLog) ? readFileSync(diagLog, 'utf8').split('\n').filter(Boolean) : [];
const names = lines.find((l) => l.startsWith('commands for agent:')) ?? '';
check('/te is among the agent\'s commands', /(^|[:,])te(,|$)/.test(names.replace('commands for agent: ', 'x:')), names);
const ran = Object.fromEntries(lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).map((x) => [x.line, x]));
let status;
try { status = JSON.parse(ran['/te status --json']?.text ?? ''); } catch { status = undefined; }
check('/te status --json answers for the session\'s repository (host dsh)', ran['/te status --json']?.kind === 'success' && status?.host === 'dsh' && status?.repo === 'acme/widget');
check('/te toolprune show answers on dsh', ran['/te toolprune show']?.kind === 'success' && !/not available/.test(ran['/te toolprune show']?.text ?? ''), (ran['/te toolprune show']?.text ?? '').slice(0, 80));
check('/te refuses the core\'s background commands', ran['/te fold --session x']?.kind === 'error' && /Unknown command/.test(ran['/te fold --session x']?.text ?? ''));

// -- 5. tool pruning: the deny list hides a tool from the model's request ----------------------
const sessionTools = (sessionId) => {
  const root = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions');
  const f = existsSync(root) ? readdirSync(root).map((d) => join(root, d, sessionId, 'session.v4.jsonl.zstd')).find(existsSync) : undefined;
  const header = f ? readLog(f).find((e) => e.type === 'request/header') : undefined;
  return header?.data?.header?.tools?.map((t) => t.name);
};
const catalogFile = join(state2, 'hosts', 'dsh', 'catalog.json');
const catalog = existsSync(catalogFile) ? JSON.parse(readFileSync(catalogFile, 'utf8')).tools : [];
check('the plugin recorded the tool list DSH offers (catalog.json)', Array.isArray(catalog) && catalog.length > 5 && catalog.includes('bash'), `${catalog.length} tools`);
const spoolOf = (state) => readdirSync(join(state, 'dsh-sessions')).map((n) => n.replace(/\.jsonl$/, ''));
const base = spoolOf(state2).map(sessionTools).find(Boolean) ?? [];
const victim = ['read_image', 'present', 'send_message', 'glob'].find((n) => base.includes(n) && catalog.includes(n));
check('a request\'s tool list is readable from the session log, to compare', base.length > 0 && Boolean(victim), `${base.length} tools in the request; victim ${victim}`);
if (victim) {
  mkdirSync(join(repo, '.dsh'), { recursive: true });
  writeFileSync(join(repo, '.dsh', 'token-economizer.local.json'), JSON.stringify({ tokeneconomizer: { deny: [victim, 'mcp__not__installed'] } }));
  const state4 = join(work, 'state4');
  const r4 = dsh(['--profile', profile, '--patch', patch2, 'Reply with the single word ok'], env(state4), 240_000);
  check('the run with a deny list finished (an unknown name did not break it)', r4.status === 0, `exit ${r4.status}`);
  const denied = existsSync(join(state4, 'dsh-sessions')) ? spoolOf(state4).map(sessionTools).find(Boolean) ?? [] : [];
  check('the denied tool is gone from the model\'s request, the others stay', denied.length > 0 && !denied.includes(victim) && denied.includes('bash'), `${denied.length} tools (baseline ${base.length})`);
  rmSync(join(repo, '.dsh'), { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} passed. Work directory: ${work}`);
process.exit(failed ? 1 : 0);
