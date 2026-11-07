// The plugin's own model calls (the loop guard's judge and nudge writer, the micro-skills
// proposer) on DeepSeek Harness (docs/dsh/adr/0004). The core runs in Python, in a hook or in a
// detached job, with no way into DSH's model service, so the plugin answers for it: a loopback
// HTTP endpoint that takes a prompt, makes one call through `ctx.llm` (one attempt, no session
// history, as `session-title-llm` does) and returns the text and the token usage. The core prices
// the usage and charges its ledger; nothing is written to any session.
//
// Where it is: an endpoint file under the state root, named in `TE_DSH_SIDECALL_FILE` on every hook's
// environment (jobs a hook starts inherit it). Who may call: whoever reads that file (owner-only),
// with its token. What it costs the account: one request on the session's own route, or on
// `paid_model` (`provider/model`, or a model of the session's provider).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

export const ENV_FILE = 'TE_DSH_SIDECALL_FILE';
export const MAX_BODY_BYTES = 1_000_000;
export const MAX_PROMPT_CHARS = 400_000;
export const MAX_OUTPUT_TOKENS = 4096;
export const DEFAULT_OUTPUT_TOKENS = 1024;
export const MAX_CONCURRENT = 2;
export const DEFAULT_TIMEOUT_MS = 170_000;          // under the core's own 180 s

const HTTP = { BAD_REQUEST: 400, TE_AUTH: 401, FORBIDDEN: 403, NOT_FOUND: 404, NO_ROUTE: 409, TOO_LARGE: 413, BUSY: 429, AUTH: 502, MODEL: 502, NO_LLM: 503, TIMEOUT: 504 };

export class SidecallError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const endpointDir = (stateRoot) => join(stateRoot, 'hosts', 'dsh');
export const endpointPath = (stateRoot, pid = process.pid) => join(endpointDir(stateRoot), `sidecall.${pid}.endpoint.json`);

/** "provider/model" names a route; a bare model id keeps the session's provider. */
export function parseModel(spec, current) {
  if (spec === undefined || spec === null || spec === '') return current ? { provider: current.provider, model: current.model } : undefined;
  if (typeof spec !== 'string') throw new SidecallError('BAD_REQUEST', 'model must be a string', 400);
  const slash = spec.indexOf('/');
  if (slash > 0 && slash < spec.length - 1) return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
  if (spec.includes('/')) throw new SidecallError('BAD_REQUEST', 'model must be "provider/model" or a model id', 400);
  return current?.provider ? { provider: current.provider, model: spec } : undefined;
}

const leastReasoning = (controls, model) => {
  const first = model?.reasoning?.efforts?.[0]?.id;
  return first === undefined ? controls : { ...controls, reasoningEffort: first };
};

/** The ledger's usage fields from DSH's token usage. */
export function ledgerUsage(u) {
  if (!u || typeof u !== 'object' || !Number.isFinite(u.inputTokens)) return undefined;
  const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  return {
    input_tokens: n(u.inputTokens),
    cache_read_input_tokens: n(u.cacheReadTokens),
    cache_creation_input_tokens: n(u.cacheWriteTokens),
    output_tokens: n(u.outputTokens),
  };
}

/**
 * One call. `llm` is DSH's `ctx.llm`; `route` is the session's provider and model (what a call
 * without `paid_model` runs on). Throws a SidecallError whose `code` the core maps (AUTH pauses
 * the host's calls: the provider refused the account).
 */
export async function complete(llm, route, { prompt, model, maxTokens }, signal) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new SidecallError('BAD_REQUEST', 'prompt is required', 400);
  if (prompt.length > MAX_PROMPT_CHARS) throw new SidecallError('TOO_LARGE', 'prompt is too long', 413);
  const limit = maxTokens === undefined || maxTokens === null ? DEFAULT_OUTPUT_TOKENS : maxTokens;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_OUTPUT_TOKENS) throw new SidecallError('BAD_REQUEST', `maxTokens must be 1..${MAX_OUTPUT_TOKENS}`, 400);
  const target = parseModel(model, route);
  if (!target?.provider || !target?.model) throw new SidecallError('NO_ROUTE', 'no model route is known yet: no session has made a request, and paid_model names no provider', 409);
  if (!llm || typeof llm.prepareCall !== 'function') throw new SidecallError('NO_LLM', 'DSH\'s model service is not available', 503);
  try {
    const call = await llm.prepareCall({ provider: target.provider, model: target.model, maxTokens: limit }, signal, leastReasoning);
    const options = { ...call.config, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], signal };
    let text = '';
    let usage;
    let finish;
    for await (const chunk of call.stream(options)) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
      else if (chunk.type === 'usage') usage = chunk.usage;
      else if (chunk.type === 'finish') finish = chunk.reason;
    }
    signal?.throwIfAborted();
    if (finish?.kind === 'error' || finish?.kind === 'aborted') throw failure(finish.failure);
    return { text, usage: ledgerUsage(usage), model: target.model };
  } catch (err) {
    if (err instanceof SidecallError) throw err;
    if (signal?.aborted) throw new SidecallError('TIMEOUT', 'the model call was cancelled or timed out', 504);
    throw failure(err);
  }
}

function failure(f) {
  const status = Number.isInteger(f?.status) ? f.status : undefined;
  const code = status === 401 || status === 403 ? 'AUTH' : 'MODEL';
  const e = new SidecallError(code, String(f?.message ?? f ?? 'model call failed').slice(0, 300), HTTP[code]);
  e.providerStatus = status;
  return e;
}

/**
 * The endpoint. `llm` is a getter (DSH's model service is read at call time, so a plugin without
 * it still loads); `route` reads the route of the session in use.
 */
export function createSidecall({ llm, route, stateRoot, log = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const token = randomBytes(24).toString('hex');
  const tokenBuf = Buffer.from(token);
  let server;
  let starting;
  let active = 0;
  const state = { file: undefined, port: undefined };

  const send = (res, status, doc) => {
    const body = JSON.stringify(doc);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
    res.end(body);
  };
  const fail = (res, code, message, status = HTTP[code] ?? 500, extra = {}) => send(res, status, { error: { code, message, ...extra } });

  async function handle(req, res) {
    if (req.headers.host !== `127.0.0.1:${state.port}`) return fail(res, 'FORBIDDEN', 'bad host');          // DNS rebinding
    const given = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (given.length !== tokenBuf.length || !timingSafeEqual(given, tokenBuf)) return fail(res, 'TE_AUTH', 'bad token');
    if (req.method !== 'POST' || req.url !== '/v1/complete') return fail(res, 'NOT_FOUND', 'not found');
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) return fail(res, 'TOO_LARGE', 'body too large');
    if (active >= MAX_CONCURRENT) return fail(res, 'BUSY', 'too many calls at once');
    active += 1;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    try {
      let raw = '';
      req.setEncoding('utf8');
      for await (const part of req) {
        raw += part;
        if (raw.length > MAX_BODY_BYTES) return fail(res, 'TOO_LARGE', 'body too large');
      }
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return fail(res, 'BAD_REQUEST', 'body is not JSON');
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 'BAD_REQUEST', 'body must be an object');
      const out = await complete(llm(), route(), body, ac.signal);
      send(res, 200, out);
      log('debug', `side call done (${out.usage ? out.usage.input_tokens + out.usage.cache_read_input_tokens : '?'} prompt tokens)`);
    } catch (err) {
      const e = err instanceof SidecallError ? err : failure(err);
      if (!res.writableEnded && !res.destroyed) fail(res, e.code, e.message, e.status, e.providerStatus ? { status: e.providerStatus } : {});
      log('debug', `side call failed: ${e.code}`);
    } finally {
      clearTimeout(timer);
      active -= 1;
    }
  }

  const removeFile = () => {
    if (state.file) rmSync(state.file, { force: true });
  };

  /** Listen on loopback, write the endpoint file, forget endpoints of processes that are gone. */
  function start() {
    starting ??= new Promise((resolve) => {
      try {
        server = createServer((req, res) => { handle(req, res).catch(() => { try { res.destroy(); } catch { /* gone */ } }); });
        server.on('error', (err) => { log('warn', `side-call endpoint: ${err?.message ?? err}`); resolve(undefined); });
        server.listen(0, '127.0.0.1', () => {
          try {
            state.port = server.address().port;
            sweep(stateRoot);
            const file = endpointPath(stateRoot);
            mkdirSync(endpointDir(stateRoot), { recursive: true });
            writeFileSync(file, `${JSON.stringify({ port: state.port, token, pid: process.pid, started: Math.floor(Date.now() / 1000) })}\n`, { mode: 0o600 });
            state.file = file;
            process.once('exit', removeFile);
            log('info', `side calls answer on 127.0.0.1:${state.port}`);
          } catch (err) {
            log('warn', `side-call endpoint not published: ${err?.message ?? err}`);
          }
          resolve(state.file);
        });
        server.unref();                                    // never keeps a headless run alive
      } catch (err) {
        log('warn', `side-call endpoint not started: ${err?.message ?? err}`);
        resolve(undefined);
      }
    });
    return starting;
  }

  async function stop() {
    removeFile();
    state.file = undefined;
    if (server) await new Promise((r) => server.close(() => r()));
    server = undefined;
    starting = undefined;
  }

  return { start, stop, get file() { return state.file; }, get port() { return state.port; }, token };
}

/** Delete the endpoint files of processes that no longer run (a killed DSH leaves its own). */
export function sweep(stateRoot) {
  let names = [];
  try {
    names = readdirSync(endpointDir(stateRoot));
  } catch {
    return;
  }
  for (const name of names) {
    const m = /^sidecall\.(\d+)\.endpoint\.json$/.exec(name);
    if (!m || Number(m[1]) === process.pid) continue;
    try {
      process.kill(Number(m[1]), 0);
    } catch (err) {
      if (err?.code === 'ESRCH') rmSync(join(endpointDir(stateRoot), name), { force: true });
    }
  }
}

export const readEndpoint = (file) => JSON.parse(readFileSync(file, 'utf8'));
