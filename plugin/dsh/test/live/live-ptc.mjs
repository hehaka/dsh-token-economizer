#!/usr/bin/env node
// Live check of PTC mode (the `run_code` tool; docs/plans/2026-11-07-dsh-brakujace-kontrole-na-zywo.md T4,
// DoD D4, spike docs/iterations/1-spike.md Q4): a tool the model calls only from code inside `run_code`
// is in the spool (as a nested toolCall block) and never lands in the core's deny list.
//
//   node plugin/dsh/test/live/live-ptc.mjs [--profile headless]
//        [--used-tool mcp__postgres__postgres_mcp_list_connection_profiles]
//
// One temp git repository, an isolated TOKENECONOMIZER_HOME and the REAL core with the live-prune-loop
// environment (TE_TOOLPRUNE=auto, EVIDENCE=1, MIN_SESSIONS=1, SESSIONS=2, QUIET_MINUTES=0, TE_FOLD_SYNC=1).
// The `--patch` overlay inserts the plugin and switches the tools registry entry to PTC (the spike's
// recipe: `- id: tools / name: '@deepseek-ai/dsh-tools' / config: {mode: ptc}`; the headless profile already
// mounts the node PTC runtime), so the model sees `run_code` only and calls every other tool from code.
// Sessions: two (1 and 2) in which the model calls <used-tool> and bash ONLY from one `run_code`, then a
// control session that just answers.
// Checks (graded): every run exits 0 (a run never crashes); (a) session 1's first request has exactly the
// tools [run_code] (INFO: the count and names if more); (b) the spool of session 1 holds toolCall blocks for
// the nested <used-tool> AND bash (what the plugin wrote from DSH's `tool/ptc-dispatch` events; this is the
// point of the check: before the fix the spool holds `run_code` only); (c) after the fold the deny file (if
// one was written) does not contain <used-tool>, bash or run_code and holds only mcp__* names; (d) the deny
// file also does not contain any tool DSH's log shows session 1 dispatched; the core's own proposal
// (`te status --json`) never lists them either; (e) the control session exits 0, and the state directory's
// errors.log has no line mentioning ptc (INFO: how many lines it has).
// INFO (not graded): whether the nested results were errors, the dispatch events of DSH's log, counts.
// Credentials come from the profile's `.env`; provider text goes through redact().
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  arg, dsh as runDsh, fakeGitRepo, jsonl, loadProfileEnv, makeChecker, prepareWork, readSessionEvents,
  redact, requestTools, tail, teCli,
} from './common.mjs';

const USAGE = 'usage: node plugin/dsh/test/live/live-ptc.mjs [--profile headless] [--used-tool <mcp tool>]';
const KNOWN = new Set(['--profile', '--used-tool']);
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (!KNOWN.has(argv[i]) || i + 1 >= argv.length) {
    console.error(`unknown or incomplete argument: ${argv[i]}\n${USAGE}`);
    process.exit(2);
  }
  i += 1;                                               // every flag takes a value
}
const profile = arg('--profile', 'headless');
const usedTool = arg('--used-tool', 'mcp__postgres__postgres_mcp_list_connection_profiles');
if (!usedTool.startsWith('mcp__')) {
  console.error(`invalid argument value (--used-tool must be an mcp__* name)\n${USAGE}`);
  process.exit(2);
}
const { check, info, summary } = makeChecker();

loadProfileEnv(profile);
const { work, pkg, entry } = prepareWork('te-dsh-live-ptc');
const repo = fakeGitRepo(join(work, 'repo'));
const state = join(work, 'state');
// One overlay: the plugin (real core: no bootstrap in its config) and the PTC switch of the tools entry.
const patch = join(work, 'ptc.patch.yml');
writeFileSync(patch, [
  '- insert:',
  '    - id: te-live',
  `      name: ${JSON.stringify(entry)}`,
  '- id: tools',
  "  name: '@deepseek-ai/dsh-tools'",
  '  config:',
  '    mode: ptc',
  '',
].join('\n'));
const env = {
  TOKENECONOMIZER_HOME: state, CLAUDE_CONFIG_DIR: join(work, 'claude'), TE_FOLD_SYNC: '1',
  TE_TOOLPRUNE: 'auto', TE_TOOLPRUNE_EVIDENCE: '1', TE_TOOLPRUNE_MIN_SESSIONS: '1',
  TE_TOOLPRUNE_SESSIONS: '2', TE_TOOLPRUNE_QUIET_MINUTES: '0',
};
const localFile = join(repo, '.dsh', 'token-economizer.local.json');
const spoolDir = join(state, 'dsh-sessions');
const errorsLog = join(state, 'errors.log');
const spools = () => (existsSync(spoolDir) ? readdirSync(spoolDir).filter((n) => n.endsWith('.jsonl')) : []);
const readDeny = () => {
  try { return JSON.parse(readFileSync(localFile, 'utf8'))?.tokeneconomizer?.deny; } catch { return undefined; }
};
const readList = (f) => {
  try { return JSON.parse(readFileSync(f, 'utf8')).tools ?? []; } catch { return []; }
};
const errorLines = () => (existsSync(errorsLog) ? readFileSync(errorsLog, 'utf8').split('\n').filter(Boolean) : []);

/** One headless session; returns its exit code and the id of the new spool (newest by mtime). */
function session(label, prompt) {
  const before = new Set(spools());
  const t0 = Date.now();
  const r = runDsh(work, ['--profile', profile, '--patch', patch, prompt], env, 300_000, repo);
  const created = spools().filter((n) => !before.has(n))
    .sort((a, b) => statSync(join(spoolDir, b)).mtimeMs - statSync(join(spoolDir, a)).mtimeMs);
  const id = created[0]?.replace(/\.jsonl$/, '');
  console.log(`[${label}] exit ${r.status}, ${((Date.now() - t0) / 1000).toFixed(1)} s, spool ${id ?? 'none'}${created.length > 1 ? ` (+${created.length - 1} more)` : ''}`);
  check(`${label}: the headless run exited 0`, r.status === 0, `exit ${r.status}`);
  if (r.status !== 0) console.log(redact(tail(r.stderr)));
  return { id, status: r.status };
}

/** The spool's tool calls (names as the core sees them) and DSH's own log: what the model ran and what was dispatched. */
function toolUse(id) {
  const rows = id ? jsonl(join(spoolDir, `${id}.jsonl`)) : [];
  const calls = rows.flatMap((r) => (Array.isArray(r.message?.content) ? r.message.content : [])).filter((b) => b?.type === 'toolCall');
  const results = rows.filter((r) => r.message?.role === 'toolResult');
  const isError = new Map(results.map((r) => [r.message.toolCallId, r.message.isError === true]));
  const events = readSessionEvents(id);
  return {
    used: calls.map((c) => c.name),
    calls,
    isError,
    modelCalls: events.filter((e) => e.type === 'tool/call').map((e) => e.data?.name),
    dispatched: events.filter((e) => e.type === 'tool/ptc-dispatch').map((e) => ({ name: e.data?.name, id: e.data?.subCallId, isError: e.data?.isError === true })),
  };
}

const prompt = (n) => `Make ONE \`run_code\` call whose code calls, from the code, both \`tools.${usedTool}({})\` (it is read-only) and \`tools.bash({description: "echo", command: "echo te-live-ptc-${n}"})\`, and returns both results; use no other tool, then reply done`;

// -- sessions 1 and 2, then the control session -----------------------------------------------------
const s1 = session('session 1', prompt(1));
const catalog1 = readList(join(state, 'hosts', 'dsh', 'catalog.json'));
const deny1 = readDeny();
const u1 = toolUse(s1.id);
const tools1 = s1.id ? requestTools(s1.id) : undefined;
const dispatched1 = [...new Set(u1.dispatched.map((d) => d.name).filter((n) => typeof n === 'string'))];
console.log(`session 1 model calls (DSH log): ${u1.modelCalls.join(', ') || 'none'}`);
console.log(`session 1 dispatched (DSH log tool/ptc-dispatch): ${u1.dispatched.map((d) => `${d.name}${d.isError ? '(error)' : ''}`).join(', ') || 'none'}`);
console.log(`session 1 spool calls: ${u1.used.join(', ') || 'none'}`);

// (a) PTC is in place: the model sees run_code only
check('(a) session 1\'s first request has exactly the tools [run_code]', Array.isArray(tools1) && tools1.length === 1 && tools1[0] === 'run_code',
  `${tools1?.length ?? 'no'} tools: ${(tools1 ?? []).slice(0, 8).join(', ')}`);
if (Array.isArray(tools1) && tools1.length !== 1) console.log(`INFO  the request has ${tools1.length} tools (${tools1.filter((n) => n.startsWith('mcp__')).length} mcp__*), not 1: PTC may not have taken effect`);
info('the model called run_code (DSH log)', u1.modelCalls.includes('run_code'));
check(`the model reached ${usedTool} and bash from code (DSH log: tool/ptc-dispatch)`, dispatched1.includes(usedTool) && dispatched1.includes('bash'),
  `dispatched: ${dispatched1.join(', ') || 'none'}`);
info(`the nested ${usedTool} result is not an error`, u1.dispatched.some((d) => d.name === usedTool && !d.isError));

// (b) the spool: the nested calls next to run_code (the point: before the fix only run_code is there)
check('(b) the spool of session 1 keeps the run_code block', u1.used.includes('run_code'), `calls: ${u1.used.join(', ') || 'none'}`);
check(`(b) the spool of session 1 holds a toolCall block for the nested ${usedTool}`, u1.used.includes(usedTool), `calls: ${u1.used.join(', ') || 'none'}`);
check('(b) the spool of session 1 holds a toolCall block for the nested bash', u1.used.includes('bash'), `calls: ${u1.used.join(', ') || 'none'}`);
const nestedIds = u1.calls.filter((c) => c.name !== 'run_code').map((c) => c.id);
check('(b) the nested blocks have unique ids and a result row each', new Set(nestedIds).size === nestedIds.length && nestedIds.length > 0 && nestedIds.every((i) => u1.isError.has(i)),
  `${nestedIds.length} nested block(s), ids ${nestedIds.slice(0, 3).join(', ') || 'none'}`);

// (c), (d) the deny file the core wrote after session 1
const NEVER = [usedTool, 'bash', 'run_code'];
const bad = (list, extra = []) => [...new Set([...NEVER, ...extra])].filter((t) => list.includes(t));
console.log(`catalog ${catalog1.length} tools (${catalog1.filter((t) => t.startsWith('mcp__')).length} mcp__*); deny ${existsSync(localFile) ? (deny1 ?? []).length : 'no file'}`);
if (existsSync(localFile)) {
  const d = Array.isArray(deny1) ? deny1 : [];
  check('(c) `tokeneconomizer.deny` is an array of only mcp__* names', Array.isArray(deny1) && d.every((x) => typeof x === 'string' && x.startsWith('mcp__')),
    `${d.length} names, ${d.filter((x) => !String(x).startsWith('mcp__')).length} non-mcp`);
  check(`(c) deny contains none of ${NEVER.join(', ')}`, bad(d).length === 0, bad(d).join(', ') || 'none of them');
  check(`(d) deny contains none of the tools DSH's log shows session 1 dispatched (${dispatched1.join(', ') || 'none'})`, dispatched1.every((t) => !d.includes(t)),
    dispatched1.filter((t) => d.includes(t)).join(', ') || 'none of them');
} else {
  console.log('INFO  no .dsh/token-economizer.local.json was written: the deny-file checks (c), (d) are skipped; the core\'s own proposal is checked instead');
}

/** The core's own view: `te status --json` -> toolprune {proposal, applied}; nothing in it may name a used tool. */
function proposalChecks(label) {
  const r = teCli(pkg, repo, ['status', '--json'], env);
  let tp;
  try { tp = JSON.parse(r.stdout)?.toolprune; } catch { tp = undefined; }
  check(`${label}: \`te status --json\` answers with a toolprune section`, r.status === 0 && Boolean(tp), `exit ${r.status}${tp ? '' : ` ${redact(tail(r.stderr))}`}`);
  const listed = [...(Array.isArray(tp?.proposal) ? tp.proposal : []), ...(Array.isArray(tp?.applied) ? tp.applied : [])];
  const hit = bad(listed, dispatched1).filter((t) => listed.includes(t));
  check(`${label}: the core's toolprune proposal/applied do not list ${[...new Set([...NEVER, ...dispatched1])].join(', ')}`, Boolean(tp) && hit.length === 0,
    `proposal ${tp?.proposal?.length ?? 'n/a'}, applied ${tp?.applied?.length ?? 'n/a'}, mode ${tp?.mode}, sessions ${tp?.sessions}${hit.length ? `, listed: ${hit.join(', ')}` : ''}`);
}
proposalChecks('after session 1');

const s2 = session('session 2', prompt(2));
const u2 = toolUse(s2.id);
console.log(`session 2 dispatched: ${u2.dispatched.map((d) => d.name).join(', ') || 'none'}; spool calls: ${u2.used.join(', ') || 'none'}`);
info('session 2: the model dispatched the used tool from code', u2.dispatched.some((d) => d.name === usedTool));
if (u2.dispatched.some((d) => d.name === usedTool)) {
  check(`session 2: the spool holds a toolCall block for the nested ${usedTool}`, u2.used.includes(usedTool), `calls: ${u2.used.join(', ') || 'none'}`);
}

const ctrl = session('control', 'Reply with the single word ok');
const crt = ctrl.id ? requestTools(ctrl.id) : undefined;
const denyNow = readDeny() ?? [];
console.log(`counts: catalog ${catalog1.length}, session 1 request ${tools1?.length ?? 'n/a'}, deny ${existsSync(localFile) ? denyNow.length : 'no file'}, control request ${crt?.length ?? 'n/a'}`);
if (existsSync(localFile)) {
  check(`(c) after all sessions deny still has none of ${NEVER.join(', ')} and only mcp__* names`, bad(denyNow, dispatched1).length === 0 && denyNow.every((x) => String(x).startsWith('mcp__')), `${denyNow.length} names`);
}
proposalChecks('after the control session');

// (e) nothing about PTC crashed the plugin or the core
const lines = errorLines();
const ptcLines = lines.filter((l) => /ptc/i.test(l));
console.log(`INFO  errors.log: ${lines.length} line(s), ${ptcLines.length} mentioning ptc`);
if (ptcLines.length) console.log(ptcLines.slice(0, 3).map((l) => `      ${redact(l)}`).join('\n'));
check('(e) the state directory\'s errors.log has no line mentioning ptc', ptcLines.length === 0, `${ptcLines.length} of ${lines.length} line(s)`);

process.exit(summary(work) ? 1 : 0);
