#!/usr/bin/env node
// Q2: `dsh --profile headless --session-id <id>` (resume) under a different default model.
//   node docs/iterations/1-spike/q2-resume.mjs
// Run 1: new session on the profile default (anthropic/claude-haiku-5-5). Run 2: the SAME session id resumed with an overlay that sets
// agent-default-model to azure-openai-responses/gpt-6-luna. route_probe.mjs logs agent.options, request/context and a side-call per session id.
import { copyFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HERE, live } from './lib.mjs';

live.loadProfileEnv('headless');
const { work, entry } = live.prepareWork('te-spike1-q2');
const repo = live.fakeGitRepo(join(work, 'repo'));
copyFileSync(join(HERE, 'route_probe.mjs'), join(work, 'route_probe.mjs'));
const patch = join(work, 'probe.patch.yml');
writeFileSync(patch, `- insert:\n    - id: te-live\n      name: ${JSON.stringify(entry)}\n    - id: te-route-probe\n      name: ${JSON.stringify(pathToFileURL(join(work, 'route_probe.mjs')).href)}\n`);
const swapped = join(work, 'probe-first.patch.yml');
writeFileSync(swapped, `- insert:\n    - id: te-route-probe\n      name: ${JSON.stringify(pathToFileURL(join(work, 'route_probe.mjs')).href)}\n    - id: te-live\n      name: ${JSON.stringify(entry)}\n`);
const luna = join(work, 'luna.patch.yml');
writeFileSync(luna, '- id: agent-default-model\n  name: "@deepseek-ai/dsh-agent-default-model"\n  config:\n    provider: azure-openai-responses\n    model: gpt-6-luna\n');
const probeLog = join(work, 'probe.jsonl');
const env = (tag) => ({ ...(tag.includes('deferred') ? { TE_PROBE_DEFER: '1' } : {}), TOKENECONOMIZER_HOME: join(work, 'state'), CLAUDE_CONFIG_DIR: join(work, 'claude'), TE_FOLD_SYNC: '1', TE_PROBE_LOG: probeLog, TE_PROBE_TAG: tag });
const sh = (args, tag) => live.dsh(work, ['--profile', 'headless', ...args, 'Reply with the single word ok'], env(tag), 240_000);

const dump = live.dsh(work, ['--profile', 'headless', '--patch', patch, '--patch', luna, '--dump-config'], env('dump'), 60_000);
const m = /agent-default-model[\s\S]{0,400}?model:\s*(\S+)/.exec(dump.stdout);
console.log(`--dump-config with the luna overlay: exit ${dump.status}; agent-default-model model = ${m?.[1]}`);

const r1 = sh(['--patch', patch], 'run1-new');
console.log(`run 1 (new session, profile default): exit ${r1.status}; answer ${JSON.stringify((r1.stdout || '').trim().slice(-30))}`);
const sid = live.spoolIds(join(work, 'state'))[0];
console.log(`session id: ${sid}`);
const r2 = sh(['--patch', patch, '--patch', luna, '--session-id', sid], 'run2-resume-luna');
console.log(`run 2 (resume ${sid} with luna overlay): exit ${r2.status}; answer ${JSON.stringify((r2.stdout || '').trim().slice(-30))}${r2.status ? ` stderr: ${live.tail(r2.stderr)}` : ''}`);
const r3 = sh(['--patch', patch, '--session-id', sid], 'run3-resume-default');
console.log(`run 3 (resume again, profile default): exit ${r3.status}; answer ${JSON.stringify((r3.stdout || '').trim().slice(-30))}${r3.status ? ` stderr: ${live.tail(r3.stderr)}` : ''}`);

const r4 = sh(['--patch', swapped], 'run4-new-probe-plugin-listed-first');
console.log(`run 4 (new session, overlay lists the probe plugin BEFORE the TokenEconomizer plugin): exit ${r4.status}`);
const r5 = sh(['--patch', patch], 'run5-new-deferred-probe');
console.log(`run 5 (new session, probe POSTs 150 ms after agent/created without holding the handler): exit ${r5.status}`);
console.log('--- probe log');
for (const l of readFileSync(probeLog, 'utf8').split('\n').filter(Boolean)) console.log(l);
console.log('--- session log (DSH) of', sid);
const ev = live.readSessionEvents(sid);
console.log('request/context routes in order:', JSON.stringify(ev.filter((e) => e.type === 'request/context').map((e) => `${e.data.provider}/${e.data.model}`)));
console.log('request/header config routes in order:', JSON.stringify(ev.filter((e) => e.type === 'request/header').map((e) => `${e.data?.header?.config?.provider}/${e.data?.header?.config?.model}`)));
console.log('model/selection events:', JSON.stringify(ev.filter((e) => e.type === 'model/selection').map((e) => e.data)));
console.log('agent/created events in the log:', ev.filter((e) => e.type === 'agent/created').length);
console.log('turn/start count:', ev.filter((e) => e.type === 'turn/start').length, 'session event types:', JSON.stringify([...new Set(ev.map((e) => e.type))]));
console.log('spool assistant models:', JSON.stringify(readFileSync(join(work, 'state', 'dsh-sessions', `${sid}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.message?.role === 'assistant').map((r) => r.message.model)));
console.log('work dir:', work);
