'use strict';
// The panel's look: pure functions from view state to an element tree, plus the one stateful
// wrapper. Inline styles over DSH's own colour variables only; no stylesheet of ours.
const { toViewState } = require('./model.cjs');

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

  /** `view` is a state from toViewState, or {state: 'loading'}. */
  function StatusView({ view, onRefresh }) {
    const head = h('div', { style: S.head },
      h('span', { style: S.title }, 'TokenEconomizer'),
      h('button', { type: 'button', style: S.btn, onClick: onRefresh, disabled: view.state === 'loading', 'data-te': 'refresh' }, view.state === 'loading' ? 'Loading…' : 'Refresh'));
    if (view.state === 'loading') return h('div', { style: S.root, role: 'status', 'data-te': 'loading' }, head, h('div', { style: S.muted }, 'Reading the saved state…'));
    if (view.state === 'error') return h('div', { style: S.root, 'data-te': 'error' }, head, h('div', { style: { ...S.card, ...S.err }, role: 'alert' }, view.message));
    const m = view.model;
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
      ...m.mechanisms.map((x) => h(Mechanism, { key: x.key, m: x })));
  }

  /** Reads `/te status --json` when it opens, when its session changes and when asked; never polls (each run is a logged command). */
  function createPanel(fetchStatus) {
    return function Panel({ sessionId } = {}) {
      const [view, setView] = React.useState({ state: 'loading' });
      const load = React.useCallback(() => {
        setView({ state: 'loading' });
        let alive = true;
        Promise.resolve()
          .then(() => fetchStatus(sessionId))
          .then((exec) => alive && setView(toViewState(exec)), (err) => alive && setView({ state: 'error', message: String(err?.message ?? err) }));
        return () => { alive = false; };
      }, [sessionId]);
      React.useEffect(() => load(), [load]);
      return h(StatusView, { view, onRefresh: load });
    };
  }

  return { StatusView, createPanel };
}

module.exports = { createViews, S };
