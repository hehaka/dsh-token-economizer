'use strict';
// The history charts' data and geometry. Pure (no React, no DOM): `te panel --json`'s series in,
// numbers and coordinates out, so it runs under node:test. Everything drawn was recorded; nothing
// here estimates a saving (the ledger has no run without the plugin to compare against).
const { fmtTokens } = require('./model.cjs');

const RANGES = [{ id: '10', label: 'Last 10', n: 10 }, { id: '30', label: 'Last 30', n: 30 }, { id: 'all', label: 'All', n: Infinity }];
const DEFAULT_RANGE = '30';
// Bottom to top. cache reads sit lowest: they are the cheap, large part, and the rest reads on top.
const STACK = ['cache_read', 'input', 'cache_write', 'output', 'total', 'overhead'];
const LABELS = { cache_read: 'Cache reads', input: 'Fresh input', cache_write: 'Cache writes', output: 'Output', total: 'Not split (no token breakdown)', overhead: 'Plugin overhead', effective: 'Effective tokens', nudges: 'Redirects', aborts: 'Still-stuck notices' };
const COLORS = { cache_read: '#3aa6a0', input: '#4c8dff', cache_write: '#e0a030', output: '#a778e8', total: '#8a8f98', overhead: '#e05a5a', nudges: '#e0a030', aborts: '#e05a5a', hit: '#3aa6a0', effective: '#4c8dff' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pad2 = (n) => String(n).padStart(2, '0');

/** Epoch seconds -> "2026-11-06 14:42" in the viewer's time zone; "—" when unknown. */
function fmtWhen(ts) {
  const t = finite(ts);
  if (t === null) return '—';
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
const dayKey = (ts) => fmtWhen(ts).slice(0, 10);
const dayLabel = (key) => (key === '—' ? '—' : `${Number(key.slice(8, 10))} ${MONTHS[Number(key.slice(5, 7)) - 1]}`);

/** The payload's sessions, made safe to draw: numbers or null, parts as one flat record. */
function normalizeSessions(series) {
  const raw = Array.isArray(series?.sessions) ? series.sessions : [];
  return raw.filter((s) => typeof s === 'object' && s !== null).map((s) => {
    const parts = {};
    if (s.parts && typeof s.parts === 'object') for (const k of STACK) if (finite(s.parts[k]) > 0) parts[k] = s.parts[k];
    const overhead = finite(s.overhead) > 0 ? s.overhead : 0;
    if (overhead > 0) parts.overhead = overhead;
    const priced = finite(s.effective) !== null;
    return {
      id: String(s.id ?? ''), started: finite(s.started), model: typeof s.model === 'string' ? s.model : null,
      effective: finite(s.effective), overhead, parts, priced, total: (priced ? s.effective : 0) + overhead,
      cacheHit: finite(s.cache_hit), requests: finite(s.requests) ?? 0, turns: finite(s.turns) ?? 0,
      nudges: finite(s.nudges) ?? 0, aborts: finite(s.aborts) ?? 0, injected: s.injected === true,
    };
  });
}

/** The newest `n` sessions of a range id ("10", "30", "all"). */
function sliceRange(sessions, rangeId) {
  const r = RANGES.find((x) => x.id === rangeId) ?? RANGES.find((x) => x.id === DEFAULT_RANGE);
  return Number.isFinite(r.n) ? sessions.slice(-r.n) : sessions;
}

/** Sessions grouped by local calendar day, oldest first, the newest `maxDays` days that have any. */
function groupByDay(sessions, maxDays = 14) {
  const days = new Map();
  for (const s of sessions) {
    if (s.started === null) continue;
    const key = dayKey(s.started);
    const d = days.get(key) ?? { key, sessions: 0, effective: 0, overhead: 0, nudges: 0, aborts: 0 };
    d.sessions += 1; d.effective += s.effective ?? 0; d.overhead += s.overhead; d.nudges += s.nudges; d.aborts += s.aborts;
    days.set(key, d);
  }
  return [...days.values()].sort((a, b) => (a.key < b.key ? -1 : 1)).slice(-maxDays);
}

/** 0 -> 1, 53.9k -> 60k, 83 -> 100: the next round value, so axes end on a number and bars fill the plot. */
const NICE = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
function niceMax(v) {
  if (!(v > 0) || !Number.isFinite(v)) return 1;
  const e = 10 ** Math.floor(Math.log10(v));
  const f = v / e;
  return NICE.find((n) => f <= n + 1e-9) * e;
}

const M = { left: 40, right: 6, top: 6, bottom: 22 };
const plotBox = (width, height) => ({ x0: M.left, y0: M.top, w: Math.max(10, width - M.left - M.right), h: Math.max(10, height - M.top - M.bottom) });
const yTicks = (box, max, fmt) => [0, 0.5, 1].map((f) => ({ y: round(box.y0 + box.h - f * box.h), label: fmt(max * f), value: max * f }));
const round = (n) => Math.round(n * 100) / 100;

/**
 * Stacked columns. items: [{label, title, parts: {key: value}, marker?: bool, gap?: bool}], `order` is
 * bottom -> top. Returns coordinates only; a segment's height is exactly value / max of the plot.
 */
function layoutColumns(items, { width, height, order = STACK, fmt = fmtTokens } = {}) {
  const box = plotBox(width, height);
  const totals = items.map((it) => order.reduce((a, k) => a + (finite(it.parts?.[k]) > 0 ? it.parts[k] : 0), 0));
  const max = niceMax(Math.max(0, ...totals));
  const slot = box.w / Math.max(1, items.length);
  const bw = Math.min(slot, Math.max(1.5, Math.min(22, slot * 0.72)));       // never wider than its slot
  const columns = items.map((it, i) => {
    const x = round(box.x0 + slot * i + (slot - bw) / 2);
    let acc = 0;
    const segments = [];
    for (const key of order) {
      const v = finite(it.parts?.[key]);
      if (!(v > 0)) continue;
      const h = (v / max) * box.h;
      acc += v;
      segments.push({ key, value: v, h: round(h), y: round(box.y0 + box.h - (acc / max) * box.h) });
    }
    return { x, w: round(bw), cx: round(x + bw / 2), label: it.label, title: it.title, marker: it.marker === true, gap: it.gap === true, total: totals[i], segments };
  });
  return { box, max, columns, yTicks: yTicks(box, max, fmt), xLabels: columnLabels(columns), baseline: round(box.y0 + box.h) };
}

/** Few columns get a label each (repeats next to each other are dropped); many get only the first and last. */
function columnLabels(columns) {
  const last = columns.length - 1;
  if (last < 0) return [];
  const anchor = (i) => (i === 0 ? 'start' : i === last ? 'end' : 'middle');
  if (columns.length > 8) return [{ x: columns[0].cx, text: columns[0].label, anchor: 'start' }, { x: columns[last].cx, text: columns[last].label, anchor: 'end' }];
  const out = [];
  columns.forEach((c, i) => { if (i === 0 || c.label !== columns[i - 1].label) out.push({ x: c.cx, text: c.label, anchor: anchor(i) }); });
  return out;
}

/** A 0..1 series as polylines: a null value breaks the line instead of being drawn as zero. */
function layoutLine(values, { width, height, fmt = (v) => `${Math.round(v * 100)}%` } = {}) {
  const box = plotBox(width, height);
  const slot = box.w / Math.max(1, values.length);
  const points = values.map((v, i) => (finite(v) === null ? null : { i, v, x: round(box.x0 + slot * i + slot / 2), y: round(box.y0 + box.h * (1 - Math.min(1, Math.max(0, v)))) }));
  const lines = [];
  let cur = [];
  for (const p of points) {
    if (p === null) { if (cur.length) lines.push(cur); cur = []; } else cur.push(p);
  }
  if (cur.length) lines.push(cur);
  return { box, points: points.filter(Boolean), lines, yTicks: [0, 0.5, 1].map((f) => ({ y: round(box.y0 + box.h * (1 - f)), label: fmt(f) })), baseline: round(box.y0 + box.h), slot };
}

/** Session rows -> columns for the "per session" chart. */
function sessionColumns(sessions) {
  return sessions.map((s) => ({
    label: dayLabel(dayKey(s.started)), marker: s.injected, gap: !s.priced, parts: s.parts,
    title: `${fmtWhen(s.started)}${s.model ? ` · ${s.model}` : ''}\n${s.priced ? `${fmtTokens(s.effective)} effective tokens` : 'not priced'}${s.overhead ? ` + ${fmtTokens(s.overhead)} overhead` : ''}\n${s.requests} requests · ${s.turns} turns${s.nudges || s.aborts ? ` · ${s.nudges} redirect(s), ${s.aborts} still-stuck` : ''}${s.injected ? '\nfacts injected' : ''}`,
  }));
}

/** Day groups -> columns for the "per day" chart. */
function dayColumns(days) {
  return days.map((d) => ({ label: dayLabel(d.key), parts: { effective: d.effective, overhead: d.overhead }, title: `${d.key}\n${fmtTokens(d.effective)} effective tokens${d.overhead ? ` + ${fmtTokens(d.overhead)} overhead` : ''}\n${d.sessions} session(s)` }));
}

/** Facts for the chart captions, from the shown sessions. */
function summarize(sessions) {
  const hits = sessions.map((s) => s.cacheHit).filter((v) => v !== null);
  const priced = sessions.filter((s) => s.priced);
  return {
    count: sessions.length, priced: priced.length,
    median: priced.length ? median(priced.map((s) => s.effective)) : null,
    meanHit: hits.length ? hits.reduce((a, b) => a + b, 0) / hits.length : null,
    nudges: sessions.reduce((a, s) => a + s.nudges, 0), aborts: sessions.reduce((a, s) => a + s.aborts, 0),
    injected: sessions.filter((s) => s.injected).length,
  };
}
function median(v) {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const DAY_ORDER = ['effective', 'overhead'];
const REDIRECT_ORDER = ['nudges', 'aborts'];

module.exports = { DAY_ORDER, REDIRECT_ORDER, RANGES, DEFAULT_RANGE, STACK, LABELS, COLORS, fmtWhen, dayKey, dayLabel, normalizeSessions, sliceRange, groupByDay, niceMax, layoutColumns, layoutLine, sessionColumns, dayColumns, summarize };
