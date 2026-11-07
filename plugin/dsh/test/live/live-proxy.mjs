#!/usr/bin/env node
// Live check of the `tool_call` proxy (dsh-tool-search) against the real core (docs/plans/2026-11-07-
// dsh-brakujace-kontrole-na-zywo.md T3, DoD D3): an MCP tool the model reaches THROUGH `tool_call`
// is in the spool under its own name and never lands in the core's deny list.
//
//   node plugin/dsh/test/live/live-proxy.mjs [--profile headless] [--only proxy|unknown]
//        [--proxied-tool mcp__postgres__postgres_mcp_list_connection_profiles]
//
// One temp git repository, an isolated TOKENECONOMIZER_HOME and the real core with the live-prune-loop
// environment (TE_TOOLPRUNE=auto, EVIDENCE=1, MIN_SESSIONS=1, SESSIONS=2, QUIET_MINUTES=0, TE_FOLD_SYNC=1).
// The `--patch` overlay adds the profile's copy of `dsh-tool-search` (the spike's recipe, docs/iterations/
// 1-spike.md Q3: the headless profile has none; its file URL is taken from the profile directory, falling
// back to the `web` profile's copy; `enabled: 'on'`), so the model sees `tool_search`/`tool_call` and no
// direct `mcp__*` tool (and not `bash`: it is reachable through `tool_call` only).
//   group `proxy`   (default): session 1 and 2 call <proxied-tool> through `tool_call`
//                   (name=<proxied-tool>, arguments={}); session 1 also runs bash; then a control session.
//   group `unknown`: a session calls `tool_call` with name `mcp__nope__nothing` (a tool that does not exist).
// Checks (graded): every run exits 0; the proxy is in place (session 1 request: tool_call and tool_search,
// no direct mcp__*); the model called `tool_call` with name=<proxied-tool> (DSH's log); the spool records
// <proxied-tool> by its own name and NOT `tool_call`; the catalog files hold `tool_call`; if the deny file
// exists, its list has only `mcp__*` names and none of <proxied-tool>, tool_call, tool_search,
// tool_describe, bash; the core's own proposal (`te status --json`, toolprune.proposal/applied) never
// lists them either (this is the check when no deny file was written: everything proxied); the control
// request still has tool_call and tool_search. For the unknown tool: the spool does not record a real tool
// (the name is not in the catalog), the call's result is an error (INFO if not), no deny entry for it.
// INFO (not graded): whether the proxied tool's own result was an error, bash through the proxy, counts.
// Credentials come from the profile's `.env`; provider text goes through redact().
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  arg, dsh as runDsh, fakeGitRepo, jsonl, loadProfileEnv, makeChecker, overlayEntries, prepareWork,
  profilePackageEntry, readSessionEvents, redact, requestTools, tail, teCli,
} from './common.mjs';
import { pathToFileURL } from 'node:url';

const USAGE = 'usage: node plugin/dsh/test/live/live-proxy.mjs [--profile headless] [--only proxy|unknown] [--proxied-tool <mcp tool>]';
const KNOWN = new Set(['--profile', '--only', '--proxied-tool']);
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (!KNOWN.has(argv[i]) || i + 1 >= argv.length) {
    console.error(`unknown or incomplete argument: ${argv[i]}\n${USAGE}`);
    process.exit(2);
  }
  i += 1;                                               // every flag takes a value
}
const profile = arg('--profile', 'headless');
const only = arg('--only', undefined);
const proxied = arg('--proxied-tool', 'mcp__postgres__postgres_mcp_list_connection_profiles');
if ((only !== undefined && !['proxy', 'unknown'].includes(only)) || !proxied.startsWith('mcp__')) {
  console.error(`invalid argument value (--only proxy|unknown; --proxied-tool must be an mcp__* name)\n${USAGE}`);
  process.exit(2);
}
const runProxy = only !== 'unknown';
const runUnknown = only !== 'proxy';
const UNKNOWN = 'mcp__nope__nothing';
const { check, info, summary } = makeChecker();

loadProfileEnv(profile);
const searchEntry = profilePackageEntry('dsh-tool-search', profile, ['web']);
if (!searchEntry) {
  check('the dsh-tool-search plugin is installed (profiles/<profile> or profiles/web, node_modules/dsh-tool-search/lib/index.js)', false, 'not found: nothing to proxy through');
  process.exit(1);
}
const { work, pkg, entry } = prepareWork('te-dsh-live-proxy');
const repo = fakeGitRepo(join(work, 'repo'));
const state = join(work, 'state');
const patch = overlayEntries(work, 'proxy', [
  { id: 'tool-search', name: pathToFileURL(searchEntry).href, config: { enabled: 'on' } },
  { id: 'te-live', name: entry },
]);
const env = {
  TOKENECONOMIZER_HOME: state, CLAUDE_CONFIG_DIR: join(work, 'claude'), TE_FOLD_SYNC: '1',
  TE_TOOLPRUNE: 'auto', TE_TOOLPRUNE_EVIDENCE: '1', TE_TOOLPRUNE_MIN_SESSIONS: '1',
  TE_TOOLPRUNE_SESSIONS: '2', TE_TOOLPRUNE_QUIET_MINUTES: '0',
};
const localFile = join(repo, '.dsh', 'token-economizer.local.json');
const spoolDir = join(state, 'dsh-sessions');
const spools = () => (existsSync(spoolDir) ? readdirSync(spoolDir).filter((n) => n.endsWith('.jsonl')) : []);
const readDeny = () => {
  try { return JSON.parse(readFileSync(localFile, 'utf8'))?.tokeneconomizer?.deny; } catch { return undefined; }
};
const readList = (f) => {
  try { return JSON.parse(readFileSync(f, 'utf8')).tools ?? []; } catch { return []; }
};
// <proxied-tool> is only protected when the `proxy` group used it (a lone `unknown` run never calls it: it may be denied).
const NEVER_DENIED = [...(runProxy ? [proxied] : []), 'tool_call', 'tool_search', 'tool_describe', 'bash'];

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

/** What a session's spool (names as the core sees them) and DSH's own log (what the model asked for) say. */
function toolUse(id) {
  const rows = id ? jsonl(join(spoolDir, `${id}.jsonl`)) : [];
  const calls = rows.flatMap((r) => (Array.isArray(r.message?.content) ? r.message.content : [])).filter((b) => b?.type === 'toolCall');
  const results = rows.filter((r) => r.message?.role === 'toolResult');
  const isError = new Map(results.map((r) => [r.message.toolCallId, r.message.isError === true]));
  const text = new Map(results.map((r) => [r.message.toolCallId, String(r.message.content?.[0]?.text ?? '')]));
  const raw = readSessionEvents(id).filter((e) => e.type === 'tool/call').map((e) => {
    let a = e.data?.arguments;
    try { a = typeof a === 'string' ? JSON.parse(a) : a; } catch { a = {}; }
    return { name: e.data?.name, arg: a?.name };
  });
  return { used: calls.map((c) => c.name), calls, isError, text, raw };
}
const fmtRaw = (u) => u.raw.map((c) => (c.name === 'tool_call' ? `tool_call(${c.arg})` : c.name)).join(', ') || 'none';
const bad = (list) => NEVER_DENIED.filter((t) => list.includes(t));

/** The core's own view: `te status --json` -> toolprune {proposal, applied}; nothing in it may name a proxy/used tool. */
function proposalChecks(label) {
  const r = teCli(pkg, repo, ['status', '--json'], env);
  let tp;
  try { tp = JSON.parse(r.stdout)?.toolprune; } catch { tp = undefined; }
  check(`${label}: \`te status --json\` answers with a toolprune section`, r.status === 0 && Boolean(tp), `exit ${r.status}${tp ? '' : ` ${redact(tail(r.stderr))}`}`);
  const proposal = Array.isArray(tp?.proposal) ? tp.proposal : [];
  const applied = Array.isArray(tp?.applied) ? tp.applied : [];
  const hit = bad([...proposal, ...applied]);
  check(`${label}: the core's toolprune proposal/applied do not list ${NEVER_DENIED.join(', ')}`, Boolean(tp) && hit.length === 0,
    `proposal ${proposal.length}, applied ${applied.length}, mode ${tp?.mode}, sessions ${tp?.sessions}${hit.length ? `, listed: ${hit.join(', ')}` : ''}`);
  return { proposal, applied };
}

let deny1;
let catalog = [];
// -- group proxy ---------------------------------------------------------------------------------
if (runProxy) {
  const t = (n, extra = '') => `Use the tool ${proxied} THROUGH the \`tool_call\` tool (arguments: name=${proxied}, arguments={})${extra}, use no other tool, and reply done`;
  const s1 = session('session 1', t(1, ', then run bash `echo te-live-proxy-1` (if bash is not among your direct tools, also through `tool_call`)'));
  catalog = readList(join(state, 'hosts', 'dsh', 'catalog.json'));
  deny1 = readDeny();
  const u1 = toolUse(s1.id);
  const tools1 = s1.id ? requestTools(s1.id) : undefined;
  console.log(`session 1 raw calls: ${fmtRaw(u1)}`);
  console.log(`session 1 spool calls: ${u1.used.join(', ') || 'none'}`);
  const direct1 = (tools1 ?? []).filter((n) => n.startsWith('mcp__'));
  check('session 1 request: the proxy is in place (tool_call and tool_search, no direct mcp__* tool)',
    Boolean(tools1?.includes('tool_call') && tools1.includes('tool_search')) && direct1.length === 0,
    `${tools1?.length ?? 'no'} tools: ${(tools1 ?? []).slice(0, 8).join(', ')}, direct mcp__* ${direct1.length}`);
  info('bash is a direct tool in session 1', Boolean(tools1?.includes('bash')));
  // (a) the model went through the proxy
  check(`(a) the model called \`tool_call\` with name=${proxied} (DSH's session log)`, u1.raw.some((c) => c.name === 'tool_call' && c.arg === proxied));
  // (b) the spool: own name, not `tool_call`; the call's own result
  check(`(b) the spool of session 1 records ${proxied} by its own name`, u1.used.includes(proxied), `calls: ${u1.used.join(', ') || 'none'}`);
  check('(b) the spool of session 1 does not record `tool_call` as an executed tool', !u1.used.includes('tool_call'), `calls: ${u1.used.join(', ') || 'none'}`);
  const pc = u1.calls.find((c) => c.name === proxied);
  info(`the proxied tool's result is not an error`, pc !== undefined && u1.isError.get(pc.id) === false);
  info('bash through the proxy recorded as `bash`', u1.used.includes('bash'));
  // (d) catalogs
  const cats = (() => { try { return readdirSync(join(state, 'hosts', 'dsh', 'catalogs')).filter((n) => n.endsWith('.json')); } catch { return []; } })();
  check('(d) hosts/dsh/catalog.json contains `tool_call`', catalog.includes('tool_call'), `${catalog.length} tools, ${catalog.filter((t) => t.startsWith('mcp__')).length} mcp__*`);
  check('(d) every hosts/dsh/catalogs/*.json contains `tool_call` (and there is one)', cats.length > 0 && cats.every((f) => readList(join(state, 'hosts', 'dsh', 'catalogs', f)).includes('tool_call')),
    `${cats.length} file(s): ${cats.map((f) => `${f.slice(0, 6)} ${readList(join(state, 'hosts', 'dsh', 'catalogs', f)).length}`).join(', ')}`);
  // (c) the deny file, when the core wrote one
  if (existsSync(localFile)) {
    const d = Array.isArray(deny1) ? deny1 : [];
    check('(c) `tokeneconomizer.deny` is an array of only mcp__* names', Array.isArray(deny1) && d.every((x) => typeof x === 'string' && x.startsWith('mcp__')),
      `${d.length} names, ${d.filter((x) => !String(x).startsWith('mcp__')).length} non-mcp`);
    check(`(c) deny contains none of ${NEVER_DENIED.join(', ')}`, bad(d).length === 0, bad(d).join(', ') || 'none of them');
  } else {
    console.log('INFO  no .dsh/token-economizer.local.json was written (everything went through the proxy, no direct mcp tool seen): the deny-file checks are skipped; the core\'s own proposal is checked instead');
  }
  proposalChecks('after session 1');

  // session 2 and the control session
  const s2 = session('session 2', t(2));
  const u2 = toolUse(s2.id);
  console.log(`session 2 raw calls: ${fmtRaw(u2)}`);
  check(`session 2: the spool records ${proxied} by its own name and not \`tool_call\``, u2.used.includes(proxied) && !u2.used.includes('tool_call'), `calls: ${u2.used.join(', ') || 'none'}`);
  info('session 2: the model called the proxied tool through tool_call', u2.raw.some((c) => c.name === 'tool_call' && c.arg === proxied));
  const ctrl = session('control', 'Reply with the single word ok');
  const crt = ctrl.id ? requestTools(ctrl.id) : undefined;
  check('(e) the control request still has `tool_call` and `tool_search` (the proxy is intact)', Boolean(crt?.includes('tool_call') && crt.includes('tool_search')),
    `${crt?.length ?? 'no'} tools: ${(crt ?? []).slice(0, 8).join(', ')}`);
  const denyNow = readDeny() ?? [];
  console.log(`counts: catalog ${catalog.length} (${catalog.filter((t) => t.startsWith('mcp__')).length} mcp__*), session 1 request ${tools1?.length ?? 'n/a'}, deny ${existsSync(localFile) ? denyNow.length : 'no file'}, control request ${crt?.length ?? 'n/a'} (${(crt ?? []).filter((t) => t.startsWith('mcp__')).length} mcp__*)`);
  if (existsSync(localFile)) check(`(c) after all sessions deny still has none of ${NEVER_DENIED.join(', ')} and only mcp__* names`, bad(denyNow).length === 0 && denyNow.every((x) => String(x).startsWith('mcp__')), `${denyNow.length} names`);
  proposalChecks('after the control session');
}

// -- group unknown -------------------------------------------------------------------------------
// A proxied call to a tool that does not exist: the run must not break, the spool must not record a real
// tool, nothing may be denied for it. (The spool names the call by what it carries, as it does for any
// proxied call; that name is not in the catalog, which is what "not a real tool" means here.)
if (runUnknown) {
  const su = session('unknown', `Call the \`tool_call\` tool once with arguments: name=${UNKNOWN}, arguments={}, and then reply done`);
  const uu = toolUse(su.id);
  const cat = readList(join(state, 'hosts', 'dsh', 'catalog.json'));
  console.log(`unknown raw calls: ${fmtRaw(uu)}; spool calls: ${uu.used.join(', ') || 'none'}`);
  check(`unknown: the model called \`tool_call\` with name=${UNKNOWN}`, uu.raw.some((c) => c.name === 'tool_call' && c.arg === UNKNOWN));
  const real = uu.used.filter((n) => cat.includes(n) && !['tool_call', 'tool_search', 'tool_describe'].includes(n));
  check('unknown: the spool records no real (catalogued) tool for the failed call', real.length === 0 && !uu.used.includes('tool_call'), `recorded: ${uu.used.join(', ') || 'none'}; catalogued: ${real.join(', ') || 'none'}`);
  check(`unknown: ${UNKNOWN} is not in the catalog`, !cat.includes(UNKNOWN), `${cat.length} tools`);
  const uc = uu.calls.find((c) => c.name === UNKNOWN);
  // dsh-tool-search answers a refused name with an envelope {"ok":false,"error":...}; the tool result itself is NOT flagged
  // isError, so the spool shows the phantom tool as a successful call (harmless: not in the catalog, never denied).
  info('unknown: the call\'s result is flagged isError', uc !== undefined && uu.isError.get(uc.id) === true);
  info('unknown: the result carries an {"ok":false} envelope', uc !== undefined && /"ok":\s*false/.test(uu.text.get(uc.id) ?? ''));
  console.log(`unknown result text: ${redact(uu.text.get(uc?.id) ?? 'none')}`);
  const d = readDeny() ?? [];
  check(`unknown: no deny entry for ${UNKNOWN} (and none of ${NEVER_DENIED.join(', ')})`, !d.includes(UNKNOWN) && bad(d).length === 0, existsSync(localFile) ? `${d.length} names` : 'no deny file');
  const { proposal } = proposalChecks('unknown');
  check(`unknown: the core's proposal does not list ${UNKNOWN}`, !proposal.includes(UNKNOWN));
}

process.exit(summary(work) ? 1 : 0);
