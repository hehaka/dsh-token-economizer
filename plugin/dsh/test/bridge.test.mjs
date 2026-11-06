import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { findBootstrap, runHook } from '../src/bridge.mjs';
import { BOOTSTRAP, tmp } from './helpers.mjs';

const env = (root) => ({ PATH: process.env.PATH ?? '', TOKENECONOMIZER_HOME: join(root, 'state'), HOME: root });

test('the core launcher is found beside plugin/dsh in a checkout', () => {
  assert.equal(findBootstrap(new URL('../src/bridge.mjs', import.meta.url).href), BOOTSTRAP);
});

test('a hook call answers with the dispatcher\'s JSON object', async () => {
  const root = tmp();
  const out = await runHook({ hook_event_name: 'SessionStart', session_id: 'x', cwd: root }, { env: env(root), bootstrap: BOOTSTRAP, cwd: root });
  assert.equal(typeof out, 'object');
  assert.ok(!Array.isArray(out));
});

test('every failure is "no change"', async () => {
  const root = tmp();
  const slow = join(root, 'slow.py');
  writeFileSync(slow, 'import time\ntime.sleep(10)\n');
  const junk = join(root, 'junk.py');
  writeFileSync(junk, 'print("not json")\n');
  assert.deepEqual(await runHook({}, { env: env(root), bootstrap: null }), {}, 'no launcher');
  assert.deepEqual(await runHook({}, { env: { ...env(root), TE_DISABLE: '1' }, bootstrap: BOOTSTRAP }), {}, 'disabled');
  assert.deepEqual(await runHook({}, { env: { ...env(root), TE_SIDECALL: '1' }, bootstrap: BOOTSTRAP }), {}, 'a side call');
  assert.deepEqual(await runHook({}, { env: { PATH: '', TE_PYTHON: '/nonexistent/python' }, bootstrap: BOOTSTRAP }), {}, 'no Python');
  assert.deepEqual(await runHook({}, { env: env(root), bootstrap: junk }), {}, 'not JSON');
  const t0 = Date.now();
  assert.deepEqual(await runHook({}, { env: env(root), bootstrap: slow, timeoutMs: 300 }), {}, 'timeout');
  assert.ok(Date.now() - t0 < 5000);
});
