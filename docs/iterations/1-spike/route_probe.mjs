// Spike diagnostic plugin (not part of the product). Loaded AFTER the TokenEconomizer plugin via a --patch overlay.
// Logs JSON lines to $TE_PROBE_LOG: agent.options at agent/created, the route of request/context, and what the
// plugin's side-call endpoint answers (POST /v1/complete with this session's id) at agent/created and at turn end.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const L = process.env.TE_PROBE_LOG;
const TAG = process.env.TE_PROBE_TAG ?? '';
const out = (kind, data) => appendFileSync(L, `${JSON.stringify({ t: Date.now() % 100000, tag: TAG, kind, ...data })}\n`);
const stateRoot = process.env.TOKENECONOMIZER_HOME ?? join(homedir(), '.tokeneconomizer');

async function probe(when, sessionId) {
  const file = join(stateRoot, 'hosts', 'dsh', `sidecall.${process.pid}.endpoint.json`);
  for (let i = 0; i < 40 && !existsSync(file); i += 1) await new Promise((r) => setTimeout(r, 100));
  if (!existsSync(file)) return out('probe', { when, error: 'no endpoint file' });
  const ep = JSON.parse(readFileSync(file, 'utf8'));
  out('probe-sent', { when });
  try {
    const res = await fetch(`http://127.0.0.1:${ep.port}/v1/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.token}`, Host: `127.0.0.1:${ep.port}` },
      body: JSON.stringify({ prompt: 'Reply with the single word: pong', session: sessionId, maxTokens: 32 }), signal: AbortSignal.timeout(60000),
    });
    const j = await res.json();
    out('probe', { when, status: res.status, provider: j.provider, model: j.model, text: (j.text ?? '').trim().slice(0, 20), error: j.error?.code });
  } catch (e) { out('probe', { when, error: String(e).slice(0, 120) }); }
}

export const name = 'te-route-probe';
export function apply(ctx) {
  ctx.on('agent/created', async ({ agent } = {}) => {
    const id = agent?.session?.header?.id ?? agent?.id;
    out('agent/created', { session: id, options: { provider: agent?.options?.provider, model: agent?.options?.model } });
    if (process.env.TE_PROBE_DEFER) { setTimeout(() => probe('agent/created + 150 ms, handler not awaited (before the first request)', id), 150); return; }
    await probe('agent/created (before the first request)', id);
  });
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'request/context') out('request/context', { session: session?.id ?? session?.header?.id, provider: event.data?.provider, model: event.data?.model });
    if (event?.type === 'model/selection') out('model/selection', { provider: event.data?.provider, model: event.data?.model });
  });
  let done = false;
  ctx.on('agent/turn-stopping', async ({ agent } = {}) => {
    if (done) return;
    done = true;
    await probe('turn end (after the first request)', agent?.session?.header?.id ?? agent?.id);
  });
}
