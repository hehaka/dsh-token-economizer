process.env.TZ = 'UTC';              // day grouping is in the viewer's zone; the tests pin it
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { SERIES, at, session } from './fixtures.mjs';

const D = createRequire(import.meta.url)('../src/series.cjs');
const rows = (...over) => D.normalizeSessions({ sessions: over.map((o) => session(o)) });

test('axes end on a round number that leaves the bars most of the plot', () => {
  assert.equal(D.niceMax(53937), 60000);
  assert.equal(D.niceMax(4.2e4), 50000);
  assert.equal(D.niceMax(2.1), 2.5);
  assert.equal(D.niceMax(1), 1);
  assert.equal(D.niceMax(1.01), 1.2);
  assert.ok(Math.abs(D.niceMax(0.3) - 0.3) < 1e-12);         // 0.3 / 0.1 is 2.9999999999999996: still the step 3, not 4
  assert.equal(D.niceMax(100), 100);
  assert.equal(D.niceMax(101), 120);
  assert.equal(D.niceMax(0), 1);
  assert.equal(D.niceMax(-3), 1);
  assert.equal(D.niceMax(NaN), 1);
  assert.equal(D.niceMax(Infinity), 1);
  for (const v of [0.003, 7, 83, 999, 53937, 8.8e6]) {
    const m = D.niceMax(v);
    assert.ok(m >= v && v / m > 0.6, `${v} -> ${m}: the axis is not shorter than the data and wastes under 40% of the plot`);
  }
});

test('stacked columns are exact: a segment is value / axis max of the plot height', () => {
  const g = D.layoutColumns([
    { label: 'a', parts: { cache_read: 1000, input: 500, overhead: 500 } },
    { label: 'b', parts: { cache_read: 250 } },
  ], { width: 240, height: 150 });
  assert.equal(g.max, 2000);                                  // 2000 is the tallest column and already round
  const { h: plotH, y0 } = g.box;
  const [a, b] = g.columns;
  assert.deepEqual(a.segments.map((s) => s.key), ['cache_read', 'input', 'overhead']);   // bottom to top
  assert.equal(a.segments[0].h, 1000 / 2000 * plotH);
  assert.equal(a.segments[1].h, 500 / 2000 * plotH);
  assert.equal(a.segments[2].y, y0);                          // the full column reaches the top of the plot
  assert.equal(a.segments[0].y + a.segments[0].h, g.baseline);
  assert.equal(a.segments[1].y + a.segments[1].h, a.segments[0].y);       // stacked without a gap
  assert.equal(b.segments[0].h, 250 / 2000 * plotH);
  assert.ok(b.x > a.x + a.w && b.cx > a.cx);
  assert.deepEqual(g.yTicks.map((t) => t.value), [0, 1000, 2000]);
  assert.deepEqual(g.yTicks.map((t) => t.label), ['0', '1.00k', '2.00k']);
  assert.equal(g.yTicks[0].y, g.baseline);
  assert.deepEqual(g.xLabels.map((l) => l.text), ['a', 'b']);
});

test('few columns are all labelled (repeats dropped), many only at the ends', () => {
  const lab = (labels) => D.layoutColumns(labels.map((l) => ({ label: l, parts: { input: 1 } })), { width: 300, height: 120 }).xLabels.map((l) => l.text);
  assert.deepEqual(lab(['4 Nov', '4 Nov', '5 Nov', '6 Nov', '6 Nov']), ['4 Nov', '5 Nov', '6 Nov']);
  assert.deepEqual(lab(Array.from({ length: 9 }, (_, i) => `d${i}`)), ['d0', 'd8']);
  assert.deepEqual(lab(Array.from({ length: 8 }, (_, i) => `d${i}`)).length, 8);
  assert.deepEqual(lab(['only']), ['only']);
  assert.deepEqual(lab([]), []);
  const anchors = D.layoutColumns(['a', 'b', 'c'].map((l) => ({ label: l, parts: { input: 1 } })), { width: 300, height: 120 }).xLabels.map((l) => l.anchor);
  assert.deepEqual(anchors, ['start', 'middle', 'end']);
});

test('columns never leave the plot, whatever the count, and degenerate input is safe', () => {
  for (const n of [0, 1, 2, 7, 120]) {
    const items = Array.from({ length: n }, (_, i) => ({ label: String(i), parts: { input: i + 1 } }));
    const g = D.layoutColumns(items, { width: 200, height: 140 });
    assert.equal(g.columns.length, n);
    for (const c of g.columns) {
      assert.ok(c.x >= g.box.x0 - 0.01 && c.x + c.w <= g.box.x0 + g.box.w + 0.01, `column ${c.label} inside the plot`);
      assert.ok(c.w > 0 && c.w <= 22);
      for (const s of c.segments) assert.ok(Number.isFinite(s.y) && s.h > 0 && s.y >= g.box.y0 - 0.01);
    }
  }
  const empty = D.layoutColumns([], { width: 200, height: 140 });
  assert.deepEqual([empty.columns, empty.xLabels, empty.max], [[], [], 1]);
  const zero = D.layoutColumns([{ label: 'z', parts: {} }, { label: 'n', parts: { input: -5, output: NaN } }], { width: 200, height: 140 });
  assert.ok(zero.columns.every((c) => c.segments.length === 0));
  const tiny = D.layoutColumns([{ label: 'a', parts: { input: 1 } }], { width: 5, height: 5 });
  assert.ok(Number.isFinite(tiny.box.w) && tiny.box.w >= 10);
});

test('a line breaks at unknown values instead of drawing them as zero', () => {
  const g = D.layoutLine([0.2, 0.4, null, 1, 0], { width: 240, height: 90 });
  assert.equal(g.lines.length, 2);
  assert.deepEqual(g.lines.map((l) => l.length), [2, 2]);
  assert.equal(g.points.length, 4);
  assert.equal(g.points.find((p) => p.v === 1).y, g.box.y0);               // 100% is the top of the plot
  assert.equal(g.points.find((p) => p.v === 0).y, g.baseline);
  assert.deepEqual(g.yTicks.map((t) => t.label), ['0%', '50%', '100%']);
  assert.equal(D.layoutLine([2, -1], { width: 100, height: 80 }).points.map((p) => p.y).join(), `${D.layoutLine([1], { width: 100, height: 80 }).points[0].y},${D.layoutLine([0], { width: 100, height: 80 }).points[0].y}`);   // clamped
  assert.deepEqual(D.layoutLine([], { width: 100, height: 80 }).lines, []);
});

test('sessions from the payload are made safe to draw', () => {
  const got = D.normalizeSessions({ sessions: [null, 'x', { id: 7, started: 'soon', effective: 'many', parts: 'oops', overhead: -3, cache_hit: NaN, requests: null, injected: 'yes' }, session({ overhead: 50 })] });
  assert.equal(got.length, 2);
  assert.deepEqual([got[0].id, got[0].started, got[0].effective, got[0].priced, got[0].overhead, got[0].cacheHit, got[0].requests, got[0].injected, got[0].total], ['7', null, null, false, 0, null, 0, false, 0]);
  assert.deepEqual(got[0].parts, {});
  assert.equal(got[1].total, 17559.1 + 50);
  assert.equal(got[1].parts.overhead, 50);
  assert.deepEqual(D.normalizeSessions(undefined), []);
  assert.deepEqual(D.normalizeSessions({ sessions: 'nope' }), []);
});

test('ranges keep the newest sessions; unknown ids fall back to the default', () => {
  const all = D.normalizeSessions({ sessions: Array.from({ length: 40 }, (_, i) => session({ id: `s${i}` })) });
  assert.equal(D.sliceRange(all, '10').length, 10);
  assert.equal(D.sliceRange(all, '10').at(-1).id, 's39');
  assert.equal(D.sliceRange(all, '30').length, 30);
  assert.equal(D.sliceRange(all, 'all').length, 40);
  assert.equal(D.sliceRange(all, 'bogus').length, 30);
  assert.equal(D.sliceRange(all.slice(0, 3), '10').length, 3);
});

test('days are the viewer\'s calendar days, oldest first, sessions without a time are skipped', () => {
  const s = rows({ id: 'x', started: at(4, 23, 30), effective: 100, overhead: 5 }, { id: 'y', started: at(5, 0, 30), effective: 200 }, { id: 'z', started: at(5, 9), effective: 50, nudges: 1 }, { id: 'n', started: null, effective: 999 }, { id: 'u', started: at(5, 10), effective: null });
  const days = D.groupByDay(s);
  assert.deepEqual(days.map((d) => d.key), ['2026-11-04', '2026-11-05']);
  assert.deepEqual([days[0].sessions, days[0].effective, days[0].overhead], [1, 100, 5]);
  assert.deepEqual([days[1].sessions, days[1].effective, days[1].nudges], [3, 250, 1]);
  assert.equal(D.groupByDay(rows(...Array.from({ length: 20 }, (_, i) => ({ started: at(1 + i), effective: 1 }))), 14).length, 14);
  assert.equal(D.dayLabel('2026-11-04'), '4 Nov');
  assert.equal(D.dayKey(at(4, 23, 59)), '2026-11-04');
  assert.equal(D.fmtWhen(null), '—');
});

test('caption facts come from the shown sessions only', () => {
  const sum = D.summarize(D.normalizeSessions(SERIES));
  assert.deepEqual([sum.count, sum.priced, sum.injected, sum.nudges, sum.aborts], [5, 4, 1, 2, 1]);
  assert.equal(sum.median, (12000 + 17559.1) / 2);          // even count: mean of the middle two of 8000, 12000, 17559.1, 30000
  assert.ok(Math.abs(sum.meanHit - (0.35 + 0.8 + 0.6) / 3) < 1e-9);          // sessions without a hit rate do not count as 0
  const none = D.summarize([]);
  assert.deepEqual([none.count, none.median, none.meanHit], [0, null, null]);
});

test('column items carry a tooltip with what was recorded, and mark injection and gaps', () => {
  const cols = D.sessionColumns(D.normalizeSessions(SERIES));
  assert.equal(cols.length, 5);
  assert.match(cols[1].title, /2026-11-04 17:00 · claude-haiku-5-5/);
  assert.match(cols[1].title, /30\.0k effective tokens/);
  assert.match(cols[1].title, /facts injected/);
  assert.equal(cols[1].marker, true);
  assert.match(cols[2].title, /2 redirect\(s\), 1 still-stuck/);
  assert.match(cols[2].title, /\+ 400 overhead/);
  assert.equal(cols[3].gap, true);
  assert.match(cols[3].title, /not priced/);
  const dcols = D.dayColumns(D.groupByDay(D.normalizeSessions(SERIES)));
  assert.deepEqual(dcols.map((d) => d.label), ['4 Nov', '5 Nov', '6 Nov']);
  assert.match(dcols[0].title, /2 session\(s\)/);
});
