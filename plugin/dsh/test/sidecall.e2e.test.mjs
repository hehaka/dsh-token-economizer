// The DSH plugin's endpoint and the core's Python runner, together: a real server with a fake
// `ctx.llm`, and the core's own `runner_for("dsh", ...)` in a real Python process.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSidecall } from '../src/sidecall.mjs';
import { REPO, tmp } from './helpers.mjs';

const USAGE = { inputTokens: 120, outputTokens: 40, cacheReadTokens: 3000, cacheWriteTokens: 0 };
const PY = `
import json, sys
from tokeneconomizer.plugin import sidecall
class C: paid_model = sys.argv[1]
runner = sidecall.runner_for("dsh", C())
print(json.dumps(runner("is the agent stuck?", "agent")))
`;

function python(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.env.TE_PYTHON || 'python3', ['-c', PY, ...args], { cwd: REPO, env: { ...process.env, PYTHONPATH: REPO, TOKENECONOMIZER_HOME: env.home, ...env.extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

async function server(llm, route) {
  const home = tmp();
  const sc = createSidecall({ llm: () => llm, route: () => route, stateRoot: home, log: () => {} });
  await sc.start();
  return { sc, home };
}

const llmReplying = (chunks, seen) => ({
  async prepareCall(config) {
    seen.config = config;
    return { config, async *stream(options) { seen.options = options; yield* chunks; } };
  },
});

test('the core\'s runner gets text and priced usage from the plugin\'s endpoint, on the session\'s route', async () => {
  const seen = {};
  const llm = llmReplying([{ type: 'text-delta', index: 0, text: '{"stuck": true}' }, { type: 'usage', usage: USAGE }, { type: 'finish', reason: { kind: 'stop' } }], seen);
  const { sc, home } = await server(llm, { provider: 'anthropic', model: 'claude-haiku-5-5' });
  const r = await python([''], { home, extra: { TE_DSH_SIDECALL_FILE: sc.file } });
  await sc.stop();
  assert.equal(r.code, 0, r.err);
  const [text, effective] = JSON.parse(r.out);
  assert.equal(text, '{"stuck": true}');
  assert.ok(effective > 0, `priced: ${effective}`);
  assert.deepEqual([seen.config.provider, seen.config.model], ['anthropic', 'claude-haiku-5-5']);
  assert.deepEqual(seen.options.messages, [{ role: 'user', content: [{ type: 'text', text: 'is the agent stuck?' }] }]);
});

test('paid_model reaches the call as its route', async () => {
  const seen = {};
  const { sc, home } = await server(llmReplying([{ type: 'text-delta', index: 0, text: 'ok' }, { type: 'usage', usage: USAGE }, { type: 'finish', reason: { kind: 'stop' } }], seen), { provider: 'anthropic', model: 'x' });
  const r = await python(['openai/gpt-6-mini'], { home, extra: { TE_DSH_SIDECALL_FILE: sc.file } });
  await sc.stop();
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([seen.config.provider, seen.config.model], ['openai', 'gpt-6-mini']);
});

test('a provider that refuses the account pauses the host\'s side calls and the runner answers nothing', async () => {
  const seen = {};
  const llm = llmReplying([{ type: 'finish', reason: { kind: 'error', failure: { message: 'invalid api key', code: 'AUTHENTICATION', status: 401 } } }], seen);
  const { sc, home } = await server(llm, { provider: 'anthropic', model: 'x' });
  const r = await python([''], { home, extra: { TE_DSH_SIDECALL_FILE: sc.file } });
  await sc.stop();
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), ['', null]);
  const { existsSync, readFileSync } = await import('node:fs');
  const pause = join(home, 'hosts', 'dsh', 'sidecall.json');
  assert.ok(existsSync(pause), 'paused');
  assert.match(readFileSync(pause, 'utf8'), /not signed in/);
});

test('with the plugin gone the runner answers nothing, quickly', async () => {
  const { sc, home } = await server(llmReplying([], {}), { provider: 'a', model: 'b' });
  const file = sc.file;
  const { copyFileSync } = await import('node:fs');
  copyFileSync(file, join(home, 'stale.json'));            // what a killed DSH leaves behind
  await sc.stop();
  const t0 = Date.now();
  const r = await python([''], { home, extra: { TE_DSH_SIDECALL_FILE: join(home, 'stale.json') } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), ['', null]);
  assert.ok(Date.now() - t0 < 10_000);
});
