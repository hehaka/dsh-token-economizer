// Spike diagnostic (not part of the plugin): what does `agent/created` carry about the route?
// Logs JSON lines to $TE_DIAG_LOG. Never logs values of keys named key/secret/token/credential.
import { appendFileSync } from 'node:fs';
const L = process.env.TE_DIAG_LOG;
let n = 0;
const out = (kind, data) => appendFileSync(L, `${JSON.stringify({ n: ++n, t: Date.now(), kind, ...data })}\n`);
const SECRET = /key|secret|token|credential|password/i;
const WANT = /model|provider/i;
// keys with typeof, without triggering getters (a service getter on ctx throws when not injected)
function shape(o) {
  if (o === null || (typeof o !== 'object' && typeof o !== 'function')) return typeof o;
  const r = {};
  let keys = [];
  try { keys = Object.keys(o).slice(0, 200); } catch { return 'unlistable'; }
  for (const k of keys) {
    const d = Object.getOwnPropertyDescriptor(o, k);
    r[k] = d && 'value' in d ? (d.value === null ? 'null' : Array.isArray(d.value) ? 'array' : typeof d.value) : 'accessor';
  }
  return r;
}
const shape2 = (o) => {
  const r = { _self: shape(o) };
  if (!o || typeof o !== 'object') return r;
  for (const k of Object.keys(o).slice(0, 200)) {
    const d = Object.getOwnPropertyDescriptor(o, k);
    if (d && 'value' in d && d.value && typeof d.value === 'object' && !SECRET.test(k)) r[k] = shape(d.value);
  }
  return r;
};
// string values of keys named *model*/*provider* (never secret-ish), depth-limited, cycle-safe
function scan(o, path, depth, seen, acc) {
  if (!o || typeof o !== 'object' || depth < 0 || seen.has(o)) return acc;
  seen.add(o);
  let keys = [];
  try { keys = Object.keys(o).slice(0, 100); } catch { return acc; }
  for (const k of keys) {
    if (SECRET.test(k)) continue;
    const d = Object.getOwnPropertyDescriptor(o, k);
    if (!d || !('value' in d)) continue;
    if (WANT.test(k) && typeof d.value === 'string') acc[`${path}.${k}`] = d.value;
    else if (d.value && typeof d.value === 'object' && !(k === 'ctx')) scan(d.value, `${path}.${k}`, depth - 1, seen, acc);
  }
  return acc;
}
export const name = 'te-route-diag';
export function apply(ctx) {
  out('loaded', {});
  let defaultModel;
  let llmSvc;
  ctx.inject(['agentDefaultModel'], (c) => {
    defaultModel = c.agentDefaultModel;
    out('service', { name: 'agentDefaultModel', present: true, methods: Object.getOwnPropertyNames(Object.getPrototypeOf(defaultModel)) });
  });
  ctx.inject(['llm'], (c) => {
    llmSvc = c.llm;
    const proto = Object.getPrototypeOf(llmSvc);
    out('service', { name: 'llm', present: true, methods: Object.getOwnPropertyNames(proto).filter((x) => x !== 'constructor') });
  });
  ctx.on('session/created', (session) => {
    const h = session?.header;
    out('session/created', { headerKeys: shape(h), modelish: scan({ session }, 'session', 4, new Set(), {}), parentSession: h?.parentSession ?? null, origin: h?.origin ?? null });
  });
  ctx.on('agent/created', ({ agent, source } = {}) => {
    try {
      const rec = {
        source,
        agent: shape2(agent),
        options: shape(agent?.options),
        optionsModelish: scan(agent?.options, 'agent.options', 2, new Set(), {}),
        session: shape(agent?.session),
        sessionHeader: shape(agent?.session?.header),
        header: { origin: agent?.session?.header?.origin ?? null, parentSession: agent?.session?.header?.parentSession ?? null, isSeeded: agent?.session?.header?.isSeeded ?? null },
        ctx: shape(agent?.ctx),
        modelish: scan({ agent }, 'agent', 4, new Set(), {}),
      };
      try {
        rec.defaultSelection = defaultModel ? defaultModel.currentSelection() : 'service-not-injected-yet';
      } catch (e) { rec.defaultSelection = `error: ${e?.message}`; }
      rec.llmPresent = Boolean(llmSvc);
      out('agent/created', rec);
    } catch (e) { out('error', { message: String(e?.stack ?? e) }); }
  });
  ctx.on('session/event', (session, event) => {
    const t = event?.type;
    const rec = { type: t, session: session?.header?.sessionId ?? session?.id ?? null };
    if (t === 'request/context' || t === 'request/header') rec.modelish = scan(event?.data, 'data', 3, new Set(), {});
    out('session/event', rec);
  });
}
