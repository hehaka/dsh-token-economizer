import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { ALLOWED, USAGE, runTe, splitArgs } from '../src/command.mjs';
import { createPlugin } from '../src/plugin.mjs';
import { BOOTSTRAP, fakeCtx, fakeRepo, isolatedEnv, tmp } from './helpers.mjs';

test('a command line is split like a shell would, without running one', () => {
  assert.deepEqual(splitArgs('status --json'), ['status', '--json']);
  assert.deepEqual(splitArgs('  config set  "a b"=1 '), ['config', 'set', 'a b=1']);
  assert.deepEqual(splitArgs("toolprune apply 'my tool' x\\ y"), ['toolprune', 'apply', 'my tool', 'x y']);
  assert.deepEqual(splitArgs(''), []);
  assert.deepEqual(splitArgs('status ""'), ['status', '']);
  assert.equal(splitArgs('status "unterminated'), null);
  assert.deepEqual(splitArgs('status; rm -rf /'), ['status;', 'rm', '-rf', '/'], 'metacharacters are plain text');
});

function ctxFor(root) {
  const repo = fakeRepo(root);
  return { repo, opts: { env: isolatedEnv(root), bootstrap: BOOTSTRAP, cwd: repo } };
}

test('/te runs the core\'s command line for the session\'s repository', async () => {
  const { opts } = ctxFor(tmp());
  const def = await runTe('', opts);                        // no arguments: status
  assert.equal(def.kind, 'success', def.text);
  assert.match(def.text, /toolprune/i);
  const json = await runTe('status --json', opts);
  assert.equal(json.kind, 'success', json.text);
  const status = JSON.parse(json.text);
  assert.equal(status.toolprune.mode !== undefined, true);
  assert.equal(status.host, 'dsh', 'status is about the dsh host, kept apart from every other agent\'s');
  assert.match(status.state, /[\\/]dsh$/);
});

test('/te panel --json is the one document a visual panel reads: status plus the session series', async () => {
  const { opts } = ctxFor(tmp());
  const r = await runTe('panel --json', opts);
  assert.equal(r.kind, 'success', r.text);
  const doc = JSON.parse(r.text);
  assert.equal(doc.schema, 1);
  assert.equal(doc.status.host, 'dsh');
  assert.deepEqual(doc.series.sessions, []);
  assert.equal(r.text.split('\n').filter(Boolean).length, 1, 'one line: a command row in the chat stays short');
  assert.match((await runTe('panel', opts)).text, /nothing folded yet/);
});

test('unknown commands, bad quoting, help and the core\'s own errors answer as errors or usage', async () => {
  const { opts } = ctxFor(tmp());
  assert.deepEqual(await runTe('help', opts), { kind: 'success', text: USAGE });
  const unknown = await runTe('fold --session x', opts);
  assert.equal(unknown.kind, 'error');
  assert.match(unknown.text, /Unknown command "fold"/);
  assert.ok(!ALLOWED.has('fold') && !ALLOWED.has('judge') && !ALLOWED.has('probe'));
  assert.equal((await runTe('status "oops', opts)).kind, 'error');
  const bad = await runTe('config set', opts);               // the core rejects it: shown, not hidden
  assert.equal(bad.kind, 'error');
  assert.ok(bad.text.length > 0);
});

test('every failure is a message, never a throw', async () => {
  const root = tmp();
  const { opts } = ctxFor(root);
  assert.equal((await runTe('status', { ...opts, bootstrap: null })).kind, 'error');
  assert.equal((await runTe('status', { ...opts, env: { ...opts.env, TE_DISABLE: '1' } })).kind, 'error');
  const noPython = await runTe('status', { ...opts, env: { PATH: '', TE_PYTHON: '/nonexistent/python' } });
  assert.equal(noPython.kind, 'error');
  assert.match(noPython.text, /Python/);
  const slow = join(root, 'slow.py');
  (await import('node:fs')).writeFileSync(slow, 'import time\ntime.sleep(10)\n');
  const t0 = Date.now();
  const timed = await runTe('status', { ...opts, bootstrap: slow, timeoutMs: 300 });
  assert.equal(timed.kind, 'error');
  assert.match(timed.text, /did not finish/);
  assert.ok(Date.now() - t0 < 5000);
});

test('the plugin registers /te once the commands service exists, and its handler answers', async () => {
  const root = tmp();
  const { repo, opts } = ctxFor(root);
  const registered = [];
  const ctx = { ...fakeCtx(), inject(deps, cb) { assert.deepEqual(deps, ['commands']); cb({ commands: { register: (d) => registered.push(d) } }); } };
  createPlugin(ctx, { ...opts, closeOnExit: false, run: async () => ({}) });
  assert.equal(registered.length, 1);
  const [def] = registered;
  assert.equal(def.name, 'te');
  assert.ok(def.description && def.input.hint);
  const out = await def.handler({ rawInput: ' status', agent: { session: { header: { cwd: repo } } }, signal: new AbortController().signal });
  assert.equal(out.kind, 'success', out.text);
  const boom = createPlugin({ ...fakeCtx(), inject(_d, cb) { cb({ commands: { register: (d) => (registered.length = 0, registered.push(d)) } }); } },
    { ...opts, closeOnExit: false, run: async () => ({}), runCommand: async () => { throw new Error('kaboom'); } });
  assert.ok(boom);
  const err = await registered[0].handler({ rawInput: '', agent: {}, signal: new AbortController().signal });
  assert.deepEqual(err, { kind: 'error', text: 'te failed: kaboom' });
});

test('a profile without the commands service still gets the hooks', () => {
  const ctx = fakeCtx();                                    // no inject, no commands
  assert.ok(createPlugin(ctx, { env: {}, bootstrap: BOOTSTRAP, closeOnExit: false, run: async () => ({}) }));
  assert.ok(ctx.handlers['tools/post-execute'].length === 1);
});
