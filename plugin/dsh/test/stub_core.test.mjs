import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { HERE, REPO, tmp } from './helpers.mjs';

// The live scripts' stand-in for the core's hook launcher (test/live/stub_core.py). In its runner mode
// (TE_LIVE_RUNNER=1) the DSH plugin's 20 s hook timeout means ONE hook process may run AT MOST ONE
// paid_model variant, claimed atomically, so repeated or concurrent hooks work through the list.
const STUB = join(HERE, 'live', 'stub_core.py');
const PYTHON = process.env.TE_PYTHON || 'python3';
const VARIANTS = ['', 'other/model', 'bare-model'];
const REPLY = {
  text: 'pong',
  usage: { input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 2 },
  model: 'm',
  provider: 'p',
};

/** A loopback stand-in for the plugin's /v1/complete (as Fake in tests/test_dsh_sidecall.py).
 *  `barrier` (n, ms) holds every answer until n requests are in flight, or ms have passed;
 *  `answer` ({ status, doc }) replaces the 200 reply of an authorised call. */
async function fakeEndpoint({ barrier, answer } = {}) {
  const token = 't0k3n';
  const requests = [];
  let inflight = 0;
  let maxInflight = 0;
  let waiters = [];
  const release = () => { const w = waiters; waiters = []; for (const f of w) f(); };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* recorded as null */ }
      requests.push({ method: req.method, path: req.url, auth: req.headers.authorization, body });
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      if (barrier) {
        if (inflight >= barrier.n) release();
        else await new Promise((resolve) => { waiters.push(resolve); setTimeout(resolve, barrier.ms); });
      }
      inflight -= 1;
      const ok = req.method === 'POST' && req.url === '/v1/complete' && req.headers.authorization === `Bearer ${token}`;
      const data = Buffer.from(JSON.stringify(ok ? (answer?.doc ?? REPLY) : { error: 'refused' }));
      res.writeHead(ok ? (answer?.status ?? 200) : 403, { 'Content-Type': 'application/json', 'Content-Length': data.length });
      res.end(data);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    token,
    requests,
    get maxInflight() { return maxInflight; },
    close: () => { release(); server.closeAllConnections?.(); return new Promise((resolve) => server.close(resolve)); },
  };
}

/** A fresh directory with an endpoint file and the paths the stub writes to. */
async function setup(opts) {
  const dir = tmp('te-stubcore-');
  const fake = await fakeEndpoint(opts);
  const endpointFile = join(dir, 'sidecall.1.endpoint.json');
  writeFileSync(endpointFile, JSON.stringify({ port: fake.port, token: fake.token, pid: process.pid }));
  return { dir, fake, endpointFile, side: join(dir, 'side.jsonl'), log: join(dir, 'log.jsonl') };
}

/** Run `stub_core.py hook --host dsh` as the plugin does: the payload on stdin. Never rejects. */
function hook(s, payload, { runner = true, paid = VARIANTS, route = false } = {}) {
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: s.dir,
    TOKENECONOMIZER_HOME: join(s.dir, 'state'),
    TE_LIVE_LOG: s.log,
    TE_LIVE_SIDE: s.side,
    TE_LIVE_REPO: REPO,
    TE_LIVE_PAID: JSON.stringify(paid),
    TE_DSH_SIDECALL_FILE: s.endpointFile,
  };
  if (runner && !route) env.TE_LIVE_RUNNER = '1';
  if (route) env.TE_LIVE_ROUTE = '1';
  return new Promise((resolve) => {
    const child = spawn(PYTHON, [STUB, 'hook', '--host', 'dsh'], { env, cwd: s.dir, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (error) => resolve({ code: null, stdout, stderr: String(error) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

const rows = (s) => (existsSync(s.side) ? readFileSync(s.side, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const variants = (s) => rows(s).map((r) => r.variant);
const sentModels = (s) => s.fake.requests.map((r) => r.body?.model);
const post = { hook_event_name: 'PostToolUse', tool_name: 'bash', session_id: 's1' };
const stop = { hook_event_name: 'Stop', session_id: 's1' };
const end = { hook_event_name: 'SessionEnd', session_id: 's1' };
const start = { hook_event_name: 'SessionStart', session_id: 's1' };

async function withSetup(opts, fn) {
  const s = await setup(opts);
  try { await fn(s); } finally { await s.fake.close(); }
}

test('one PostToolUse process runs one variant: one row, one request', () => withSetup({}, async (s) => {
  const r = await hook(s, post);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(variants(s), [''], 'one hook process, one variant');
  assert.equal(s.fake.requests.length, 1, 'one hook process, one request');
  const [row] = rows(s);
  assert.equal(row.text, 'pong');
  assert.deepEqual(row.reply, REPLY);
  assert.ok(row.effective > 0, 'the runner reports the effective tokens');
  assert.equal(row.error, undefined);
}));

test('successive PostToolUse processes take the variants in order; the request names each paid_model', () => withSetup({}, async (s) => {
  for (let i = 0; i < VARIANTS.length; i += 1) {
    const r = await hook(s, post);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(variants(s), VARIANTS.slice(0, i + 1), `after process ${i + 1}`);
    assert.equal(s.fake.requests.length, i + 1, `requests after process ${i + 1}`);
  }
  assert.deepEqual(sentModels(s), [null, 'other/model', 'bare-model'], 'the body carries paid_model, null for ""');
  for (const req of s.fake.requests) {
    assert.equal(req.method, 'POST');
    assert.equal(req.path, '/v1/complete');
    assert.equal(req.auth, `Bearer ${s.fake.token}`);
  }
  for (const row of rows(s)) {
    assert.deepEqual(Object.keys(row).sort(), ['effective', 'reply', 'text', 'variant']);
    assert.equal(row.text, 'pong');
    assert.deepEqual(row.reply, REPLY);
  }
}));

test('once every variant is claimed a further hook process does nothing', () => withSetup({}, async (s) => {
  for (let i = 0; i < VARIANTS.length; i += 1) {
    await hook(s, post);
    assert.deepEqual(variants(s), VARIANTS.slice(0, i + 1), `after process ${i + 1}`);
  }
  const r = await hook(s, post);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(variants(s), VARIANTS, 'a fourth process adds no row');
  assert.equal(s.fake.requests.length, 3, 'a fourth process makes no request');
  assert.match(r.stdout, /TE-LIVE-REDIRECT-91bc/, 'it still answers the PostToolUse note');
}));

test('Stop and SessionEnd claim an unclaimed variant as well; no variant twice', () => withSetup({}, async (s) => {
  await hook(s, stop);
  assert.deepEqual(variants(s), [''], 'Stop claims the first variant');
  await hook(s, end);
  assert.deepEqual(variants(s), ['', 'other/model'], 'SessionEnd claims the next');
  await hook(s, post);
  assert.deepEqual(variants(s), VARIANTS, 'PostToolUse takes the last');
  assert.equal(s.fake.requests.length, 3);
  await hook(s, stop);
  await hook(s, end);
  assert.deepEqual(variants(s), VARIANTS, 'nothing is left to claim');
}));

test('concurrent hook processes never run a variant twice, and each runs at most one', () => withSetup({ barrier: { n: 3, ms: 2500 } }, async (s) => {
  const results = await Promise.all([post, stop, post, end].map((p) => hook(s, p)));
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([...variants(s)].sort(), [...VARIANTS].sort(), 'three rows, each variant once');
  assert.equal(s.fake.requests.length, 3, 'three requests');
  assert.deepEqual([...sentModels(s)].map((m) => m ?? '').sort(), [...VARIANTS].sort(), 'each paid_model sent once');
  // the endpoint holds each answer until all three requests are in flight: that only happens when the
  // variants run in different hook processes at once, not serially inside one
  assert.equal(s.fake.maxInflight, 3, 'the three variants ran in three processes at the same time');
}));

test('SessionStart never runs a variant and still answers the facts text', () => withSetup({}, async (s) => {
  const r = await hook(s, start);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'TE-LIVE-FACTS-7f3a' } });
  assert.deepEqual(rows(s), [], 'SessionStart writes no row');
  assert.equal(s.fake.requests.length, 0, 'SessionStart makes no request');
  // it claimed nothing: the next PostToolUse process gets the first variant, and only that one
  await hook(s, post);
  assert.deepEqual(variants(s), [''], 'the first variant is still unclaimed after SessionStart');
  assert.equal(s.fake.requests.length, 1);
  const logged = readFileSync(s.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(logged.map((l) => l.payload.hook_event_name), ['SessionStart', 'PostToolUse'], 'every payload is still logged');
  assert.deepEqual(logged[0].argv, ['hook', '--host', 'dsh']);
}));

test('without TE_LIVE_RUNNER the raw side call is unchanged: one row, endpoint_env and reply, no variant', () => withSetup({}, async (s) => {
  const r = await hook(s, post, { runner: false });
  assert.equal(r.code, 0, r.stderr);
  const got = rows(s);
  assert.equal(got.length, 1);
  assert.deepEqual(Object.keys(got[0]).sort(), ['endpoint_env', 'reply']);
  assert.equal('variant' in got[0], false);
  assert.equal(got[0].endpoint_env, true);
  assert.deepEqual(got[0].reply, REPLY);
  assert.equal(s.fake.requests.length, 1);
  assert.equal(s.fake.requests[0].body.prompt, 'Reply with the single word: pong');
}));

// ---- TE_LIVE_ROUTE: the real runner on the session's own route, once per hook name ----------------
const prompt = { hook_event_name: 'UserPromptSubmit', session_id: 's1' };
const phases = (s) => rows(s).map((r) => r.phase);

test('TE_LIVE_ROUTE: one row per hook name (SessionStart, UserPromptSubmit, PostToolUse), a second payload of a name adds none', () => withSetup({}, async (s) => {
  for (const [i, p] of [start, prompt, post].entries()) {
    const r = await hook(s, p, { route: true });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(phases(s), ['SessionStart', 'UserPromptSubmit', 'PostToolUse'].slice(0, i + 1));
    assert.equal(s.fake.requests.length, i + 1);
  }
  for (const p of [start, prompt, post, post]) await hook(s, p, { route: true });
  assert.deepEqual(phases(s), ['SessionStart', 'UserPromptSubmit', 'PostToolUse'], 'no further row');
  assert.equal(s.fake.requests.length, 3, 'no further request');
  for (const row of rows(s)) {
    assert.deepEqual(Object.keys(row).sort(), ['charge', 'effective', 'phase', 'reply', 'text']);
    assert.equal(row.text, 'pong');
    assert.deepEqual(row.reply, REPLY);
    assert.ok(row.effective > 0 && row.charge === row.effective, 'a call that reported its usage is charged that usage');
  }
  for (const req of s.fake.requests) {
    assert.equal(req.body.model, null, 'the session\'s own route: no paid_model');
    assert.equal(req.body.prompt, 'Reply with the single word: pong');
  }
  assert.ok(existsSync(`${s.side}.route.SessionStart`), 'the marker is <TE_LIVE_SIDE>.route.<hook name>');
}));

test('TE_LIVE_ROUTE: other hooks make no call, and the hooks keep answering their notes', () => withSetup({}, async (s) => {
  for (const p of [stop, end]) assert.equal((await hook(s, p, { route: true })).code, 0);
  assert.deepEqual(rows(s), []);
  assert.equal(s.fake.requests.length, 0);
  const r = await hook(s, start, { route: true });
  assert.deepEqual(JSON.parse(r.stdout), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'TE-LIVE-FACTS-7f3a' } });
  const p = await hook(s, post, { route: true });
  assert.match(p.stdout, /TE-LIVE-REDIRECT-91bc/);
}));

test('TE_LIVE_ROUTE: a NO_ROUTE 409 is a row with the error body, nothing charged, and no pause', () => withSetup({ answer: { status: 409, doc: { error: { code: 'NO_ROUTE', message: 'no model route known yet' } } } }, async (s) => {
  const r = await hook(s, start, { route: true });
  assert.equal(r.code, 0, r.stderr);
  const [row] = rows(s);
  assert.equal(row.phase, 'SessionStart');
  assert.equal(row.reply.error.code, 'NO_ROUTE');
  assert.equal(row.text, '');
  assert.equal(row.effective, null);
  assert.equal(row.charge, 0);
  assert.equal(row.error, undefined, 'the runner answered nothing, it did not fail');
  assert.equal(existsSync(join(s.dir, 'state', 'hosts', 'dsh', 'sidecall.json')), false, 'the host\'s side calls are not paused');
  assert.match(readFileSync(join(s.dir, 'state', 'errors.log'), 'utf8'), /sidecall dsh: no reply/);
  // the next hook name still makes its own call
  await hook(s, prompt, { route: true });
  assert.deepEqual(phases(s), ['SessionStart', 'UserPromptSubmit']);
  assert.equal(s.fake.requests.length, 2);
}));

test('TE_LIVE_ROUTE: a plugin that is gone is a row with an error and charge 0, and the hook still exits 0', async () => {
  const s = await setup({});
  await s.fake.close();
  const r = await hook(s, start, { route: true });
  assert.equal(r.code, 0, r.stderr);
  const [row] = rows(s);
  assert.deepEqual([row.phase, row.text, row.charge, row.reply], ['SessionStart', '', 0, null]);
  assert.ok(row.error, 'no reply captured');
});
