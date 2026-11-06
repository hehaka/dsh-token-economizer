import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fakeReact, marked, textOf } from './fake-react.mjs';
import { STATUS } from './fixtures.mjs';

const require = createRequire(import.meta.url);
const { createViews } = require('../src/view.cjs');
const { buildModel, toViewState } = require('../src/model.cjs');

const tags = (tree) => marked(tree).map((n) => n.props['data-te']);

test('a loaded status draws the header, the numbers and the three mechanisms', () => {
  const { react } = fakeReact();
  const { StatusView } = createViews(react);
  const tree = StatusView({ view: { state: 'ready', model: buildModel(STATUS) }, onRefresh() {} });
  const all = tags(tree);
  assert.ok(all.includes('ready') && all.includes('stat-Sessions') && all.includes('stat-Effective tokens') && all.includes('stat-Plugin overhead'));
  assert.deepEqual(all.filter((t) => t.startsWith('mechanism-')), ['mechanism-microskills', 'mechanism-toolprune', 'mechanism-loopguard']);
  const text = textOf(tree);
  assert.match(text, /acme\/widget · dsh/);
  assert.match(text, /53\.9k/);
  assert.match(text, /Loop guard/);
});

test('an empty ledger says why there are no numbers, and warnings are shown', () => {
  const { react } = fakeReact();
  const { StatusView } = createViews(react);
  const model = buildModel({ ...STATUS, warnings: ['state dir is read-only'], ledger: { ...STATUS.ledger, sessions: 0 } });
  const tree = StatusView({ view: { state: 'ready', model }, onRefresh() {} });
  assert.ok(tags(tree).includes('empty') && tags(tree).includes('warning'));
  assert.ok(!tags(tree).some((t) => t.startsWith('stat-')));
  assert.match(textOf(tree), /state dir is read-only/);
});

test('loading and error states keep the refresh control, and refresh is wired', () => {
  const { react } = fakeReact();
  const { StatusView } = createViews(react);
  let clicks = 0;
  const err = StatusView({ view: { state: 'error', message: 'Open a session first' }, onRefresh: () => (clicks += 1) });
  assert.ok(tags(err).includes('error') && tags(err).includes('refresh'));
  assert.match(textOf(err), /Open a session first/);
  marked(err).find((n) => n.props['data-te'] === 'refresh').props.onClick();
  assert.equal(clicks, 1);
  const loading = StatusView({ view: { state: 'loading' }, onRefresh() {} });
  assert.ok(tags(loading).includes('loading'));
  assert.equal(marked(loading).find((n) => n.props['data-te'] === 'refresh').props.disabled, true);
});

test('the panel reads status once when it opens and again only when asked', async () => {
  const fake = fakeReact();
  const { createPanel } = createViews(fake.react);
  let calls = 0;
  const Panel = createPanel(async () => { calls += 1; return { ok: true, value: { result: { kind: 'success', text: JSON.stringify(STATUS) } } }; });
  let tree = fake.render(Panel);
  assert.equal(tree.props.view.state, 'loading');
  fake.flushEffects();
  await new Promise((r) => setImmediate(r));
  tree = fake.render(Panel);
  assert.equal(tree.props.view.state, 'ready');
  assert.equal(calls, 1, 'no polling');
  tree.props.onRefresh();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2);
});

test('a throwing fetch becomes an error state', async () => {
  const fake = fakeReact();
  const { createPanel } = createViews(fake.react);
  const Panel = createPanel(async () => { throw new Error('socket closed'); });
  fake.render(Panel);
  fake.flushEffects();
  await new Promise((r) => setImmediate(r));
  const tree = fake.render(Panel);
  assert.deepEqual(tree.props.view, { state: 'error', message: 'socket closed' });
  assert.ok(toViewState);
});
