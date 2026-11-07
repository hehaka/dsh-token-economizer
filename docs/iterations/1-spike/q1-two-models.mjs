#!/usr/bin/env node
// Q1: two sessions on DIFFERENT models in ONE `dsh web` process.
//   node docs/iterations/1-spike/q1-two-models.mjs
// Session A: created by the web UI (CDP), model picked in the UI picker (GPT-6 Luna); one tiny prompt.
// Session B: created through the server's HTTP RPC (/api/session/create, /api/session/selectModel, /api/session/prompt)
//            with a cookie obtained from the launch token; model anthropic/claude-sonnet-5-5; one tiny prompt.
// Then: the plugin's spool file names, the endpoint file, POST /v1/complete per session id (+ unknown id, + no id).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { launch } from '../../../plugin/dsh/client/test/browser/cdp.mjs';
import { freshWork, startWeb, sleep, live } from './lib.mjs';

const work = freshWork('te-spike1-q1');
const { server, url, home, state } = await startWeb(work);
process.env.DSH_HOME = home;                                   // the session-log helpers read it
const origin = new URL(url).origin;
const show = (tag, v) => console.log(`${tag}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

// ---- session A: the UI -----------------------------------------------------------------------------
const browser = await launch({ port: 9400 + Math.floor(Math.random() * 400) });
const cleanup = () => { try { server.kill('SIGTERM'); } catch {} try { browser.close(); } catch {} };
process.on('uncaughtException', (e) => { console.log('ERROR', e.message.slice(0, 300)); cleanup(); setTimeout(() => process.exit(1), 1500); });
process.on('unhandledRejection', (e) => { console.log('ERROR', String(e?.message ?? e).slice(0, 300)); cleanup(); setTimeout(() => process.exit(1), 1500); });
await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{window.__net=[];const F=window.fetch;window.fetch=function(u,o){window.__net.push((o&&o.method||'GET')+' '+String(u&&u.url||u)+' '+(o&&typeof o.body==='string'?o.body:'').slice(0,600));return F.apply(this,arguments)};})()` });
await browser.goto(url);
await browser.waitFor("document.body.innerText.includes('Standard mode')", { label: 'app shell' });
await sleep(2000);
const pointClick = async (text, { last = true } = {}) => {
  const pt = await browser.evaluate(`(()=>{const els=[...document.querySelectorAll('[role=menuitemradio],body *')].filter(x=>(x.children.length===0||x.getAttribute('role')==='menuitemradio')&&x.innerText&&x.innerText.trim()===${JSON.stringify(text)}&&x.getBoundingClientRect().width>0);const e=els[${last}?els.length-1:0];if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  if (!pt) return false;
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await browser.send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  return true;
};
if (await browser.evaluate("!![...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='Continue')")) { await pointClick('Continue'); await sleep(800); }
await browser.evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(x=>/^Select model/.test(x.getAttribute('aria-label')||''));e&&e.click()})()`);
await sleep(700);
show('UI: clicked Model row', await pointClick('Model'));
await sleep(900);
show('UI: clicked GPT-6 Luna', await pointClick('GPT-6 Luna'));
await sleep(900);
show('UI: picker label now', await browser.evaluate("[...document.querySelectorAll('button')].map(b=>b.getAttribute('aria-label')||'').find(l=>/^Select model/.test(l))"));
await browser.evaluate("document.querySelector('[role=textbox]').focus()");
await browser.send('Input.insertText', { text: 'Reply with the single word ok' });
await sleep(600);
await browser.evaluate("document.querySelector('[aria-label=\"Send message\"]').click()");
await browser.waitFor("!document.body.innerText.includes('Into the Unknown')", { timeout: 45000, label: 'session view' });
const sidA = await live.waitFor(() => live.spoolIds(state)[0], 90_000, 500);
show('session A (spool file name = session id)', sidA);
const net = await browser.evaluate('window.__net');
for (const n of net.filter((x) => /session\/(create|selectModel|prompt)|workspace\/initializeDefault/.test(x))) show('UI rpc', n.replace(/"text":"[^"]{0,80}"/, '"text":"<prompt>"'));
const turnEnd = (sid) => live.waitFor(() => { try { return live.readSessionEvents(sid).some((e) => e.type === 'turn/end'); } catch { return false; } }, 120_000, 1000);
show('A turn ended', Boolean(await turnEnd(sidA)));

const epInfo = () => { const f = live.endpointFiles(state); return JSON.parse(readFileSync(join(state, 'hosts', 'dsh', f[0]), 'utf8')); };
const post = async (body) => {
  const ep = epInfo();
  const res = await fetch(`http://127.0.0.1:${ep.port}/v1/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.token}`, Host: `127.0.0.1:${ep.port}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  const j = await res.json();
  return { status: res.status, provider: j.provider, model: j.model, text: (j.text ?? '').slice(0, 40), error: j.error?.code };
};
// ---- session B: the HTTP RPC ---------------------------------------------------------------------------
const r0 = await fetch(`${origin}/${new URL(url).search}`, { redirect: 'manual' });
const cookie = r0.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
show('launch-token exchange', `HTTP ${r0.status}, cookie set: ${cookie.length > 0}`);
const rpc = async (method, args) => {
  const res = await fetch(`${origin}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }) });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
  return { status: res.status, body };
};
const ws = net.map((x) => /"workspaceId":"([^"]+)"/.exec(x)?.[1]).find(Boolean);
show('workspaceId from UI create call', ws);
const created = await rpc('session/create', { request: { workspaceId: ws } });
show('API session/create', created);
const sidB = created.body?.value?.sessionId ?? created.body?.payload?.value?.sessionId ?? JSON.stringify(created.body).match(/session-[0-9a-f-]{36}/)?.[0];
show('session B id', sidB);
show('API session/selectModel', await rpc('session/selectModel', { request: { sessionId: sidB, provider: 'anthropic', model: 'claude-sonnet-5-5' } }));
show('POST B after selectModel, BEFORE its first request (spool id of B does not exist yet)', await post({ prompt: 'Reply with the single word: pong', session: sidB }));
show('API session/prompt', await rpc('session/prompt', { request: { sessionId: sidB, requestId: randomUUID(), content: [{ type: 'text', text: 'Reply with the single word ok' }], mode: 'queue', clientTimeZone: 'Europe/Warsaw' } }));
await live.waitFor(() => live.spoolIds(state).includes(sidB), 60_000, 500);
show('B turn ended', Boolean(await turnEnd(sidB)));

// ---- what DSH logged, what the plugin has ------------------------------------------------------------------
for (const [tag, sid] of [['A', sidA], ['B', sidB]]) {
  const ev = live.readSessionEvents(sid);
  const rc = ev.find((e) => e.type === 'request/context')?.data ?? {};
  const created = ev.find((e) => e.type === 'agent/created');
  const sel = ev.filter((e) => e.type === 'model/selection').map((e) => `${e.data?.provider}/${e.data?.model}`);
  show(`log ${tag} request/context`, `${rc.provider}/${rc.model}`);
  show(`log ${tag} model/selection events`, sel);
  show(`log ${tag} answer`, JSON.stringify(ev.filter((e) => e.type === 'assistant/message').map((e) => (e.data?.message?.content ?? []).map((b) => b.text).join('')).slice(-1)));
}
show('spool ids', live.spoolIds(state));
show('endpoint files', live.endpointFiles(state));
const ep = epInfo();
const prompt = 'Reply with the single word: pong';
show('endpoint file keys', Object.keys(ep).sort());
show('POST session A', await post({ prompt, session: sidA }));
show('POST session B', await post({ prompt, session: sidB }));
show('POST unknown session', await post({ prompt, session: 'session-does-not-exist' }));
show('POST no session (last observed route)', await post({ prompt }));
await browser.close();
server.kill('SIGTERM');
await sleep(2500);
show('endpoint files after SIGTERM', live.endpointFiles(state));
