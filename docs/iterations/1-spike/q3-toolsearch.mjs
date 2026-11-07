#!/usr/bin/env node
// Q3: the dsh-tool-search plugin (tool_search / tool_describe / tool_call bridge) in a headless run.
//   node docs/iterations/1-spike/q3-toolsearch.mjs
// The headless profile does not have the plugin; it is added with a --patch overlay whose entry names the file of the copy installed in the web
// profile (~/.dsh/profiles/web/node_modules/dsh-tool-search/lib/index.js) with config enabled: 'on'. The TokenEconomizer plugin runs with the live
// stub core (hook payloads logged), so PostToolUse's tool_name shows what the plugin saw.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { live } from './lib.mjs';

live.loadProfileEnv('headless');
const { work, pkg, entry } = live.prepareWork('te-spike1-q3');
const repo = live.fakeGitRepo(join(work, 'repo'));
const stub = join(pkg, 'test-stub-core.py');
writeFileSync(stub, readFileSync(join(live.HERE, 'stub_core.py')));
const ts = pathToFileURL(join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'dsh-tool-search', 'lib', 'index.js')).href;
const patch = join(work, 'ts.patch.yml');
writeFileSync(patch, `- insert:\n    - id: tool-search\n      name: ${JSON.stringify(ts)}\n      config:\n        enabled: 'on'\n    - id: te-live\n      name: ${JSON.stringify(entry)}\n      config:\n        bootstrap: ${JSON.stringify(stub)}\n`);
const hooks = join(work, 'hooks.jsonl');
const state = join(work, 'state');
const env = { TOKENECONOMIZER_HOME: state, CLAUDE_CONFIG_DIR: join(work, 'claude'), TE_LIVE_LOG: hooks, TE_LIVE_SIDE: join(work, 'side.jsonl'), TE_FOLD_SYNC: '1' };
const task = 'Use the MCP tool mcp__postgres__postgres_mcp_list_connection_profiles through the tool_call tool, then reply with the single word done';
const r = live.dsh(work, ['--profile', 'headless', '--patch', patch, task], env, 240_000);
console.log(`exit ${r.status}; answer ${JSON.stringify((r.stdout || '').trim().slice(-60))}${r.status ? ` stderr: ${live.tail(r.stderr)}` : ''}`);
const sid = live.spoolIds(state)[0];
console.log('session id:', sid);
const ev = live.readSessionEvents(sid);
const header = ev.filter((e) => e.type === 'request/header');
console.log(`request/header count: ${header.length}`);
for (const [i, h] of header.entries()) {
  const names = (h.data?.header?.tools ?? []).map((t) => t.name);
  console.log(`request/header #${i + 1} tools (${names.length}): ${names.length > 60 ? `${names.slice(0, 60).join(',')},...` : names.join(',')}`);
  console.log(`   mcp__* visible directly: ${names.filter((n) => n.startsWith('mcp__')).length}; bridge present: ${['tool_search', 'tool_describe', 'tool_call'].filter((n) => names.includes(n)).join(',') || 'none'}`);
}
for (const e of ev.filter((x) => x.type === 'tool/call')) console.log('log tool/call:', JSON.stringify(e.data).slice(0, 320));
for (const e of ev.filter((x) => x.type === 'tool/result')) console.log('log tool/result:', JSON.stringify(e.data).slice(0, 220));
console.log('log event types:', JSON.stringify([...new Set(ev.map((e) => e.type))].filter((t) => /tool|ptc|assistant/.test(t))));
// the raw assistant tool-call blocks of the model (what it asked for)
for (const e of ev.filter((x) => x.type === 'assistant/message')) for (const b of e.data?.message?.content ?? []) if (b.type === 'tool-call') console.log('assistant tool-call block:', JSON.stringify({ name: b.name, arguments: String(b.arguments).slice(0, 200) }));
const spool = readFileSync(join(state, 'dsh-sessions', `${sid}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
console.log('spool toolCall blocks:', JSON.stringify(spool.flatMap((x) => x.message?.content ?? []).filter((b) => b.type === 'toolCall').map((b) => ({ name: b.name, arguments: JSON.stringify(b.arguments).slice(0, 80) }))));
const posts = readFileSync(hooks, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).payload).filter((p) => p.hook_event_name === 'PostToolUse');
console.log('hook PostToolUse (what the plugin saw at tools/post-execute):', JSON.stringify(posts.map((p) => ({ tool_name: p.tool_name, input: JSON.stringify(p.tool_input).slice(0, 60), isError: p.tool_response?.isError }))));
const cat = JSON.parse(readFileSync(join(state, 'hosts', 'dsh', 'catalog.json'), 'utf8')).tools;
console.log(`hosts/dsh/catalog.json: ${cat.length} tools; tool_call: ${cat.includes('tool_call')}; tool_search: ${cat.includes('tool_search')}; tool_describe: ${cat.includes('tool_describe')}; mcp__*: ${cat.filter((n) => n.startsWith('mcp__')).length}; has the postgres list tool: ${cat.includes('mcp__postgres__postgres_mcp_list_connection_profiles')}`);
const dir = join(state, 'hosts', 'dsh', 'catalogs');
for (const f of existsSync(dir) ? readdirSync(dir) : []) { const c = JSON.parse(readFileSync(join(dir, f), 'utf8')).tools; console.log(`catalogs/${f}: ${c.length} tools; tool_call: ${c.includes('tool_call')}; tool_search: ${c.includes('tool_search')}; tool_describe: ${c.includes('tool_describe')}`); }
console.log('work dir:', work);
