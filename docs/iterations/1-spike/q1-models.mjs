#!/usr/bin/env node
// Q1 (models): which provider/model pairs are callable with the headless profile's credentials?
//   node docs/iterations/1-spike/q1-models.mjs
// Starts an isolated dsh web, creates one blank session over the HTTP RPC (that opens the plugin's endpoint),
// then POSTs /v1/complete with {"prompt":"Reply with the single word: pong","model":"<provider>/<model>","maxTokens":32}
// for every model of the headless profile's llm-pi-ai config (one tiny call each). No browser.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { freshWork, startWeb, sleep, live } from './lib.mjs';

const work = freshWork('te-spike1-q1m');
const { server, url, home, state } = await startWeb(work);
try {
  const origin = new URL(url).origin;
  const r0 = await fetch(`${origin}/${new URL(url).search}`, { redirect: 'manual' });
  const cookie = r0.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const rpc = async (method, args) => (await (await fetch(`${origin}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }) })).json()).result;
  const ws = await rpc('workspace/initializeDefault', {});
  const wsId = JSON.stringify(ws).match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0];
  const created = await rpc('session/create', { request: { workspaceId: wsId } });
  console.log('session/create ok:', created?.ok, created?.value?.sessionId);
  const file = await live.waitFor(() => live.endpointFiles(state)[0], 20000, 300);
  const ep = JSON.parse(readFileSync(join(state, 'hosts', 'dsh', file), 'utf8'));
  const catalog = await rpc('session/modelCatalog', {});
  console.log('session/modelCatalog providers:', JSON.stringify((catalog?.value?.providers ?? catalog?.value?.groups ?? []).map((g) => `${g.id}:${(g.models ?? []).map((m) => m.id).join('|')}`)), 'keys', Object.keys(catalog?.value ?? {}));
  const models = ['azure-openai-responses/gpt-6-luna', 'azure-openai-responses/gpt-6-sol', 'azure-openai-responses/DeepSeek-V4-Pro', 'azure-openai-responses/DeepSeek-V4.1-Flash', 'azure-openai-responses/grok-4.7', 'azure-completitions/MAI-Thinking-1', 'anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5-5', 'anthropic/claude-haiku-5-5'];
  for (const model of models) {
    const t0 = Date.now();
    const res = await fetch(`http://127.0.0.1:${ep.port}/v1/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.token}`, Host: `127.0.0.1:${ep.port}` }, body: JSON.stringify({ prompt: 'Reply with the single word: pong', model, maxTokens: 32 }), signal: AbortSignal.timeout(120000) });
    const j = await res.json();
    console.log(`${model}: HTTP ${res.status} ${j.error ? `error ${j.error.code} ${live.redact(j.error.message).slice(0, 90)}` : `-> ${j.provider}/${j.model} "${(j.text ?? '').trim().slice(0, 20)}"`} (${Date.now() - t0} ms)`);
  }
} finally { server.kill('SIGTERM'); await sleep(1500); }
