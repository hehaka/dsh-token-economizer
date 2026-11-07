// Spool and PTC (docs/plans/2026-11-07-dsh-brakujace-kontrole-na-zywo.md T4, DoD D4, spike Q4).
//
// With `mode: ptc` on the dsh-tools entry the model sees only `run_code` and calls every other tool from
// code. DSH logs each nested call as `tool/ptc-dispatch-start` and `tool/ptc-dispatch` (name, arguments,
// subCallId '<call>:ptc:N', isError, content) and no `tool/call`/`tool/result` for it; so a spool that
// records only `assistant/message` and `tool/result` holds ONE `toolCall` block, `run_code`, and an MCP tool
// used only through `run_code` looks never-used to the core (which may then propose denying it).
// Desired behaviour: the spool records each completed nested call (`tool/ptc-dispatch`) as a `toolCall`
// block (name = the nested tool, arguments) with a `toolResult` (isError, content) next to the `run_code`
// block, so the core counts the tool as used.
//
// The events below have the shape the spike observed (docs/iterations/1-spike/q4-ptc.out).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPlugin } from '../src/plugin.mjs';
import { Spool } from '../src/spool.mjs';
import { coreView, dshEvents, fakeCtx, fakeRepo, isolatedEnv, readJsonl, rootSession, tmp } from './helpers.mjs';

// sha256 of the spool `dshEvents()` produces (header cwd /w/repo, session s1) with spool.mjs before this change.
const NON_PTC_SHA256 = '3cf626217d57511093d58db153e0dfa6a1a293061aa218929fc98e8e3c5a5e1b';
const MCP = 'mcp__postgres__postgres_mcp_list_connection_profiles';
const RUN = 'toolu_01RunCodeA';
const text = (t) => [{ type: 'text', text: t }];
let seq = 1000;
const ev = (type, data) => ({ type, seq: seq++, time: 0, data });

const usage = { inputTokens: 4, outputTokens: 105, totalTokens: 16209, cacheReadTokens: 2326, cacheWriteTokens: 13774 };
const prompt = (t = 'list the connection profiles and echo done') =>
  ev('user/message', { role: 'user', content: text(t), source: { kind: 'user' }, id: 'u1' });
const runCode = (id = RUN, code = `await tools.${MCP}({}); return await tools.bash({command:'echo done'})`) =>
  ev('assistant/message', {
    turn: 1, step: 1, usage,
    message: { role: 'assistant', content: [{ type: 'tool-call', id, name: 'run_code', arguments: JSON.stringify({ code, description: 'nested calls' }) }], source: { kind: 'model', model: 'claude-haiku-5-5' } },
  });
const runCodeResult = (id = RUN, t = 'done') =>
  ev('tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: id, isError: false, content: text(t), source: { kind: 'tool', callId: id } } });
// What DSH logs for one nested call: the start (no result yet) and the finished dispatch.
const dispatch = (n, name, args, { root = RUN, isError = false, content = 'ok' } = {}) => {
  const base = { rootCallId: root, parentCallId: root, subCallId: `${root}:ptc:${n}`, name, arguments: args };
  return [
    ev('tool/ptc-dispatch-start', base),
    ev('tool/ptc-dispatch', { ...base, isError, content: text(content), meta: { cwd: '/w/repo' } }),
  ];
};

/** A PTC session: one prompt, one `run_code` that dispatches an MCP tool and bash, the outer result. */
const ptcSession = () => [
  prompt(),
  runCode(),
  ...dispatch(1, MCP, {}, { content: '{"profiles":[]}' }),
  ...dispatch(2, 'bash', { description: 'echo', command: 'echo done' }, { content: 'done\n' }),
  runCodeResult(),
];

function spoolOf(dir, events) {
  const path = join(dir, 'dsh-sessions', 's1.jsonl');
  const sp = new Spool(path, { sessionId: 's1', cwd: '/w/repo' });
  const returned = events.map((e) => sp.record(e));
  return { path, sp, returned, rows: readJsonl(path) };
}
const blocks = (rows) => rows.flatMap((r) => (Array.isArray(r.message?.content) ? r.message.content : []));
const calls = (rows) => blocks(rows).filter((b) => b.type === 'toolCall');
const results = (rows) => rows.filter((r) => r.message?.role === 'toolResult').map((r) => r.message);

test('each nested call of a run_code session is recorded as a toolCall block named after the nested tool', () => {
  const { rows } = spoolOf(tmp(), ptcSession());
  const nested = calls(rows).filter((b) => b.name !== 'run_code');
  assert.deepEqual(nested.map((b) => b.name), [MCP, 'bash'], 'the MCP tool and bash, once each (start events are not calls)');
  assert.deepEqual(nested[0].arguments, {});
  assert.deepEqual(nested[1].arguments, { description: 'echo', command: 'echo done' });
  const mcpResult = results(rows).find((m) => m.toolCallId === nested[0].id);
  const bashResult = results(rows).find((m) => m.toolCallId === nested[1].id);
  assert.ok(mcpResult, 'the MCP call has a toolResult');
  assert.equal(mcpResult.isError, false);
  assert.equal(mcpResult.content[0].text, '{"profiles":[]}');
  assert.equal(bashResult?.content[0].text, 'done\n');
});

test('the run_code block and its result stay, and the nested calls sit between them', () => {
  const { rows } = spoolOf(tmp(), ptcSession());
  const all = calls(rows);
  assert.deepEqual(all.map((b) => b.name), ['run_code', MCP, 'bash'], 'run_code first, then what it dispatched');
  const run = all[0];
  assert.equal(run.id, RUN);
  assert.match(run.arguments.code, /tools\.bash/);
  const order = rows.filter((r) => r.type === 'message').map((r) => r.message.role === 'toolResult' ? `result:${r.message.toolCallId}` : r.message.role);
  const runResultAt = order.indexOf(`result:${RUN}`);
  assert.ok(runResultAt > 0, 'run_code keeps its own toolResult');
  for (const b of all.slice(1)) {
    assert.ok(order.indexOf(`result:${b.id}`) > -1, `${b.name} has a result row`);
    assert.ok(order.indexOf(`result:${b.id}`) < runResultAt, `${b.name}'s result precedes the outer run_code result`);
  }
});

test('a nested call that failed is recorded with isError', () => {
  const failing = [
    prompt(), runCode(),
    ...dispatch(1, MCP, {}, { isError: true, content: 'connection refused' }),
    ...dispatch(2, 'bash', { command: 'true' }, { content: '' }),
    runCodeResult(),
  ];
  const { rows } = spoolOf(tmp(), failing);
  const nested = calls(rows).filter((b) => b.name !== 'run_code');
  assert.deepEqual(nested.map((b) => b.name), [MCP, 'bash'], 'a failed call is still a call of that tool');
  const failed = results(rows).find((m) => m.toolCallId === nested[0].id);
  assert.equal(failed?.isError, true);
  assert.equal(failed?.content[0].text, 'connection refused');
  assert.equal(results(rows).find((m) => m.toolCallId === nested[1].id)?.isError, false);
});

test('a dispatch without a name or with a malformed payload is ignored without throwing', () => {
  const good = dispatch(3, 'bash', { command: 'echo after' }, { content: 'after' });
  const bad = [
    ev('tool/ptc-dispatch', { rootCallId: RUN, subCallId: `${RUN}:ptc:1`, arguments: {}, isError: false, content: text('x') }),   // no name
    ev('tool/ptc-dispatch', { rootCallId: RUN, subCallId: `${RUN}:ptc:1`, name: '', isError: false, content: text('x') }),        // empty name
    ev('tool/ptc-dispatch', { rootCallId: RUN, subCallId: `${RUN}:ptc:1`, name: 42, arguments: {}, content: text('x') }),         // name not a string
    ev('tool/ptc-dispatch', { name: 'bash' }),                                                                                       // no subCallId, no content (kept or not, never fatal)
    ev('tool/ptc-dispatch', 'not an object'),
    ev('tool/ptc-dispatch', null),
    ev('tool/ptc-dispatch', []),
    ev('tool/ptc-dispatch', { rootCallId: RUN, subCallId: `${RUN}:ptc:9`, name: 'bash', arguments: { command: 'x' }, isError: 'maybe', content: { not: 'an array' } }),
    { type: 'tool/ptc-dispatch' },                                                                                                   // no data at all
  ];
  let rows;
  assert.doesNotThrow(() => { ({ rows } = spoolOf(tmp(), [prompt(), runCode(), ...bad, ...good, runCodeResult()])); });
  const nested = calls(rows).filter((b) => b.name !== 'run_code');
  const named = nested.map((b) => b.name);
  assert.ok(named.includes('bash'), 'the one valid dispatch (ptc:3) is recorded');
  assert.ok(nested.some((b) => b.id === `${RUN}:ptc:3`), 'by its subCallId');
  assert.ok(nested.every((b) => typeof b.name === 'string' && b.name !== ''), 'no block without a usable name');
  assert.ok(!nested.some((b) => b.id === `${RUN}:ptc:1`), 'a dispatch without a name is not recorded');
  assert.equal(new Set(nested.map((b) => b.id)).size, nested.length, 'ids stay unique whatever else was kept');
});

test('a non-PTC session spool is byte-identical to what the spool wrote before (regression guard)', () => {
  const { path } = spoolOf(tmp(), dshEvents());
  const bytes = readFileSync(path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), NON_PTC_SHA256);
  assert.equal(readJsonl(path).length, 8, 'header + 1 prompt + 3 calls + 3 results');
  assert.ok(!calls(readJsonl(path)).some((b) => b.name === 'run_code'));
});

test('ids of nested blocks are unique, derived from the call, and the same after a resume', () => {
  const second = 'toolu_01RunCodeB';
  const events = [
    prompt(), runCode(), ...dispatch(1, MCP, {}), ...dispatch(2, 'bash', { command: 'a' }), runCodeResult(),
    runCode(second), ...dispatch(1, 'bash', { command: 'b' }, { root: second }), runCodeResult(second),   // ':ptc:1' again, under another call
  ];
  const dirA = tmp();
  const whole = spoolOf(dirA, events);
  // the same events, but the process stops after the first run_code and a new Spool resumes the file
  const dirB = tmp();
  const path = join(dirB, 'dsh-sessions', 's1.jsonl');
  const cut = events.indexOf(events.find((e) => e.type === 'tool/result'));
  const first = new Spool(path, { sessionId: 's1', cwd: '/w/repo' });
  events.slice(0, cut + 1).forEach((e) => first.record(e));
  const resumed = new Spool(path, { sessionId: 's1', cwd: '/w/repo' });
  events.slice(cut + 1).forEach((e) => resumed.record(e));
  const rowsB = readJsonl(path);

  for (const rows of [whole.rows, rowsB]) {
    const ids = rows.filter((r) => r.id).map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, 'row ids are unique');
    const callIds = calls(rows).map((b) => b.id);
    assert.equal(new Set(callIds).size, callIds.length, 'toolCall ids are unique (the same ptc index under another call included)');
    assert.deepEqual(callIds.filter((i) => i.includes(':ptc:')), [`${RUN}:ptc:1`, `${RUN}:ptc:2`, `${second}:ptc:1`], 'nested ids are the subCallIds');
    const resultIds = results(rows).map((m) => m.toolCallId);
    assert.ok(callIds.every((i) => resultIds.includes(i)), 'every call has a result');
  }
  assert.deepEqual(calls(rowsB).map((b) => [b.id, b.name]), calls(whole.rows).map((b) => [b.id, b.name]), 'a resumed spool records the same calls as an uninterrupted one');
  assert.equal(rowsB.filter((r) => r.type === 'session').length, 1);
});

test("the core's own reader counts the nested tools as used, without extra prompts or requests", () => {
  const dir = tmp();
  const { path } = spoolOf(dir, ptcSession());
  const view = coreView(path, dir);
  assert.equal(view.calls, 3, 'run_code, the MCP tool and bash');
  assert.deepEqual(view.traj.map((t) => t[1]), [true, true, true], "success flags: every call here succeeded");
  assert.ok(view.traj.some((t) => String(t[0]).toLowerCase().includes('list_connection_profiles') || String(t[0]).includes(MCP)), `the MCP tool is in the trajectory: ${JSON.stringify(view.traj)}`);
  assert.equal(view.prompts, 1);
  assert.equal(view.usage.requests, 1, 'nested calls are not model requests');
  assert.equal(view.usage.output_tokens, 105, 'and add no usage');
});

test('through the plugin, a tool/ptc-dispatch session event reaches the spool', async () => {
  const root = tmp();
  const repo = fakeRepo(root);
  const env = isolatedEnv(root);
  const ctx = fakeCtx();
  const plugin = createPlugin(ctx, { env, closeOnExit: false, run: async () => ({}), sidecall: false });
  const session = rootSession('ptc-1', repo);
  ctx.handlers['session/created'][0](session);
  for (const e of ptcSession()) ctx.handlers['session/event'][0](session, e);
  await plugin.idle();
  const rows = readJsonl(join(env.TOKENECONOMIZER_HOME, 'dsh-sessions', 'ptc-1.jsonl'));
  assert.deepEqual(calls(rows).map((b) => b.name), ['run_code', MCP, 'bash']);
  assert.equal(plugin.states.get('ptc-1').promptN, 1, 'a dispatch is not a prompt');
});
