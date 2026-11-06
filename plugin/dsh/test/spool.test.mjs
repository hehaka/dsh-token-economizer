import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { RESULT_CAP, Spool, parseArgs, spoolPath, toPiUsage } from '../src/spool.mjs';
import { coreView, dshEvents, readJsonl, tmp } from './helpers.mjs';

function recorded(dir) {
  const path = join(dir, 'dsh-sessions', 's1.jsonl');
  const sp = new Spool(path, { sessionId: 's1', cwd: '/w/repo' });
  const kinds = dshEvents().map((e) => sp.record(e)?.kind ?? null);
  return { path, sp, kinds };
}

test('a prompt is only what a person typed, injected context and other events are not kept', () => {
  const { kinds } = recorded(tmp());
  assert.deepEqual(kinds, [null, 'prompt', 'assistant', 'tool-result', 'assistant', 'tool-result', 'assistant', 'tool-result', null]);
});

test('the spool is a Pi-format session tree with a linked chain', () => {
  const { path } = recorded(tmp());
  const rows = readJsonl(path);
  assert.deepEqual(rows[0], { type: 'session', version: 3, id: 's1', cwd: '/w/repo' });
  rows.slice(1).forEach((r, i) => {
    assert.equal(r.type, 'message');
    assert.equal(r.parentId, i === 0 ? null : rows[i].id);
  });
  const assistant = rows.find((r) => r.message?.role === 'assistant');
  assert.deepEqual(assistant.message.usage, { input: 4, output: 105, cacheRead: 2326, cacheWrite: 13774 });
  assert.equal(assistant.message.model, 'claude-haiku-5-5');
  const call = assistant.message.content.find((b) => b.type === 'toolCall');
  assert.deepEqual(call.arguments, { command: 'pytest -q' }, 'DSH keeps arguments as a JSON string');
  assert.equal(rows.find((r) => r.message?.role === 'toolResult').message.isError, true);
});

test("the core's own readers see the same session DSH logged", () => {
  const dir = tmp();
  const { path } = recorded(dir);
  const view = coreView(path, dir);
  assert.equal(view.calls, 3);
  assert.equal(view.prompts, 1);
  assert.deepEqual(view.traj, [['bash', false], ['bash', true], ['read', true]]);
  const u = view.usage;
  assert.deepEqual([u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens, u.output_tokens, u.requests],
    [12, 6978, 41322, 315, 3]);
  assert.equal(u.model, 'claude-haiku-5-5');
});

test('a resumed session continues the chain without a second header', () => {
  const dir = tmp();
  const { path, sp } = recorded(dir);
  const before = readJsonl(path);
  const again = new Spool(path, { sessionId: 's1', cwd: '/w/repo' });
  again.record(dshEvents()[1]);
  const rows = readJsonl(path);
  assert.equal(rows.length, before.length + 1);
  assert.equal(rows.filter((r) => r.type === 'session').length, 1);
  assert.equal(rows.at(-1).parentId, before.at(-1).id);
  assert.ok(sp);
});

test('arguments and results are parsed and capped', () => {
  assert.deepEqual(parseArgs('{"a":1}'), { a: 1 });
  assert.deepEqual(parseArgs('not json'), { raw: 'not json' });
  assert.deepEqual(parseArgs(undefined), {});
  assert.equal(parseArgs({ content: 'x'.repeat(RESULT_CAP + 5) }).content.length, RESULT_CAP);
  assert.equal(toPiUsage(undefined), undefined);
  assert.deepEqual(toPiUsage({ inputTokens: 1 }), { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test('the spool path is confined to the state directory', () => {
  assert.equal(spoolPath('/s', '../../etc/passwd'), join('/s', 'dsh-sessions', 'passwd.jsonl'));
  assert.equal(spoolPath('/s', 'session-1'), join('/s', 'dsh-sessions', 'session-1.jsonl'));
  assert.ok(readFileSync);
});
