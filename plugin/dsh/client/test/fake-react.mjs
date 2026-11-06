// A just-enough React for rendering pure view functions into plain objects, and for hooks that
// run once per call to `render`: enough to test what the panel draws, not React itself.
export function fakeReact() {
  const slots = [];
  let cursor = 0;
  let effects = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }),
    useState(init) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = init;
      return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }];
    },
    useCallback: (fn) => fn,
    useEffect(fn) { effects.push(fn); },
  };
  return {
    react,
    render(component, props) { cursor = 0; effects = []; return component(props); },
    flushEffects() { const run = effects; effects = []; return run.map((f) => f()); },
  };
}

/** Flatten an element tree to its text. */
export const textOf = (n) => {
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (!n) return '';
  if (typeof n.type === 'function') return textOf(n.type(n.props));      // a component: draw it
  return [].concat(n.children ?? []).map(textOf).join(' ');
};
/** Find every element carrying a data-te marker. */
export function marked(n, out = []) {
  if (n && typeof n === 'object') {
    if (n.props?.['data-te']) out.push(n);
    for (const c of n.children ?? []) marked(c, out);
    if (typeof n.type === 'function') marked(n.type(n.props), out);
  }
  return out;
}
