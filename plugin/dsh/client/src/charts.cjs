'use strict';
// SVG renderers over series.cjs's geometry. No chart library: a few <rect>/<polyline> elements, fonts
// at a fixed pixel size (the width comes from the real container, so a narrow sidebar is not scaled down).
const S = require('./series.cjs');

const GRID = { stroke: 'currentColor', strokeOpacity: 0.14, strokeWidth: 1 };
const TEXT = { fill: 'currentColor', fillOpacity: 0.65, fontSize: 10, fontFamily: 'inherit' };

function createCharts(React) {
  const h = React.createElement;

  const Axes = ({ g, grid }) => h('g', null,
    ...g.yTicks.map((t, i) => h('g', { key: `y${i}` },
      grid ? h('line', { x1: g.box.x0, x2: g.box.x0 + g.box.w, y1: t.y, y2: t.y, ...GRID }) : null,
      h('text', { x: g.box.x0 - 4, y: t.y + 3, textAnchor: 'end', ...TEXT }, t.label))),
    h('line', { key: 'base', x1: g.box.x0, x2: g.box.x0 + g.box.w, y1: g.baseline, y2: g.baseline, ...GRID, strokeOpacity: 0.3 }));

  /** Stacked columns; `colors` maps a part key to a colour. `data-te-bars` counts the columns for tests. */
  function Columns({ items, width, height = 150, order = S.STACK, colors = S.COLORS, fmt, label }) {
    const g = S.layoutColumns(items, { width, height, order, fmt });
    return h('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': label, style: { display: 'block', overflow: 'visible' }, 'data-te-chart': 'columns', 'data-te-bars': g.columns.length },
      h(Axes, { g, grid: true }),
      ...g.columns.map((c, i) => h('g', { key: i, 'data-te-bar': i },
        h('title', null, c.title ?? c.label),
        // A wide invisible target keeps the tooltip reachable on thin bars.
        h('rect', { x: c.x - 1, y: g.box.y0, width: c.w + 2, height: g.box.h, fill: 'transparent' }),
        ...c.segments.map((s) => h('rect', { key: s.key, x: c.x, y: s.y, width: c.w, height: Math.max(0.5, s.h), fill: colors[s.key], rx: c.w > 6 ? 1.5 : 0, 'data-te-seg': s.key, 'data-te-value': s.value })),
        c.gap ? h('path', { d: `M${c.cx - 2} ${g.baseline - 5} l4 4 m0 -4 l-4 4`, stroke: 'currentColor', strokeOpacity: 0.5, fill: 'none' }) : null,
        c.marker ? h('circle', { cx: c.cx, cy: g.baseline + 8, r: 2.5, fill: S.COLORS.hit, 'data-te-marker': i }) : null)),
      ...g.xLabels.map((l, i) => h('text', { key: `x${i}`, x: l.x, y: g.baseline + 19, textAnchor: l.anchor, ...TEXT }, l.text)));
  }

  /** A 0..100% line with gaps where the value is unknown. */
  function Line({ values, width, height = 90, color = S.COLORS.hit, label, titles = [] }) {
    const g = S.layoutLine(values, { width, height });
    return h('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': label, style: { display: 'block', overflow: 'visible' }, 'data-te-chart': 'line', 'data-te-points': g.points.length },
      h(Axes, { g, grid: true }),
      ...g.lines.filter((l) => l.length > 1).map((l, i) => h('polyline', { key: `l${i}`, points: l.map((p) => `${p.x},${p.y}`).join(' '), fill: 'none', stroke: color, strokeWidth: 1.5, strokeLinejoin: 'round' })),
      ...g.points.map((p) => h('circle', { key: `p${p.i}`, cx: p.x, cy: p.y, r: g.slot > 8 ? 2.5 : 1.5, fill: color }, h('title', null, titles[p.i] ?? `${Math.round(p.v * 100)}%`))));
  }

  const Legend = ({ keys, colors = S.COLORS, labels = S.LABELS }) => h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 12px', fontSize: 11, opacity: 0.8 }, 'data-te': 'legend' },
    ...keys.map((k) => h('span', { key: k, style: { display: 'inline-flex', alignItems: 'center', gap: 5 } }, h('span', { style: { width: 9, height: 9, borderRadius: 2, background: colors[k], display: 'inline-block' } }), labels[k] ?? k)));

  /** Hands its child the real pixel width of the container (stays put while the sidebar is resized). */
  function Sized({ children, fallback = 320 }) {
    const ref = React.useRef(null);
    const [width, setWidth] = React.useState(fallback);
    React.useEffect(() => {
      const el = ref.current;
      if (!el || typeof ResizeObserver === 'undefined') return undefined;
      const read = () => { const w = Math.floor(el.getBoundingClientRect().width); if (w > 40) setWidth(w); };
      read();
      const ro = new ResizeObserver(read);
      ro.observe(el);
      return () => ro.disconnect();
    }, []);
    return h('div', { ref, style: { width: '100%', minWidth: 0 } }, children(width));
  }

  return { Columns, Line, Legend, Sized };
}

module.exports = { createCharts };
