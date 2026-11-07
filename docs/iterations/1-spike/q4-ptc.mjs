#!/usr/bin/env node
// Q4: PTC mode (the model gets `run_code` and calls tools from code).
//   node docs/iterations/1-spike/q4-ptc.mjs
// Switch: the tool registry's config `mode: ptc` (entry id `tools`, @deepseek-ai/dsh-tools; schema: mode "native" | "ptc", default native),
// set by a --patch overlay `- id: tools / name: '@deepseek-ai/dsh-tools' / config: {mode: ptc}`. The headless profile mounts the node PTC
// runtime (@deepseek-ai/dsh-ptc-runtime-node, entry id ptc-runtime, from dsh-base). The TokenEconomizer plugin runs with the live stub core.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { live } from './lib.mjs';

live.loadProfileEnv('headless');
const { work, pkg, entry } = live.prepareWork('te-spike1-q4');
live.fakeGitRepo(join(work, 'repo'));
const stub = join(pkg, 'test-stub-core.py');
writeFileSync(stub, readFileSync(join(live.HERE, 'stub_core.py')));
const te = join(work, 'te.patch.yml');
writeFileSync(te, `- insert:\n    - id: te-live\n      name: ${JSON.stringify(entry)}\n      config:\n        bootstrap: ${JSON.stringify(stub)}\n`);
const ptc = join(work, 'ptc.patch.yml');
writeFileSync(ptc, "- id: tools\n  name: '@deepseek-ai/dsh-tools'\n  config:\n    mode: ptc\n");
const hooks = join(work, 'hooks.jsonl');
const state = join(work, 'state');
const env = { TOKENECONOMIZER_HOME: state, CLAUDE_CONFIG_DIR: join(work, 'claude'), TE_LIVE_LOG: hooks, TE_LIVE_SIDE: join(work, 'side.jsonl'), TE_FOLD_SYNC: '1' };
const task = 'Use run_code to call the bash tool with the command: echo ptc-ok . Then reply with the single word done';
const r = live.dsh(work, ['--profile', 'headless', '--patch', te, '--patch', ptc, task], env, 240_000);
console.log(`exit ${r.status}; answer ${JSON.stringify((r.stdout || '').trim().slice(-60))}${r.status ? ` stderr: ${live.tail(r.stderr)}` : ''}`);
const sid = live.spoolIds(state)[0];
console.log('session id:', sid);
const ev = live.readSessionEvents(sid);
for (const [i, h] of ev.filter((e) => e.type === 'request/header').entries()) {
  const names = (h.data?.header?.tools ?? []).map((t) => t.name);
  console.log(`request/header #${i + 1} tools (${names.length}): ${names.join(',')}`);
}
const types = [...new Set(ev.map((e) => e.type))];
console.log('log event types:', JSON.stringify(types));
for (const e of ev.filter((x) => /^tool\//.test(x.type))) console.log(`log ${e.type}:`, JSON.stringify(e.data).slice(0, 420));
const spool = readFileSync(join(state, 'dsh-sessions', `${sid}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
console.log('spool toolCall blocks:', JSON.stringify(spool.flatMap((x) => x.message?.content ?? []).filter((b) => b.type === 'toolCall').map((b) => ({ name: b.name, arguments: JSON.stringify(b.arguments).slice(0, 160) }))));
console.log('spool toolResult rows:', spool.filter((x) => x.message?.role === 'toolResult').length);
const posts = readFileSync(hooks, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).payload).filter((p) => p.hook_event_name === 'PostToolUse');
console.log('hook PostToolUse (what the plugin saw at tools/post-execute):', JSON.stringify(posts.map((p) => ({ tool_name: p.tool_name, input: JSON.stringify(p.tool_input).slice(0, 100), isError: p.tool_response?.isError }))));
const cat = JSON.parse(readFileSync(join(state, 'hosts', 'dsh', 'catalog.json'), 'utf8')).tools;
console.log(`hosts/dsh/catalog.json: ${cat.length} tools; run_code: ${cat.includes('run_code')}; bash: ${cat.includes('bash')}; mcp__*: ${cat.filter((n) => n.startsWith('mcp__')).length}`);
console.log('work dir:', work);
