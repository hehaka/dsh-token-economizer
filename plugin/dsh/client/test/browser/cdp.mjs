// A minimal Chrome DevTools Protocol client: launch headless Chrome, talk over the built-in
// WebSocket. No playwright/puppeteer, so the check runs anywhere Node 22 and Chrome exist.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);

export async function launch({ port = 9333 } = {}) {
  const { existsSync } = await import('node:fs');
  const bin = CANDIDATES.find((p) => existsSync(p));
  if (!bin) throw new Error('no Chrome/Chromium found (set CHROME_BIN)');
  const dir = mkdtempSync(join(tmpdir(), 'te-chrome-'));
  const proc = spawn(bin, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--window-size=1500,950', 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 60 && !targets; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { /* not up yet */ }
  }
  if (!targets) { proc.kill(); throw new Error('Chrome did not expose a debugging port'); }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const waiting = new Map();
  const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) { const w = waiting.get(msg.id); waiting.delete(msg.id); msg.error ? w.rej(new Error(msg.error.message)) : w.res(msg.result); }
    else for (const l of listeners) l(msg);
  };
  const send = (method, params = {}) => new Promise((res, rej) => { id += 1; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  const logs = [];
  listeners.push((m) => {
    if (m.method === 'Runtime.consoleAPICalled') logs.push({ type: m.params.type, text: m.params.args.map((a) => a.value ?? a.description ?? '').join(' ') });
    if (m.method === 'Runtime.exceptionThrown') logs.push({ type: 'exception', text: m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text });
  });
  await send('Runtime.enable'); await send('Page.enable');
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (expression, { timeout = 20000, label = expression } = {}) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { try { const v = await evaluate(expression); if (v) return v; } catch { /* page not ready */ } await new Promise((r) => setTimeout(r, 300)); }
    throw new Error(`timed out waiting for: ${label}`);
  };
  const screenshot = async (file) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    (await import('node:fs')).writeFileSync(file, Buffer.from(data, 'base64'));
  };
  return { send, evaluate, waitFor, screenshot, logs, goto: (url) => send('Page.navigate', { url }), async close() {
      try { ws.close(); } catch { /* */ }
      proc.kill();
      await new Promise((r) => setTimeout(r, 500));                         // let Chrome release its profile directory
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp dir; the OS reaps it */ }
    } };
}
