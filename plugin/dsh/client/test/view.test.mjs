import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fakeReact, findAll, marked, textOf } from './fake-react.mjs';
import { PANEL, STATUS } from './fixtures.mjs';

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
  const Panel = createPanel(async () => { calls += 1; return { ok: true, value: { result: { kind: 'success', text: JSON.stringify(PANEL) } } }; });
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

const rowOf = (tree) => marked(tree).find((n) => n.props['data-te'] === 'modelcalls');
const drawn = (side) => {
  const { react } = fakeReact();
  const { StatusView } = createViews(react);
  const model = buildModel(side === undefined ? PANEL : { ...PANEL, side });
  return StatusView({ view: { state: 'ready', model }, onRefresh() {} });
};

test('the Model calls row follows the mechanisms and shows title, state and detail when active', () => {
  const tree = drawn({ paused: null, host: 'dsh' });
  const all = tags(tree);
  assert.ok(all.includes('modelcalls'), 'a row marked modelcalls');
  assert.ok(all.indexOf('modelcalls') > all.indexOf('mechanism-loopguard'), 'after the mechanisms');
  const text = textOf(rowOf(tree));
  assert.match(text, /Model calls/);
  assert.match(text, /active/i);
  assert.match(text, /answered through DSH's model service/);
  assert.doesNotMatch(text, /paused/i);
});

test('a paused Model calls row says so in words, with the reason and the way out', () => {
  const tree = drawn({ paused: { at: 1762500000, reason: 'Please run /login' }, host: 'dsh' });
  const text = textOf(rowOf(tree));
  assert.match(text, /Model calls/);
  assert.match(text, /paused/i);
  assert.match(text, /Please run \/login/);
  assert.match(text, /te config set microskills\|loopguard/);
  assert.doesNotMatch(textOf(rowOf(drawn({ paused: null, host: 'dsh' }))), /paused/i);
});

test('the state is a badge text of its own, so colour is not the only signal', () => {
  const badge = (tree) => {
    const row = rowOf(tree);
    assert.ok(row, 'a row marked modelcalls');
    return findAll(row, (e) => typeof e.type === 'string' && /^(active|paused|unknown)$/i.test(textOf(e).trim()));
  };
  assert.equal(badge(drawn({ paused: null, host: 'dsh' })).length, 1, 'active has a badge');
  assert.equal(badge(drawn({ paused: { at: 1, reason: 'r' }, host: 'dsh' })).length, 1, 'paused has a badge');
  assert.equal(badge(drawn(undefined)).length, 1, 'unknown has a badge');
});

test('without side data the row says unknown and no data, and the panel still draws', () => {
  const tree = drawn(undefined);
  const text = textOf(rowOf(tree));
  assert.match(text, /Model calls/);
  assert.match(text, /unknown/i);
  assert.match(text, /no data/);
  assert.deepEqual(tags(tree).filter((t) => t.startsWith('mechanism-')), ['mechanism-microskills', 'mechanism-toolprune', 'mechanism-loopguard']);
});

test('the Model calls row is drawn for an empty ledger too', () => {
  const { react } = fakeReact();
  const { StatusView } = createViews(react);
  const model = buildModel({ ...PANEL, status: { ...STATUS, ledger: { ...STATUS.ledger, sessions: 0 } }, side: { paused: null, host: 'dsh' } });
  assert.ok(tags(StatusView({ view: { state: 'ready', model }, onRefresh() {} })).includes('modelcalls'));
});
