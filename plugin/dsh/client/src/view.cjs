'use strict';
// The panel's look: pure functions from view state to an element tree, plus the one stateful
// wrapper. Inline styles over DSH's own colour variables only; no stylesheet of ours.
const { toViewState, fmtTokens, fmtPct } = require('./model.cjs');
const D = require('./series.cjs');
const { createCharts } = require('./charts.cjs');

const S = {
  root: { padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 14, fontSize: 13, lineHeight: 1.45, overflow: 'auto', height: '100%', boxSizing: 'border-box' },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  title: { fontWeight: 600, fontSize: 14 },
  muted: { opacity: 0.65 },
  card: { border: '1px solid color-mix(in srgb, currentColor 14%, transparent)', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 },
  row: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  big: { fontSize: 20, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 },
  pill: { fontSize: 11, padding: '1px 8px', borderRadius: 999, border: '1px solid color-mix(in srgb, currentColor 22%, transparent)' },
  warn: { borderColor: 'color-mix(in srgb, #d9822b 55%, transparent)' },
  err: { borderColor: 'color-mix(in srgb, #d14343 55%, transparent)' },
  section: { display: 'flex', flexDirection: 'column', gap: 10 },
  h2: { fontWeight: 600, fontSize: 13 },
  small: { fontSize: 11, opacity: 0.65 },
  btnOn: { background: 'color-mix(in srgb, currentColor 14%, transparent)' },
  btn: { font: 'inherit', fontSize: 12, padding: '3px 10px', borderRadius: 6, border: '1px solid color-mix(in srgb, currentColor 22%, transparent)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
};

function createViews(React) {
  const h = React.createElement;

  const Stat = ({ name, value, hint }) =>
    h('div', { style: S.card, 'data-te': `stat-${name}` }, h('div', { style: S.muted }, name), h('div', { style: S.big }, value), hint ? h('div', { style: { ...S.muted, fontSize: 11 } }, hint) : null);

  const Mechanism = ({ m }) =>
    h('div', { style: S.card, 'data-te': `mechanism-${m.key}` },
      h('div', { style: S.row }, h('span', { style: { fontWeight: 600 } }, m.title), h('span', { style: S.pill }, m.mode)),
      h('div', { style: { ...S.muted, fontSize: 12 } }, m.detail));

  const { Columns, Line, Legend, Sized } = createCharts(React);

  const Titled = ({ name, title, caption, children }) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 }, 'data-te': `chart-${name}` },
    h('div', { style: S.row }, h('span', { style: { fontWeight: 600, fontSize: 12 } }, title), caption ? h('span', { style: S.small }, caption) : null), children);

  /** Recorded history: cost per session, cache hit rate, per day, redirects. */
  function History({ sessions, range, onRange }) {
    const shown = D.sliceRange(sessions, range);
    const sum = D.summarize(shown);
    const days = D.groupByDay(shown);
    const cols = D.sessionColumns(shown);
    const used = D.STACK.filter((k) => cols.some((c) => c.parts[k] > 0));
    const hits = shown.map((s) => s.cacheHit);
    const hitTitles = shown.map((s) => `${D.fmtWhen(s.started)}\ncache hit ${fmtPct(s.cacheHit)}`);
    const redirects = shown.map((s) => ({ label: D.dayLabel(D.dayKey(s.started)), parts: { nudges: s.nudges, aborts: s.aborts }, title: `${D.fmtWhen(s.started)}\n${s.nudges} redirect(s), ${s.aborts} still-stuck` }));
    return h('div', { style: S.section, 'data-te': 'history' },
      h('div', { style: S.row },
        h('span', { style: S.h2 }, 'History'),
        h('span', { style: { display: 'inline-flex', gap: 4 }, role: 'group', 'aria-label': 'Range' },
          ...D.RANGES.map((r) => h('button', { key: r.id, type: 'button', style: { ...S.btn, ...(r.id === range ? S.btnOn : null) }, 'aria-pressed': r.id === range, onClick: () => onRange(r.id), 'data-te': `range-${r.id}` }, r.label)))),
      h('div', { style: S.small, 'data-te': 'history-caption' },
        `${shown.length} of ${sessions.length} session(s)` + (sum.median !== null ? ` · median ${fmtTokens(sum.median)} each` : '') + (sum.meanHit !== null ? ` · cache hit ${fmtPct(sum.meanHit)} on average` : '') + (sum.injected ? ` · facts injected in ${sum.injected}` : '')),
      h(Titled, { name: 'sessions', title: 'Effective tokens per session', caption: sum.injected ? '● facts injected' : '' },
        h(Sized, null, (w) => h(Columns, { items: cols, width: w, label: `Effective tokens for each of the last ${shown.length} sessions, stacked by part` })),
        h(Legend, { keys: used })),
      hits.filter((v) => v !== null).length >= 2
        ? h(Titled, { name: 'cache', title: 'Cache hit rate', caption: 'share of prompt tokens read from the cache' },
          h(Sized, null, (w) => h(Line, { values: hits, width: w, titles: hitTitles, label: 'Cache hit rate for each session' })))
        : null,
      days.length >= 2
        ? h(Titled, { name: 'days', title: 'Per day', caption: 'effective tokens' },
          h(Sized, null, (w) => h(Columns, { items: D.dayColumns(days), width: w, height: 110, order: D.DAY_ORDER, label: 'Effective tokens for each day' })),
          h(Legend, { keys: ['effective', 'overhead'] }))
        : null,
      sum.nudges + sum.aborts > 0
        ? h(Titled, { name: 'redirects', title: 'Loop guard', caption: `${sum.nudges} redirect(s), ${sum.aborts} still-stuck` },
          h(Sized, null, (w) => h(Columns, { items: redirects, width: w, height: 80, order: D.REDIRECT_ORDER, fmt: D.countFmt, label: 'Loop guard redirects for each session' })),
          h(Legend, { keys: ['nudges', 'aborts'] }))
        : null,
      h('div', { style: { ...S.small, fontSize: 10.5 }, 'data-te': 'history-note' }, 'Recorded values only. The ledger has no run without the plugin to compare with, so no saving is estimated here.'));
  }

  /** `view` is a state from toViewState, or {state: 'loading'}. */
  function StatusView({ view, onRefresh, range = D.DEFAULT_RANGE, onRange = () => {} }) {
    const head = h('div', { style: S.head },
      h('span', { style: S.title }, 'TokenEconomizer'),
      h('button', { type: 'button', style: S.btn, onClick: onRefresh, disabled: view.state === 'loading', 'data-te': 'refresh' }, view.state === 'loading' ? 'Loading…' : 'Refresh'));
    if (view.state === 'loading') return h('div', { style: S.root, role: 'status', 'data-te': 'loading' }, head, h('div', { style: S.muted }, 'Reading the saved state…'));
    if (view.state === 'error') return h('div', { style: S.root, 'data-te': 'error' }, head, h('div', { style: { ...S.card, ...S.err }, role: 'alert' }, view.message));
    const m = view.model;
    const historySessions = D.normalizeSessions(view.series);
    return h('div', { style: S.root, 'data-te': 'ready' },
      head,
      h('div', { style: S.muted }, `${m.repo} · ${m.host}${m.enabled ? '' : ' · turned off'}${m.shadow ? ' · shadow mode' : ''}`),
      m.note ? h('div', { style: S.card }, m.note) : null,
      ...m.warnings.map((w, i) => h('div', { key: `w${i}`, style: { ...S.card, ...S.warn }, 'data-te': 'warning' }, w)),
      m.ledger.empty
        ? h('div', { style: S.card, 'data-te': 'empty' }, 'No finished session has been folded into the ledger yet. Numbers appear after a session ends.')
        : h('div', { style: S.grid },
          h(Stat, { name: 'Sessions', value: String(m.ledger.sessions), hint: `${m.ledger.priced} priced` }),
          h(Stat, { name: 'Effective tokens', value: m.ledger.effective, hint: `${m.ledger.requests} requests · ${m.ledger.turns} turns` }),
          h(Stat, { name: 'Plugin overhead', value: m.ledger.overhead, hint: `${m.ledger.overheadPct} of effective` })),
      historySessions.length > 0 ? h(History, { sessions: historySessions, range, onRange }) : null,
      ...m.mechanisms.map((x) => h(Mechanism, { key: x.key, m: x })));
  }

  /** Reads `/te panel --json` when it opens, when its session changes and when asked; never polls (each run is a logged command). */
  function createPanel(fetchStatus) {
    return function Panel({ sessionId } = {}) {
      const [view, setView] = React.useState({ state: 'loading' });
      const [range, setRange] = React.useState(D.DEFAULT_RANGE);      // a view setting: changing it re-draws, it does not re-run the command
      const load = React.useCallback(() => {
        setView({ state: 'loading' });
        let alive = true;
        Promise.resolve()
          .then(() => fetchStatus(sessionId))
          .then((exec) => alive && setView(toViewState(exec)), (err) => alive && setView({ state: 'error', message: String(err?.message ?? err) }));
        return () => { alive = false; };
      }, [sessionId]);
      React.useEffect(() => load(), [load]);
      return h(StatusView, { view, onRefresh: load, range, onRange: setRange });
    };
  }

  return { StatusView, createPanel };
}

module.exports = { createViews, S };
