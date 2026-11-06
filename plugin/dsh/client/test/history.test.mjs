process.env.TZ = 'UTC';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fakeReact, findAll, marked, textOf } from './fake-react.mjs';
import { PANEL, SERIES, STATUS, at, session } from './fixtures.mjs';

const require = createRequire(import.meta.url);
const { createViews } = require('../src/view.cjs');
const { createCharts } = require('../src/charts.cjs');
const { toViewState } = require('../src/model.cjs');

const ready = (series) => ({ state: 'ready', ...toViewState({ ok: true, value: { result: { kind: 'success', text: JSON.stringify({ ...PANEL, series }) } } }) });
const view = (series, props = {}) => {
  const { react } = fakeReact();
  const { StatusView } = createViews(react);
  return StatusView({ view: ready(series), onRefresh() {}, ...props });
};
const charts = (tree) => findAll(tree, (e) => e.type === 'svg' && e.props['data-te-chart']);
const tags = (tree) => marked(tree).map((e) => e.props['data-te']);

test('a column chart draws one bar per session, each part as a segment of the recorded size', () => {
  const { react } = fakeReact();
  const { Columns } = createCharts(react);
  const D = require('../src/series.cjs');
  const items = D.sessionColumns(D.normalizeSessions(SERIES));
  const svg = Columns({ items, width: 320, label: 'x' });
  assert.equal(svg.props['data-te-bars'], 5);
  assert.equal(svg.props.role, 'img');
  const bars = findAll(svg, (e) => e.props?.['data-te-bar'] !== undefined);
  assert.equal(bars.length, 5);
  const segs = (bar) => findAll(bar, (e) => e.props?.['data-te-seg']).map((e) => [e.props['data-te-seg'], e.props['data-te-value']]);
  assert.deepEqual(segs(bars[1]), [['cache_read', 9000], ['input', 1000], ['cache_write', 15000], ['output', 5000]]);
  assert.deepEqual(segs(bars[2]), [['total', 8000], ['overhead', 400]]);      // no breakdown: one unsplit part, overhead on top
  assert.deepEqual(segs(bars[3]), []);                                        // not priced: nothing drawn, not a zero-height bar
  assert.equal(findAll(svg, (e) => e.props?.['data-te-marker'] !== undefined).length, 1);   // facts injected in one session
  assert.match(textOf(bars[1]), /facts injected/);                           // the tooltip
});

test('a line chart skips unknown values', () => {
  const { react } = fakeReact();
  const { Line } = createCharts(react);
  const svg = Line({ values: [0.2, null, 0.9, 0.7], width: 300, label: 'x' });
  assert.equal(svg.props['data-te-points'], 3);
  assert.equal(findAll(svg, (e) => e.type === 'polyline').length, 1);        // 0.2 alone is a point, not a line
});

test('the history shows every chart the data supports, in the viewer\'s days', () => {
  const tree = view(SERIES);
  assert.deepEqual(tags(tree).filter((t) => t.startsWith('chart-')), ['chart-sessions', 'chart-cache', 'chart-days', 'chart-redirects']);
  assert.deepEqual(charts(tree).map((c) => [c.props['data-te-chart'], c.props['data-te-bars'] ?? c.props['data-te-points']]), [['columns', 5], ['line', 3], ['columns', 3], ['columns', 5]]);
  const text = textOf(tree);
  assert.match(text, /5 of 5 session\(s\)/);
  assert.match(text, /median 14\.8k each/);                       // of the four priced sessions: 8000, 12000, 17559.1, 30000
  assert.match(text, /facts injected in 1/);
  assert.match(text, /Recorded values only/);
  assert.doesNotMatch(text.toLowerCase(), /\bsaved\b|you save|saving of/);
});

test('with little data the history leaves out charts that would say nothing', () => {
  const one = { sessions: [session({ id: 'only' })] };
  const tree = view(one);
  assert.deepEqual(tags(tree).filter((t) => t.startsWith('chart-')), ['chart-sessions']);       // no line from one point, no per-day from one day
  assert.deepEqual(tags(view({ sessions: [] })).filter((t) => t === 'history' || t.startsWith('chart-')), []);
  assert.deepEqual(tags(view(null)).filter((t) => t === 'history'), []);                         // an older core: overview only
  const calm = view({ sessions: [session({ started: at(4) }), session({ started: at(5) })] });
  assert.ok(!tags(calm).includes('chart-redirects'));                                            // the guard never fired
});

test('the range buttons re-draw from data already loaded, newest sessions first', () => {
  const many = { sessions: Array.from({ length: 40 }, (_, i) => session({ id: `s${i}`, started: at(1 + (i % 20), 10 + (i % 5)) })) };
  const bars = (tree) => charts(tree).find((c) => c.props['data-te-chart'] === 'columns').props['data-te-bars'];
  assert.equal(bars(view(many)), 30);                                   // default range
  assert.equal(bars(view(many, { range: '10' })), 10);
  assert.equal(bars(view(many, { range: 'all' })), 40);
  const picked = [];
  const tree = view(many, { range: '10', onRange: (id) => picked.push(id) });
  const buttons = marked(tree).filter((e) => e.props['data-te'].startsWith('range-'));
  assert.deepEqual(buttons.map((b) => [b.props['data-te'], b.props['aria-pressed']]), [['range-10', true], ['range-30', false], ['range-all', false]]);
  buttons[2].props.onClick();
  assert.deepEqual(picked, ['all']);
});

test('changing the range does not run the command again, and a new session does', async () => {
  const fake = fakeReact();
  const { createPanel } = createViews(fake.react);
  let calls = 0;
  const Panel = createPanel(async () => { calls += 1; return { ok: true, value: { result: { kind: 'success', text: JSON.stringify(PANEL) } } }; });
  fake.render(Panel, { sessionId: 'a' });
  fake.flushEffects();
  await new Promise((r) => setImmediate(r));
  let tree = fake.render(Panel, { sessionId: 'a' });
  assert.equal(calls, 1);
  tree.props.onRange('all');
  tree = fake.render(Panel, { sessionId: 'a' });
  assert.equal(tree.props.range, 'all');
  assert.equal(calls, 1, 'a range is a view setting');
  assert.equal(tree.props.view.series.sessions.length, 5);
  assert.deepEqual(tree.props.onRefresh.deps, ['a'], 'only the session re-runs the command, never the range');
});

test('every kind of odd series still renders', () => {
  const odd = { sessions: [{}, { parts: { input: -1 } }, session({ effective: Infinity }), session({ cache_hit: 7 }), { id: 'x', started: 1e18 }] };
  assert.doesNotThrow(() => textOf(view(odd)));
  assert.doesNotThrow(() => textOf(view({ sessions: [] })));
  assert.ok(STATUS);
});
