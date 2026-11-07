import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPlugin } from '../src/plugin.mjs';
import { ENV_FILE, MAX_BODY_BYTES, MAX_CONCURRENT, SidecallError, complete, createSidecall, endpointPath, ledgerUsage, parseModel, sweep } from '../src/sidecall.mjs';
import { fakeCtx, fakeRepo, isolatedEnv, rootSession, subSession, tmp } from './helpers.mjs';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'sidecall.mjs');
const ROUTE = { provider: 'anthropic', model: 'claude-haiku-5-5' };
const USAGE = { inputTokens: 120, outputTokens: 40, cacheReadTokens: 3000, cacheWriteTokens: 7 };

/** A fake `ctx.llm`: what the model returns is a list of chunks (or a function of the options). */
function fakeLlm({ chunks, reasoning, fail, hold } = {}) {
  const seen = { prepared: [], options: [], controls: undefined, signal: undefined };
  const llm = {
    seen,
    async prepareCall(config, signal, configure) {
      seen.prepared.push(config);
      seen.signal = signal;
      if (fail === 'prepare') throw new Error('no adapter for provider');
      seen.controls = configure?.({ maxTokens: config.maxTokens }, { reasoning });
      return {
        config: { ...config, ...(seen.controls ?? {}) },
        async *stream(options) {
          seen.options.push(options);
          if (hold) await hold(options);
          for (const c of typeof chunks === 'function' ? chunks(options) : chunks ?? [{ type: 'text-delta', index: 0, text: 'ok' }, { type: 'usage', usage: USAGE }, { type: 'finish', reason: { kind: 'stop' } }]) yield c;
        },
      };
    },
  };
  return llm;
}

// ---- the call ---------------------------------------------------------------------------------
test('a bare model keeps the session\'s provider; provider/model names a route', () => {
  assert.deepEqual(parseModel(undefined, ROUTE), ROUTE);
  assert.deepEqual(parseModel('', ROUTE), ROUTE);
  assert.deepEqual(parseModel(null, ROUTE), ROUTE);
  assert.deepEqual(parseModel('claude-haiku-5-5', { provider: 'p', model: 'x' }), { provider: 'p', model: 'claude-haiku-5-5' });
  assert.deepEqual(parseModel('openai/gpt-6-mini', ROUTE), { provider: 'openai', model: 'gpt-6-mini' });
  assert.deepEqual(parseModel('openrouter/anthropic/claude-haiku', ROUTE), { provider: 'openrouter', model: 'anthropic/claude-haiku' });
  assert.equal(parseModel(undefined, undefined), undefined);
  assert.equal(parseModel('just-a-model', undefined), undefined);
  assert.throws(() => parseModel('provider/', ROUTE), SidecallError);
  assert.throws(() => parseModel('/model', ROUTE), SidecallError);
  assert.throws(() => parseModel(5, ROUTE), SidecallError);
});

test('the usage is the ledger\'s fields; DSH\'s input excludes the cache, as the ledger\'s does', () => {
  assert.deepEqual(ledgerUsage(USAGE), { input_tokens: 120, cache_read_input_tokens: 3000, cache_creation_input_tokens: 7, output_tokens: 40 });
  assert.deepEqual(ledgerUsage({ inputTokens: 5 }), { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 });
  for (const bad of [undefined, null, 'x', {}, { inputTokens: NaN }]) assert.equal(ledgerUsage(bad), undefined);
});

test('one call: one attempt, the prompt as the only message, the least reasoning effort, the text and usage back', async () => {
  const llm = fakeLlm({ reasoning: { efforts: [{ id: 'minimal' }, { id: 'high' }] }, chunks: [
    { type: 'block-start', index: 0, blockType: 'text' }, { type: 'reasoning-delta', index: 0, text: 'thinking…' },
    { type: 'text-delta', index: 1, text: '{"stuck": ' }, { type: 'text-delta', index: 1, text: 'true}' },
    { type: 'usage', usage: USAGE }, { type: 'finish', reason: { kind: 'stop' } }] });
  const out = await complete(llm, ROUTE, { prompt: 'is it stuck?' }, new AbortController().signal);
  assert.deepEqual(out, { text: '{"stuck": true}', usage: ledgerUsage(USAGE), model: 'claude-haiku-5-5', provider: 'anthropic' });   // reasoning is not the answer
  assert.deepEqual(llm.seen.prepared, [{ provider: 'anthropic', model: 'claude-haiku-5-5', maxTokens: 1024 }]);
  assert.equal(llm.seen.controls.reasoningEffort, 'minimal');
  const [options] = llm.seen.options;
  assert.deepEqual(options.messages, [{ role: 'user', content: [{ type: 'text', text: 'is it stuck?' }] }]);
  assert.equal(options.sessionId, undefined);                                                                  // no session history, no session identity
  assert.equal(options.tools, undefined);
});

test('a model that offers no reasoning levels is called without one', async () => {
  const llm = fakeLlm({});
  await complete(llm, ROUTE, { prompt: 'q', maxTokens: 64 }, undefined);
  assert.equal(llm.seen.controls.reasoningEffort, undefined);
  assert.equal(llm.seen.prepared[0].maxTokens, 64);
});

test('paid_model replaces the route', async () => {
  const llm = fakeLlm({});
  const out = await complete(llm, ROUTE, { prompt: 'q', model: 'openai/gpt-6-mini' }, undefined);
  assert.deepEqual([llm.seen.prepared[0].provider, llm.seen.prepared[0].model, out.model], ['openai', 'gpt-6-mini', 'gpt-6-mini']);
  assert.equal(out.provider, 'openai');                                                                         // the reply names the provider actually used
  const bare = await complete(fakeLlm({}), ROUTE, { prompt: 'q', model: 'claude-sonnet-5-5' }, undefined);
  assert.deepEqual([bare.provider, bare.model], ['anthropic', 'claude-sonnet-5-5']);                            // a bare model keeps the route's provider
});

const code = async (p) => p.then(() => 'ok', (e) => (e instanceof SidecallError ? e.code : `other:${e}`));

test('every way a call can fail has a code the core can route on', async () => {
  const sig = new AbortController().signal;
  assert.equal(await code(complete(fakeLlm(), undefined, { prompt: 'q' }, sig)), 'NO_ROUTE');
  assert.equal(await code(complete(fakeLlm(), undefined, { prompt: 'q', model: 'bare' }, sig)), 'NO_ROUTE');
  assert.equal(await code(complete(undefined, ROUTE, { prompt: 'q' }, sig)), 'NO_LLM');
  assert.equal(await code(complete({}, ROUTE, { prompt: 'q' }, sig)), 'NO_LLM');
  for (const prompt of [undefined, '', '   ', 5]) assert.equal(await code(complete(fakeLlm(), ROUTE, { prompt }, sig)), 'BAD_REQUEST');
  assert.equal(await code(complete(fakeLlm(), ROUTE, { prompt: 'x'.repeat(400_001) }, sig)), 'TOO_LARGE');
  for (const maxTokens of [0, -1, 1.5, 4097, '5']) assert.equal(await code(complete(fakeLlm(), ROUTE, { prompt: 'q', maxTokens }, sig)), 'BAD_REQUEST');
  assert.equal(await code(complete(fakeLlm({ fail: 'prepare' }), ROUTE, { prompt: 'q' }, sig)), 'MODEL');
  const finish = (failure) => fakeLlm({ chunks: [{ type: 'finish', reason: { kind: 'error', failure } }] });
  assert.equal(await code(complete(finish({ message: 'invalid api key', code: 'AUTHENTICATION', status: 401 }), ROUTE, { prompt: 'q' }, sig)), 'AUTH');
  assert.equal(await code(complete(finish({ message: 'forbidden', code: 'X', status: 403 }), ROUTE, { prompt: 'q' }, sig)), 'AUTH');
  assert.equal(await code(complete(finish({ message: 'slow down', code: 'RATE_LIMIT', status: 429 }), ROUTE, { prompt: 'q' }, sig)), 'MODEL');
  assert.equal(await code(complete(finish({ message: 'down', code: 'NETWORK' }), ROUTE, { prompt: 'q' }, sig)), 'MODEL');
  const ac = new AbortController();
  const slow = fakeLlm({ hold: () => new Promise(() => {}) });
  const pending = code(complete(slow, ROUTE, { prompt: 'q' }, ac.signal));
  await new Promise((r) => setTimeout(r, 20));
  ac.abort();
  assert.equal(await Promise.race([pending, new Promise((r) => setTimeout(() => r('hung'), 1000))]), 'hung');   // see the endpoint test: the timer ends it
});

test('the refusal of the account keeps the provider\'s status and nothing else of the failure', async () => {
  const llm = fakeLlm({ chunks: [{ type: 'finish', reason: { kind: 'error', failure: { message: 'invalid api key sk-SECRET-123', code: 'AUTHENTICATION', status: 401 } } }] });
  await assert.rejects(complete(llm, ROUTE, { prompt: 'q' }, undefined), (e) => e.code === 'AUTH' && e.providerStatus === 401 && e.status === 502);
});

// ---- the endpoint -----------------------------------------------------------------------------
async function endpoint(over = {}) {
  const stateRoot = join(tmp(), 'state');
  const llm = over.llm ?? fakeLlm();
  const sc = createSidecall({ llm: () => llm, route: (session) => (over.routeFor ? over.routeFor(session) : ('route' in over ? over.route : ROUTE)), stateRoot, timeoutMs: over.timeoutMs, log: () => {} });
  await sc.start();
  const post = (body, { token = sc.token, host, path = '/v1/complete', method = 'POST', raw } = {}) =>
    new Promise((resolve, reject) => {
      const data = raw ?? JSON.stringify(body);
      const req = request({ host: '127.0.0.1', port: sc.port, path, method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(host ? { Host: host } : {}) } }, (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (out += d));
        res.on('end', () => resolve({ status: res.statusCode, doc: JSON.parse(out) }));
      });
      req.on('error', reject);
      req.end(data);
    });
  return { sc, llm, post, stateRoot, stop: () => sc.stop() };
}

test('the endpoint answers a call with the text and the usage', async () => {
  const e = await endpoint();
  const r = await e.post({ prompt: 'is it stuck?' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.doc, { text: 'ok', usage: ledgerUsage(USAGE), model: 'claude-haiku-5-5', provider: 'anthropic' });
  await e.stop();
});

test('the endpoint file is owner-only, names the port and the token, and goes with the endpoint', async () => {
  const e = await endpoint();
  const file = endpointPath(e.stateRoot);
  assert.equal(e.sc.file, file);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual([doc.port, doc.token, doc.pid], [e.sc.port, e.sc.token, process.pid]);
  assert.match(doc.token, /^[0-9a-f]{48}$/);
  await e.stop();
  assert.equal(existsSync(file), false);
});

test('a symlink planted at the endpoint path is replaced, never followed: its target is left alone (F2)', async () => {
  const stateRoot = join(tmp(), 'state');
  const victim = join(tmp(), 'victim.txt');
  writeFileSync(victim, 'precious\n');
  chmodSync(victim, 0o644);
  mkdirSync(join(stateRoot, 'hosts', 'dsh'), { recursive: true });
  symlinkSync(victim, endpointPath(stateRoot));
  const sc = createSidecall({ llm: () => fakeLlm(), route: () => ROUTE, stateRoot, log: () => {} });
  const file = await sc.start();
  assert.equal(file, endpointPath(stateRoot));
  assert.equal(readFileSync(victim, 'utf8'), 'precious\n', 'the target was not overwritten');
  assert.equal(statSync(victim).mode & 0o777, 0o644);
  const st = lstatSync(file);
  assert.ok(st.isFile() && !st.isSymbolicLink(), 'a regular file now');
  assert.equal(st.mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).token, sc.token);
  await sc.stop();
});

test('an endpoint directory that is itself a symlink is not written through (F2)', async () => {
  const stateRoot = join(tmp(), 'state');
  const elsewhere = tmp();
  mkdirSync(join(stateRoot, 'hosts'), { recursive: true });
  symlinkSync(elsewhere, join(stateRoot, 'hosts', 'dsh'));
  const lines = [];
  const sc = createSidecall({ llm: () => fakeLlm(), route: () => ROUTE, stateRoot, log: (l, m) => lines.push(m) });
  assert.equal(await sc.start(), undefined, 'not published');
  assert.deepEqual(readdirSync(elsewhere), [], 'nothing was written into the link\'s target');
  assert.ok(lines.some((m) => /not published/.test(m)));
  await sc.stop();
});

test('only a caller with the token, on loopback\'s own host name, gets in', async () => {
  const e = await endpoint();
  assert.equal((await e.post({ prompt: 'q' }, { token: 'wrong' })).status, 401);
  assert.equal((await e.post({ prompt: 'q' }, { token: '' })).status, 401);
  assert.equal((await e.post({ prompt: 'q' }, { token: e.sc.token + 'x' })).status, 401);
  assert.equal((await e.post({ prompt: 'q' }, { host: 'evil.example' })).status, 403);     // DNS rebinding
  assert.equal((await e.post({ prompt: 'q' }, { host: `localhost:${e.sc.port}` })).status, 403);
  assert.equal((await e.post({ prompt: 'q' }, { path: '/other' })).status, 404);
  assert.equal((await e.post({ prompt: 'q' }, { method: 'PUT' })).status, 404);
  assert.deepEqual((await e.post({ prompt: 'q' }, { token: 'wrong' })).doc, { error: { code: 'TE_AUTH', message: 'bad token' } });
  assert.equal(e.llm.seen.prepared.length, 0, 'no model call was made for any of them');
  await e.stop();
});

test('bad requests are refused before any model call', async () => {
  const e = await endpoint();
  assert.equal((await e.post(undefined, { raw: '{ nope' })).doc.error.code, 'BAD_REQUEST');
  assert.equal((await e.post(undefined, { raw: '[]' })).doc.error.code, 'BAD_REQUEST');
  assert.equal((await e.post({})).doc.error.code, 'BAD_REQUEST');
  assert.equal((await e.post({ prompt: 'q', maxTokens: 99999 })).status, 400);
  const huge = await e.post(undefined, { raw: JSON.stringify({ prompt: 'x'.repeat(MAX_BODY_BYTES) }) });
  assert.equal(huge.status, 413);
  assert.equal(e.llm.seen.prepared.length, 0);
  await e.stop();
});

test('a provider failure message that echoes the token or the prompt is scrubbed before it leaves (F5)', async () => {
  const prompt = 'Summarise the repository secret plan: delete all branches tonight';
  const excerpt = prompt.slice(14, 14 + 26);
  const lines = [];
  const stateRoot = join(tmp(), 'state');
  for (const status of [400, 401]) {                                        // a plain failure (MODEL) and a refusal (AUTH)
    let sc;
    const llm = fakeLlm({ chunks: () => [{ type: 'finish', reason: { kind: 'error', failure: { message: `upstream said: bad request ${sc.token} while handling "${prompt}" and also ${excerpt} end`, code: 'X', status } } }] });
    sc = createSidecall({ llm: () => llm, route: () => ROUTE, stateRoot, log: (l, m) => lines.push(m) });
    await sc.start();
    const r = await fetch(`http://127.0.0.1:${sc.port}/v1/complete`, { method: 'POST', headers: { Authorization: `Bearer ${sc.token}` }, body: JSON.stringify({ prompt }) });
    const wire = await r.text();
    const doc = JSON.parse(wire);
    assert.equal(doc.error.code, status === 401 ? 'AUTH' : 'MODEL');
    assert.ok(!wire.includes(sc.token), 'the token is not in the reply');
    assert.ok(!wire.includes(prompt), 'the prompt is not in the reply');
    for (let i = 0; i + 20 <= prompt.length; i += 1) assert.ok(!wire.includes(prompt.slice(i, i + 20)), `a 20-char run of the prompt (${i}) is not in the reply`);
    assert.match(doc.error.message, /^upstream said: bad request /);          // the rest of the message is still there
    await sc.stop();
  }
  assert.ok(!lines.join('\n').includes(prompt));
  // a long message is cut to 300 characters, whatever it says
  const long = fakeLlm({ chunks: [{ type: 'finish', reason: { kind: 'error', failure: { message: 'x'.repeat(5000), status: 500 } } }] });
  const e = await endpoint({ llm: long });
  assert.ok((await e.post({ prompt })).doc.error.message.length <= 300);
  await e.stop();
});

test('a failure comes back as an error document the core maps; the provider\'s refusal is AUTH with its status', async () => {
  const llm = fakeLlm({ chunks: [{ type: 'finish', reason: { kind: 'error', failure: { message: 'invalid api key', code: 'AUTHENTICATION', status: 401 } } }] });
  const e = await endpoint({ llm });
  const r = await e.post({ prompt: 'q' });
  assert.equal(r.status, 502);
  assert.deepEqual(r.doc, { error: { code: 'AUTH', message: 'invalid api key', status: 401 } });
  await e.stop();
  const none = await endpoint({ route: undefined });
  assert.equal((await none.post({ prompt: 'q' })).doc.error.code, 'NO_ROUTE');
  await none.stop();
});

test(`at most ${MAX_CONCURRENT} calls run at once`, async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const e = await endpoint({ llm: fakeLlm({ hold: () => gate }) });
  const running = [e.post({ prompt: 'a' }), e.post({ prompt: 'b' })];
  await new Promise((r) => setTimeout(r, 60));
  const third = await e.post({ prompt: 'c' });
  assert.equal(third.status, 429);
  assert.equal(third.doc.error.code, 'BUSY');
  release();
  assert.deepEqual((await Promise.all(running)).map((r) => r.status), [200, 200]);
  assert.equal((await e.post({ prompt: 'd' })).status, 200, 'a finished call frees its place');
  await e.stop();
});

test('a call that outlives its deadline is cut off with TIMEOUT, and its model call is aborted', async () => {
  const llm = fakeLlm({ hold: (o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted')))) });
  const e = await endpoint({ llm, timeoutMs: 80 });
  const r = await e.post({ prompt: 'q' });
  assert.equal(r.status, 504);
  assert.equal(r.doc.error.code, 'TIMEOUT');
  assert.equal(llm.seen.options[0].signal.aborted, true);
  await e.stop();
});

test('a half-sent request body does not hold a slot past the deadline (F3)', async () => {
  const llm = fakeLlm();
  const e = await endpoint({ llm, timeoutMs: 180 });
  const partial = () => {
    const req = request({ host: '127.0.0.1', port: e.sc.port, path: '/v1/complete', method: 'POST', headers: { Authorization: `Bearer ${e.sc.token}`, 'Content-Type': 'application/json', 'Content-Length': 500 } });
    req.on('error', () => {});
    req.on('response', (res) => res.resume());
    req.write('{"prompt": "never fini');                                  // the rest never comes
    return req;
  };
  const halves = [partial(), partial()];
  try {
    await new Promise((r) => setTimeout(r, 60));
    assert.equal((await e.post({ prompt: 'q' })).status, 429, 'while they hold the slots a third call is refused');
    await new Promise((r) => setTimeout(r, 200));                         // 260 ms in, past the 180 ms deadline
    const r = await e.post({ prompt: 'q' });
    assert.equal(r.status, 200, `not BUSY: ${JSON.stringify(r.doc)}`);
    assert.equal(llm.seen.prepared.length, 1, 'only the real call reached the model');
  } finally {
    for (const h of halves) h.destroy();
    await e.stop();
  }
});

test('the body limit counts bytes, not string length: a chunked 4-byte-emoji body over it is refused (F4)', async () => {
  const llm = fakeLlm();
  const e = await endpoint({ llm });
  const emoji = '\u{1F600}'.repeat(400_000);                              // 1.6 MB as UTF-8, 800 000 UTF-16 units
  const body = Buffer.from(JSON.stringify({ prompt: 'q', pad: emoji }));
  assert.ok(body.length > MAX_BODY_BYTES && body.toString('utf8').length < MAX_BODY_BYTES);
  const r = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: e.sc.port, path: '/v1/complete', method: 'POST', headers: { Authorization: `Bearer ${e.sc.token}`, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (out += d));
      res.on('end', () => resolve({ status: res.statusCode, doc: JSON.parse(out) }));
    });
    req.on('error', (err) => setTimeout(() => reject(err), 50));          // an early reply may reset the upload
    for (let i = 0; i < body.length; i += 65_536) req.write(body.subarray(i, i + 65_536));
    req.end();
  });
  assert.equal(r.status, 413);
  assert.equal(r.doc.error.code, 'TOO_LARGE');
  assert.equal(llm.seen.prepared.length, 0, 'no model call');
  await e.stop();
});

test('a caller that hangs up cancels the model call', async () => {
  let aborted;
  const started = new Promise((r) => (aborted = r));
  const llm = fakeLlm({ hold: (o) => new Promise((_, rej) => { o.signal.addEventListener('abort', () => { aborted(true); rej(new Error('aborted')); }); }) });
  const e = await endpoint({ llm });
  const req = request({ host: '127.0.0.1', port: e.sc.port, path: '/v1/complete', method: 'POST', headers: { Authorization: `Bearer ${e.sc.token}`, 'Content-Type': 'application/json' } });
  req.on('error', () => {});
  req.end(JSON.stringify({ prompt: 'q' }));
  await new Promise((r) => setTimeout(r, 80));
  req.destroy();
  assert.equal(await Promise.race([started, new Promise((r) => setTimeout(() => r('not cancelled'), 2000))]), true);
  await e.stop();
});

test('the prompt and the answer are never logged', async () => {
  const lines = [];
  const stateRoot = join(tmp(), 'state');
  const sc = createSidecall({ llm: () => fakeLlm({ chunks: [{ type: 'text-delta', index: 0, text: 'SECRET-ANSWER' }, { type: 'finish', reason: { kind: 'stop' } }] }), route: () => ROUTE, stateRoot, log: (l, m) => lines.push(m) });
  await sc.start();
  await fetch(`http://127.0.0.1:${sc.port}/v1/complete`, { method: 'POST', headers: { Authorization: `Bearer ${sc.token}` }, body: JSON.stringify({ prompt: 'SECRET-PROMPT' }) });
  await sc.stop();
  const all = lines.join('\n');
  assert.ok(lines.length > 0);
  assert.doesNotMatch(all, /SECRET|Bearer/);
  assert.ok(!all.includes(sc.token));
});

test('endpoint files of processes that are gone are swept, a live one\'s is kept', () => {
  const stateRoot = join(tmp(), 'state');
  const dir = join(stateRoot, 'hosts', 'dsh');
  mkdirSync(dir, { recursive: true });
  const dead = spawnSync(process.execPath, ['-e', '0']);
  const live = endpointPath(stateRoot, process.ppid);                          // our parent is certainly running
  const gone = endpointPath(stateRoot, dead.pid);
  const mine = endpointPath(stateRoot, process.pid);
  const other = join(dir, 'sidecall.json');                                    // the core's own pause file: not ours
  for (const f of [live, gone, mine, other]) writeFileSync(f, '{}');
  sweep(stateRoot);
  assert.deepEqual([existsSync(live), existsSync(gone), existsSync(mine), existsSync(other)], [true, false, true, true]);
  sweep(join(tmp(), 'nothing'));                                               // no directory: nothing to do
});

test('a process that only hosts the endpoint still exits by itself, and takes its file with it', () => {
  const stateRoot = join(tmp(), 'state');
  const script = `import(${JSON.stringify(pathToFileURL(SRC).href)}).then(async (m) => {
    const sc = m.createSidecall({ llm: () => ({}), route: () => undefined, stateRoot: ${JSON.stringify(stateRoot)} });
    const file = await sc.start();
    process.stdout.write(file);
  })`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(r.status, 0, r.stderr);                                         // a timeout would be a null status
  assert.match(r.stdout, /sidecall\.\d+\.endpoint\.json$/);
  assert.equal(existsSync(r.stdout), false);
});

// ---- in the plugin ----------------------------------------------------------------------------
function plugin(over = {}) {
  const root = tmp();
  const repo = fakeRepo(root);
  const env = isolatedEnv(root);
  const ctx = fakeCtx();
  const llm = over.llm ?? fakeLlm();
  const bootstrap = join(root, 'fake_core.py');
  // A core that answers every hook with the endpoint file it was given.
  writeFileSync(bootstrap, `import json, os, sys\nsys.stdin.read()\nprint(json.dumps({"additionalContext": os.environ.get("${ENV_FILE}", "")}))\n`);
  const p = createPlugin(ctx, { env, bootstrap, closeOnExit: false, llm, ...over });
  return { ctx, p, repo, env, llm };
}

test('every hook runs with the endpoint\'s path in its environment', async () => {
  const { ctx, p, repo } = plugin();
  ctx.handlers['session/created'][0](rootSession('s1', repo));
  await p.idle();
  assert.ok(p.sidecall.file && existsSync(p.sidecall.file));
  assert.deepEqual([...p.states.values()][0].facts, [p.sidecall.file]);          // the fake core echoed it back
  await p.stop();
});

test('no session, no endpoint; a subagent does not open one', async () => {
  const { ctx, p } = plugin();
  assert.equal(p.sidecall.file, undefined);
  ctx.handlers['session/created'][0]({ id: 'c', header: { id: 'c', cwd: '/x', parentSession: 'p', origin: 'subagent' } });
  await p.idle();
  assert.equal(p.sidecall.file, undefined);
  await p.stop();
});

test('sidecall:false opens no endpoint and leaves the hooks\' environment alone', async () => {
  const { ctx, p, repo } = plugin({ sidecall: false });
  ctx.handlers['session/created'][0](rootSession('s1', repo));
  await p.idle();
  assert.equal(p.sidecall, undefined);
  assert.deepEqual([...p.states.values()][0].facts, []);                          // the fake core echoed an empty path: nothing to add
});

test('the route a call runs on follows the session: its agent, then its requests', async () => {
  const llm = fakeLlm();
  const { ctx, p, repo } = plugin({ llm });
  ctx.handlers['session/created'][0](rootSession('s1', repo));
  await p.idle();
  const call = async () => (await fetch(`http://127.0.0.1:${p.sidecall.port}/v1/complete`, { method: 'POST', headers: { Authorization: `Bearer ${p.sidecall.token}` }, body: JSON.stringify({ prompt: 'q' }) })).json();
  assert.equal((await call()).error.code, 'NO_ROUTE');                            // nothing has made a request yet
  const session = rootSession('s1', repo);
  await ctx.handlers['agent/created'][0]({ agent: { session, options: { provider: 'p1', model: 'm1' }, ctx: { tools: { restrict() {} } } } });
  assert.equal((await call()).text, 'ok');
  assert.deepEqual([llm.seen.prepared.at(-1).provider, llm.seen.prepared.at(-1).model], ['p1', 'm1']);
  ctx.handlers['session/event'][0](session, { type: 'request/context', seq: 1, time: 0, data: { provider: 'p2', model: 'm2', contextWindow: 1 } });
  await call();
  assert.deepEqual([llm.seen.prepared.at(-1).provider, llm.seen.prepared.at(-1).model], ['p2', 'm2']);
  ctx.handlers['session/event'][0](session, { type: 'request/context', seq: 2, time: 0, data: { provider: 5, model: null } });   // garbage changes nothing
  await call();
  assert.equal(llm.seen.prepared.at(-1).model, 'm2');
  await p.stop();
});

// The route before the first request (docs/iterations/3-spike.md): `session/created` (the SessionStart
// hook) comes before `agent/created`, which carries the creation-time route in `agent.options`.
const callEndpoint = async (p, session) => {
  const r = await fetch(`http://127.0.0.1:${p.sidecall.port}/v1/complete`, { method: 'POST', headers: { Authorization: `Bearer ${p.sidecall.token}` }, body: JSON.stringify(session === undefined ? { prompt: 'q' } : { prompt: 'q', session }) });
  return { status: r.status, doc: await r.json() };
};
const agentOf = (session, options) => ({ agent: { session, options, ctx: { tools: { restrict() {} } } } });
const lastRoute = (llm) => [llm.seen.prepared.at(-1)?.provider, llm.seen.prepared.at(-1)?.model];

test('before the session has any route a call is a clean NO_ROUTE (409) and reaches no model', async () => {
  const llm = fakeLlm();
  const { ctx, p, repo } = plugin({ llm });
  ctx.handlers['session/created'][0](rootSession('s1', repo));               // SessionStart: no agent yet
  await p.idle();
  const r = await callEndpoint(p);
  assert.equal(r.status, 409);
  assert.equal(r.doc.error.code, 'NO_ROUTE');
  assert.equal(llm.seen.prepared.length, 0, 'no model call, not even to a default model');
  // an agent that carries no route (both fields are optional in the type) changes nothing
  await ctx.handlers['agent/created'][0](agentOf(rootSession('s1', repo), {}));
  await ctx.handlers['agent/created'][0](agentOf(rootSession('s1', repo), { provider: 'p1' }));
  assert.equal((await callEndpoint(p)).status, 409);
  assert.equal(llm.seen.prepared.length, 0);
  await p.stop();
});

test('a root agent\'s route is the session\'s from agent/created on, before any request/context', async () => {
  const llm = fakeLlm();
  const { ctx, p, repo } = plugin({ llm });
  ctx.handlers['session/created'][0](rootSession('s1', repo));
  await p.idle();
  assert.equal((await callEndpoint(p)).status, 409);
  await ctx.handlers['agent/created'][0](agentOf(rootSession('s1', repo), { provider: 'pa', model: 'ma' }));
  const r = await callEndpoint(p);                                           // no request/context event has been seen
  assert.equal(r.status, 200);
  assert.equal(r.doc.text, 'ok');
  assert.deepEqual(lastRoute(llm), ['pa', 'ma']);
  assert.equal(llm.seen.prepared.length, 1);
  await p.stop();
});

test('a subagent\'s agent/created, with a route of its own, does not change the session\'s', async () => {
  const llm = fakeLlm();
  const { ctx, p, repo } = plugin({ llm });
  ctx.handlers['session/created'][0](rootSession('s1', repo));
  await p.idle();
  // a subagent that is created first leaves the session without a route
  await ctx.handlers['agent/created'][0](agentOf(subSession('c1', repo), { provider: 'sub', model: 'sub-model' }));
  assert.equal((await callEndpoint(p)).status, 409);
  await ctx.handlers['agent/created'][0](agentOf(rootSession('s1', repo), { provider: 'pa', model: 'ma' }));
  await ctx.handlers['agent/created'][0](agentOf(subSession('c2', repo), { provider: 'sub', model: 'sub-model' }));
  assert.equal((await callEndpoint(p)).status, 200);
  assert.deepEqual(lastRoute(llm), ['pa', 'ma'], 'the root agent\'s route stands');
  await p.stop();
});

// ---- one process, several sessions (F1): a call runs on the route of the session it names --------
test('the endpoint hands the NAMED session to the route lookup', async () => {
  const table = { A: { provider: 'pa', model: 'ma' }, B: { provider: 'pb', model: 'mb' } };
  const llm = fakeLlm();
  const e = await endpoint({ llm, routeFor: (s) => (s === undefined ? { provider: 'last', model: 'last' } : table[s]) });
  const at = (session) => e.post(session === undefined ? { prompt: 'q' } : { prompt: 'q', session });
  const ran = () => [llm.seen.prepared.at(-1).provider, llm.seen.prepared.at(-1).model];
  assert.equal((await at('A')).status, 200);
  assert.deepEqual(ran(), ['pa', 'ma']);
  assert.equal((await at('B')).status, 200);
  assert.deepEqual(ran(), ['pb', 'mb']);
  assert.equal((await at(undefined)).status, 200);
  assert.deepEqual(ran(), ['last', 'last'], 'a request that names no session gets the last observed route');
  const before = llm.seen.prepared.length;
  const unknown = await at('nobody');
  assert.deepEqual([unknown.status, unknown.doc.error.code], [409, 'NO_ROUTE']);
  assert.equal(llm.seen.prepared.length, before, 'no model call for a session without a route');
  for (const bad of [5, {}, [], true]) assert.equal((await e.post({ prompt: 'q', session: bad })).doc.error.code, 'BAD_REQUEST');
  assert.equal(llm.seen.prepared.length, before);
  await e.stop();
});

test('with two sessions on different models, a call naming a session runs on that session\'s route', async () => {
  const llm = fakeLlm();
  const { ctx, p, repo } = plugin({ llm });
  const a = rootSession('sA', repo);
  const b = rootSession('sB', repo);
  ctx.handlers['session/created'][0](a);
  ctx.handlers['session/created'][0](b);
  await p.idle();
  await ctx.handlers['agent/created'][0](agentOf(a, { provider: 'pa', model: 'ma' }));
  await ctx.handlers['agent/created'][0](agentOf(b, { provider: 'pb', model: 'mb' }));
  assert.equal((await callEndpoint(p, 'sA')).status, 200);
  assert.deepEqual(lastRoute(llm), ['pa', 'ma'], 'B was observed last, but the call names A');
  assert.equal((await callEndpoint(p, 'sB')).status, 200);
  assert.deepEqual(lastRoute(llm), ['pb', 'mb']);
  ctx.handlers['session/event'][0](a, { type: 'request/context', seq: 1, time: 0, data: { provider: 'pa2', model: 'ma2', contextWindow: 1 } });
  await callEndpoint(p, 'sB');
  assert.deepEqual(lastRoute(llm), ['pb', 'mb'], 'a request of A does not move B');
  await callEndpoint(p, 'sA');
  assert.deepEqual(lastRoute(llm), ['pa2', 'ma2']);
  await callEndpoint(p);
  assert.deepEqual(lastRoute(llm), ['pa2', 'ma2'], 'no session named: the last route observed, as before');
  const before = llm.seen.prepared.length;
  const unknown = await callEndpoint(p, 'sC');
  assert.deepEqual([unknown.status, unknown.doc.error.code], [409, 'NO_ROUTE']);
  assert.equal(llm.seen.prepared.length, before, 'never another session\'s model');
  await p.stop();
});

test('a subagent never sets a route, not even its own', async () => {
  const llm = fakeLlm();
  const { ctx, p, repo } = plugin({ llm });
  const root = rootSession('sA', repo);
  ctx.handlers['session/created'][0](root);
  await p.idle();
  const sub = subSession('c1', repo);
  await ctx.handlers['agent/created'][0](agentOf(sub, { provider: 'sub', model: 'sub-model' }));
  ctx.handlers['session/event'][0](sub, { type: 'request/context', seq: 1, time: 0, data: { provider: 'sub', model: 'sub-model', contextWindow: 1 } });
  assert.equal((await callEndpoint(p, 'c1')).doc.error.code, 'NO_ROUTE');
  assert.equal((await callEndpoint(p)).doc.error.code, 'NO_ROUTE');
  await ctx.handlers['agent/created'][0](agentOf(root, { provider: 'pa', model: 'ma' }));
  assert.equal((await callEndpoint(p)).status, 200);
  assert.deepEqual(lastRoute(llm), ['pa', 'ma']);
  await p.stop();
});

test('the routes kept are bounded: above 64 sessions the oldest is forgotten', async () => {
  const llm = fakeLlm();
  const { ctx, p, repo } = plugin({ llm });
  ctx.handlers['session/created'][0](rootSession('s0', repo));
  await p.idle();
  for (let i = 0; i < 70; i += 1) await ctx.handlers['agent/created'][0](agentOf(rootSession(`s${i}`, repo), { provider: `p${i}`, model: `m${i}` }));
  assert.equal((await callEndpoint(p, 's0')).status, 409);
  assert.equal((await callEndpoint(p, 's5')).status, 409);
  assert.equal((await callEndpoint(p, 's6')).status, 200);
  assert.deepEqual(lastRoute(llm), ['p6', 'm6']);
  assert.equal((await callEndpoint(p, 's69')).status, 200);
  await p.stop();
});

test('every hook\'s environment carries the id of the session it runs for', async () => {
  const root = tmp();
  const repo = fakeRepo(root);
  const bootstrap = join(root, 'fake_core.py');
  writeFileSync(bootstrap, 'import json, os, sys\nsys.stdin.read()\nprint(json.dumps({"additionalContext": os.environ.get("TE_DSH_SESSION", "")}))\n');
  const ctx = fakeCtx();
  const p = createPlugin(ctx, { env: isolatedEnv(root), bootstrap, closeOnExit: false, llm: fakeLlm() });
  ctx.handlers['session/created'][0](rootSession('sA', repo));
  ctx.handlers['session/created'][0](rootSession('sB', repo));
  await p.idle();
  assert.deepEqual([...p.states.values()].map((s) => s.facts), [['sA'], ['sB']]);
  await p.stop();
});

test('llm and tools are services: read through inject, never as plain properties (reading one without inject throws)', async () => {
  const root = tmp();
  const repo = fakeRepo(root);
  const ctx = fakeCtx();
  for (const name of ['llm', 'tools']) Object.defineProperty(ctx, name, { get() { throw new Error(`cannot get property "${name}" without inject`); } });
  const llm = fakeLlm();
  const tools = { schemas: () => [{ name: 'bash' }, { name: 'mcp__a__b' }] };
  const pending = [];
  ctx.inject = (names, fn) => pending.push([names, fn]);
  const p = createPlugin(ctx, { env: isolatedEnv(root), closeOnExit: false, run: async () => ({}) });
  const registered = pending.map(([n]) => n[0]).sort();
  assert.ok(registered.includes('llm') && registered.includes('tools'), registered.join());
  const provide = (name, svc) => pending.find(([n]) => n[0] === name)[1]({ [name]: svc });
  // before the services exist nothing throws, and the call says so
  const session = rootSession('s1', repo);
  await ctx.handlers['agent/created'][0]({ agent: { session, options: { provider: 'p', model: 'm' }, ctx: { tools: { restrict() {} } } } });
  ctx.handlers['session/created'][0](session);
  await p.idle();
  const call = async () => (await fetch(`http://127.0.0.1:${p.sidecall.port}/v1/complete`, { method: 'POST', headers: { Authorization: `Bearer ${p.sidecall.token}` }, body: JSON.stringify({ prompt: 'q' }) })).json();
  assert.equal((await call()).error.code, 'NO_LLM');
  provide('llm', llm);
  provide('tools', tools);
  assert.equal((await call()).text, 'ok');
  await ctx.handlers['agent/created'][0]({ agent: { session, ctx: { tools: { restrict() {} } } } });
  const cat = JSON.parse((await import('node:fs')).readFileSync(join(root, 'state', 'hosts', 'dsh', 'catalog.json'), 'utf8'));
  assert.deepEqual(cat.tools, ['bash', 'mcp__a__b']);
  await p.stop();
});
