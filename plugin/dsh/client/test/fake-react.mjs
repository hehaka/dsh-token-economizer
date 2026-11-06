// A just-enough React for rendering pure view functions into plain objects, and for hooks that
// run once per call to `render`: enough to test what the panel draws, not React itself.
export function fakeReact() {
  const slots = [];
  let cursor = 0;
  let effects = [];
  const react = {
    createElement(type, props, ...children) {
      const kids = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false);
      const p = { ...(props ?? {}) };
      if (kids.length) p.children = kids.length === 1 ? kids[0] : kids;      // as React merges them
      return { type, props: p, children: kids };
    },
    useState(init) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = init;
      return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }];
    },
    useRef(init) { const i = cursor++; if (!(i in slots)) slots[i] = { current: init ?? null }; return slots[i]; },
    useCallback(fn, deps) { fn.deps = deps; return fn; },          // deps are kept so a test can see what re-runs a command
    useEffect(fn) { effects.push(fn); },
  };
  return {
    react,
    render(component, props) { cursor = 0; effects = []; return component(props); },
    flushEffects() { const run = effects; effects = []; return run.map((f) => f()); },
  };
}

/** Visit every element, drawing function components and calling render-prop children as React would. */
export function walk(n, visit) {
  if (n === null || n === undefined || typeof n === 'string' || typeof n === 'number') return;
  if (Array.isArray(n)) { n.forEach((c) => walk(c, visit)); return; }
  if (typeof n === 'function') return;
  visit(n);
  if (typeof n.type === 'function') {
    const kids = n.props.children;
    const out = n.type(typeof kids === 'function' ? { ...n.props, children: kids } : n.props);
    walk(out, visit);
    return;
  }
  for (const c of n.children ?? []) walk(typeof c === 'function' ? c(320) : c, visit);
}

/** Flatten an element tree to its text. */
export function textOf(n) {
  const out = [];
  const collect = (x) => {
    if (typeof x === 'string' || typeof x === 'number') out.push(String(x));
  };
  (function go(x) {
    if (x === null || x === undefined) return;
    if (typeof x === 'string' || typeof x === 'number') return collect(x);
    if (Array.isArray(x)) return x.forEach(go);
    if (typeof x === 'function') return;
    if (typeof x.type === 'function') return go(x.type(x.props));
    for (const c of x.children ?? []) go(typeof c === 'function' ? c(320) : c);
  })(n);
  return out.join(' ');
}

/** Every element carrying a data-te marker. */
export function marked(n) { const out = []; walk(n, (e) => { if (e.props?.['data-te']) out.push(e); }); return out; }
/** Every element matching a predicate on its props/type. */
export function findAll(n, pred) { const out = []; walk(n, (e) => { if (pred(e)) out.push(e); }); return out; }
