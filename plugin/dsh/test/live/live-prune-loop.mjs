#!/usr/bin/env node
// Live check of the whole tool-pruning loop on DSH (docs/dsh/adr/0004, plan task T2 / criterion D1):
// real core, real model, a few tiny `dsh headless` sessions in ONE temp repository.
//
//   node plugin/dsh/test/live/live-prune-loop.mjs [--profile headless] [--sessions 2]
//        [--used-tool mcp__postgres__postgres_mcp_list_connection_profiles]
//        [--proxied-tool mcp__postgres__postgres_mcp_get_server_capabilities]
//
// Flow: `--sessions` sessions (default 2) with the real core (overlay without a bootstrap, as in
// live-check.mjs section 3), then one control session. Env: TE_TOOLPRUNE=auto,
// TE_TOOLPRUNE_EVIDENCE=1, TE_TOOLPRUNE_MIN_SESSIONS=1, TE_TOOLPRUNE_SESSIONS=2,
// TE_TOOLPRUNE_QUIET_MINUTES=0, TE_FOLD_SYNC=1 (the fold finishes before the process exits).
// Session 1 uses <used-tool> directly and, only if `tool_call` is among its tools, also calls
// <proxied-tool> THROUGH `tool_call`; later sessions use <used-tool> once; the control session
// only answers. Checks (graded): every run exits 0; the catalog was recorded; after session 1
// `.dsh/token-economizer.local.json` holds a non-empty `mcp__*`-only deny list without bash,
// the used tool, `tool_call`, `tool_search`; the spool records the used tool (and the proxied
// tool, not `tool_call`, when the proxy was used); deny == catalog mcp__* minus the tools session 1
// used; later sessions keep the list and still call the used tool; the control request has none
// of the denied names, keeps bash and the used tool, and is smaller than the catalog.
// State goes to a temp directory (TOKENECONOMIZER_HOME, CLAUDE_CONFIG_DIR). Credentials come from
// the profile's `.env`; the script never prints them. Provider-supplied text (stderr tail) goes
// through redact().
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  arg, dsh as runDsh, fakeGitRepo, jsonl, loadProfileEnv, makeChecker, overlay as makeOverlay,
  prepareWork, readSessionEvents, redact, requestTools, tail,
} from './common.mjs';

const USAGE = 'usage: node plugin/dsh/test/live/live-prune-loop.mjs [--profile headless] [--sessions 2] [--used-tool <mcp tool>] [--proxied-tool <mcp tool>]';
const KNOWN = new Set(['--profile', '--sessions', '--used-tool', '--proxied-tool']);
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (!KNOWN.has(argv[i]) || i + 1 >= argv.length) {
    console.error(`unknown or incomplete argument: ${argv[i]}\n${USAGE}`);
    process.exit(2);
  }
  i += 1;                                               // every flag takes a value
}
const profile = arg('--profile', 'headless');
const sessions = Number(arg('--sessions', '2'));
const usedTool = arg('--used-tool', 'mcp__postgres__postgres_mcp_list_connection_profiles');
const proxiedTool = arg('--proxied-tool', 'mcp__postgres__postgres_mcp_get_server_capabilities');
if (!Number.isInteger(sessions) || sessions < 1 || sessions > 10 || !usedTool.startsWith('mcp__') || !proxiedTool.startsWith('mcp__')) {
  console.error(`invalid argument value (--sessions 1..10; the tools must be mcp__* names)\n${USAGE}`);
  process.exit(2);
}
const { check, info, summary } = makeChecker();

loadProfileEnv(profile);
const { work, entry } = prepareWork('te-dsh-live-prune');   // under os.tmpdir() (on macOS /var/folders/..., not /tmp)
const repo = fakeGitRepo(join(work, 'repo'));
const state = join(work, 'state');
const patch = makeOverlay(work, entry, 'real', {});
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
const readCatalog = () => {
  try { return JSON.parse(readFileSync(join(state, 'hosts', 'dsh', 'catalog.json'), 'utf8')).tools ?? []; } catch { return []; }
};
const sameSet = (a, b) => a.length === b.length && new Set(a).size === new Set(b).size && a.every((x) => b.includes(x));

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

/** What a session's spool and DSH log say about its tool use. */
function toolUse(id) {
  const rows = id ? jsonl(join(spoolDir, `${id}.jsonl`)) : [];
  const blocks = rows.flatMap((r) => (Array.isArray(r.message?.content) ? r.message.content : []));
  const calls = blocks.filter((b) => b?.type === 'toolCall');
  const results = new Map(rows.filter((r) => r.message?.role === 'toolResult').map((r) => [r.message.toolCallId, r.message.isError === true]));
  const used = calls.map((c) => c.name);
  const ok = (name) => calls.some((c) => c.name === name && results.has(c.id) && results.get(c.id) === false);
  // The raw calls the model made (DSH's own log): a proxy call names `tool_call` here, unlike the spool.
  const raw = readSessionEvents(id).filter((e) => e.type === 'tool/call').map((e) => {
    let a = e.data?.arguments;
    try { a = typeof a === 'string' ? JSON.parse(a) : a; } catch { a = {}; }
    return { name: e.data?.name, arg: a?.name };
  });
  return { used, ok, raw };
}

const bashSuffix = (n) => `then run bash \`echo te-live-prune-${n}\` and reply done`;
const prompts = [
  `Use the tool ${usedTool} once directly (it is read-only). If a tool named \`tool_call\` is available to you, also invoke ${proxiedTool} `
    + `THROUGH the \`tool_call\` tool (arguments: name=${proxiedTool}, arguments={}); ${bashSuffix(1)}`,
  ...Array.from({ length: sessions - 1 }, (_, i) => `Use the tool ${usedTool} once (it is read-only), ${bashSuffix(i + 2)}`),
];

// -- sessions with the real core ---------------------------------------------------------------
const runs = [];
let deny1; let catalog1 = []; let use1; let tools1;
for (let n = 1; n <= sessions; n += 1) {
  const s = session(`session ${n}`, prompts[n - 1]);
  runs.push(s);
  if (n === 1) {
    // Snapshot right after session 1: the deny list must exist now (TE_FOLD_SYNC=1) and come from this catalog.
    catalog1 = readCatalog();
    deny1 = readDeny();
    use1 = toolUse(s.id);
    tools1 = s.id ? requestTools(s.id) : undefined;
    check('the plugin recorded the tool catalog (hosts/dsh/catalog.json, > 5 tools)', catalog1.length > 5, `${catalog1.length} tools, ${catalog1.filter((t) => t.startsWith('mcp__')).length} mcp__*`);
    check('after session 1 `.dsh/token-economizer.local.json` exists', existsSync(localFile), localFile.replace(work, '<work>'));
    const arr = Array.isArray(deny1) && deny1.length > 0;
    check('`tokeneconomizer.deny` is a non-empty array of only mcp__* names (the MCP-only guard)', arr && deny1.every((t) => typeof t === 'string' && t.startsWith('mcp__')),
      arr ? `${deny1.length} names, ${deny1.filter((t) => !String(t).startsWith('mcp__')).length} non-mcp` : 'missing or empty');
    const d = deny1 ?? [];
    check(`deny contains neither bash, ${usedTool}, tool_call nor tool_search`,
      !['bash', usedTool, 'tool_call', 'tool_search'].some((t) => d.includes(t)),
      ['bash', usedTool, 'tool_call', 'tool_search'].filter((t) => d.includes(t)).join(', ') || 'none of them');
  }
}

// -- session 1: what the spool recorded; the proxy variant ---------------------------------------
check(`the spool of session 1 recorded ${usedTool} by its own name`, use1.used.includes(usedTool), `calls: ${use1.used.join(', ') || 'none'}`);
const proxyAvailable = Boolean(tools1?.includes('tool_call'));
const rawProxy = use1.raw.filter((c) => c.name === 'tool_call' && c.arg === proxiedTool);
const proxyUsed = rawProxy.length > 0;
console.log(`session 1 raw calls: ${use1.raw.map((c) => (c.name === 'tool_call' ? `tool_call(${c.arg})` : c.name)).join(', ') || 'none'}`);
if (proxyAvailable && proxyUsed) {
  check(`the spool recorded ${proxiedTool} (not tool_call) for the proxied call`, use1.used.includes(proxiedTool) && !use1.used.includes('tool_call'), `calls: ${use1.used.join(', ')}`);
  check(`${proxiedTool} is not in deny`, !(deny1 ?? []).includes(proxiedTool));
} else {
  console.log(`INFO  proxy not exercised (tool_call ${proxyAvailable ? 'available but the model did not use it for the proxied tool' : 'not among the session\'s request tools'}); proxy checks skipped`);
}
info('the model called the proxied tool through tool_call', proxyUsed);
info('the model called the proxied tool directly', use1.raw.some((c) => c.name === proxiedTool));

// -- deny = catalog mcp__* minus session 1's used tools -----------------------------------------
const expected = catalog1.filter((t) => t.startsWith('mcp__') && !use1.used.includes(t));
const missing = expected.filter((t) => !(deny1 ?? []).includes(t));
const extra = (deny1 ?? []).filter((t) => !expected.includes(t));
check('deny equals (catalog mcp__* names) minus (tools session 1 used)', Array.isArray(deny1) && missing.length === 0 && extra.length === 0 && expected.length > 0,
  `deny ${deny1?.length ?? 0}, expected ${expected.length}, missing ${missing.length}, extra ${extra.length}`);

// -- later sessions -----------------------------------------------------------------------------
if (sessions > 1) {
  const denyNow = readDeny();
  check('the deny list is stable across the later sessions (same set)', Array.isArray(denyNow) && Array.isArray(deny1) && sameSet(denyNow, deny1),
    `${deny1?.length ?? 0} -> ${denyNow?.length ?? 'none'} names`);
  for (let n = 2; n <= sessions; n += 1) {
    const id = runs[n - 1].id;
    const rt = id ? requestTools(id) : undefined;
    const u = toolUse(id);
    check(`session ${n}: ${usedTool} is in the request tools and was called successfully`, Boolean(rt?.includes(usedTool)) && u.ok(usedTool),
      `${rt?.length ?? 'no'} request tools, calls: ${u.used.join(', ') || 'none'}`);
  }
} else {
  console.log('INFO  only one session requested: the later-session checks were skipped');
}

// -- control session ----------------------------------------------------------------------------
const ctrl = session('control', 'Reply with the single word ok');
const crt = ctrl.id ? requestTools(ctrl.id) : undefined;
const denyFinal = readDeny() ?? deny1 ?? [];
const present = crt ? denyFinal.filter((t) => crt.includes(t)) : [];
check('the control session\'s request tools are readable from the session log', Array.isArray(crt) && crt.length > 0, `${crt?.length ?? 'none'} tools`);
check('the control request contains none of the denied names', Array.isArray(crt) && present.length === 0, `${present.length}/${denyFinal.length} denied names present`);
check(`the control request still contains bash and ${usedTool}`, Boolean(crt?.includes('bash') && crt.includes(usedTool)), `bash ${Boolean(crt?.includes('bash'))}, used ${Boolean(crt?.includes(usedTool))}`);
check('the control request has fewer tools than the catalog', Array.isArray(crt) && crt.length < catalog1.length, `${crt?.length ?? 'none'} vs catalog ${catalog1.length}`);
console.log(`counts: catalog ${catalog1.length} (${catalog1.filter((t) => t.startsWith('mcp__')).length} mcp__*), session 1 request ${tools1?.length ?? 'n/a'}, deny ${denyFinal.length}, control request ${crt?.length ?? 'n/a'} (${(crt ?? []).filter((t) => t.startsWith('mcp__')).length} mcp__*)`);

process.exit(summary(work) ? 1 : 0);
