import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { buildClient } from '../build.mjs';
import { fakeReact } from './fake-react.mjs';
import { STATUS } from './fixtures.mjs';

/** Run the built bundle the way the browser shell does: register a factory, then materialize it. */
function load(requireImpl) {
  let registered;
  const window = { __ModuleLoader__: { load: (r) => { registered = r; } } };
  vm.runInNewContext(buildClient(), { window });
  assert.ok(registered, 'the bundle registers one module');
  return { registered, exports: registered.factory(requireImpl) };
}

test('the bundle registers under the package name and exports the client module face', () => {
  const fake = fakeReact();
  const { registered, exports } = load((n) => { assert.equal(n, 'react'); return fake.react; });
  assert.equal(registered.id, 'dsh-token-economizer');
  assert.equal(exports.name, 'dsh-token-economizer');
  assert.equal(typeof exports.apply, 'function');
  assert.deepEqual([...exports.inject], ['slots', 'remote', 'remote.commands', 'sidebarRightTabs']);   // spread: the array comes from the vm realm
});

test('it asks the shell for react only, and nothing else leaks into the browser', () => {
  const asked = [];
  const fake = fakeReact();
  load((n) => (asked.push(n), fake.react));
  assert.deepEqual([...new Set(asked)], ['react']);
});

function fakeCtx(opts = {}) {
  const { execute } = opts;
  const registered = { tabs: [], slots: [], effects: [] };
  return {
    registered,
    sidebarRightTabs: { register: (d) => (registered.tabs.push(d), () => {}) },
    slots: { inject: (name, factory) => registered.slots.push({ name, factory }), register: (spec, comp) => ({ spec, comp, propsFor: (sid) => spec.inject?.(sid) }) },
    remote: { commands: { execute: execute ?? (async () => ({ ok: true, value: { result: { kind: 'success', text: JSON.stringify(STATUS) } } })) } },
    effect(fn, label) { registered.effects.push(label); fn(); },
  };
}

test('apply registers the page type and the tab body', async () => {
  const fake = fakeReact();
  const { exports } = load(() => fake.react);
  const ctx = fakeCtx();
  exports.apply(ctx);
  const [tab] = ctx.registered.tabs;
  assert.equal(tab.id, 'dsh-token-economizer');
  assert.equal(tab.kind, 'token-economizer');
  assert.equal(tab.title(), 'TokenEconomizer');
  assert.equal(tab.guide.length, 1);
  assert.equal(typeof tab.guide[0].title(), 'string');
  assert.deepEqual(ctx.registered.slots.map((s) => s.name), ['sidebar.right.pane.tab']);
  const { spec, comp } = ctx.registered.slots[0].factory();
  assert.equal(spec.name, 'sidebar.right.pane.tab');
  assert.equal(spec.key, 'dsh-token-economizer');
  assert.deepEqual({ ...spec.inject('sess-9') }, { sessionId: 'sess-9' }, 'the slot hands the panel its session');
  assert.equal(typeof comp, 'function');
});

test('the panel runs /te status --json in the session the slot gave it', async () => {
  const fake = fakeReact();
  const { exports } = load(() => fake.react);
  const calls = [];
  const ctx = fakeCtx({ execute: async (...a) => (calls.push(a), { ok: true, value: { result: { kind: 'success', text: JSON.stringify(STATUS) } } }) });
  exports.apply(ctx);
  const { comp, spec } = ctx.registered.slots[0].factory();
  const props = spec.inject('sess-1');
  fake.render(comp, props);
  fake.flushEffects();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['sess-1', '/te status --json', []]]);   // JSON: arrays built in the vm realm
  assert.equal(fake.render(comp, props).props.view.state, 'ready');
});

test('with no session the panel says so instead of calling the host', async () => {
  const fake = fakeReact();
  const { exports } = load(() => fake.react);
  let called = false;
  const ctx = fakeCtx({ execute: async () => { called = true; return {}; } });
  exports.apply(ctx);
  const { comp } = ctx.registered.slots[0].factory();
  for (const props of [undefined, {}, { sessionId: undefined }, { sessionId: null }, { sessionId: '' }]) {
    fake.render(comp, props);
    fake.flushEffects();
    await new Promise((r) => setImmediate(r));
    const view = fake.render(comp, props).props.view;
    assert.equal(view.state, 'error');
    assert.match(view.message, /Open a session/);
  }
  assert.equal(called, false);
});
