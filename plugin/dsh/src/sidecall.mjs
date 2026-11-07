// The plugin's own model calls (the loop guard's judge and nudge writer, the micro-skills
// proposer) on DeepSeek Harness (docs/dsh/adr/0004). The core runs in Python, in a hook or in a
// detached job, with no way into DSH's model service, so the plugin answers for it: a loopback
// HTTP endpoint that takes a prompt, makes one call through `ctx.llm` (one attempt, no session
// history, as `session-title-llm` does) and returns the text and the token usage. The core prices
// the usage and charges its ledger; nothing is written to any session.
//
// Where it is: an endpoint file under the state root, named in `TE_DSH_SIDECALL_FILE` on every hook's
// environment (jobs a hook starts inherit it). Who may call: whoever reads that file (owner-only),
// with its token; the call names its session (`TE_DSH_SESSION`, the field `session`), whose route it runs on.
// What it costs the account: one request on the session's own route, or on
// `paid_model` (`provider/model`, or a model of the session's provider).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

export const ENV_FILE = 'TE_DSH_SIDECALL_FILE';
export const ENV_SESSION = 'TE_DSH_SESSION';       // the session a hook runs for: a call names it, the endpoint answers on ITS route
export const MAX_BODY_BYTES = 1_000_000;
export const MAX_PROMPT_CHARS = 400_000;
export const MAX_OUTPUT_TOKENS = 4096;
export const DEFAULT_OUTPUT_TOKENS = 1024;
export const MAX_CONCURRENT = 2;
export const DEFAULT_TIMEOUT_MS = 170_000;          // under the core's own 180 s
const RAW_MESSAGE_CHARS = 1000;                     // what a failure keeps of the provider's text, before it is scrubbed
export const MAX_MESSAGE_CHARS = 300;               // what an error reply carries of it, after
const LINGER_MS = 2000;                             // how long an oversize body is discarded after its refusal

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
    return { text, usage: ledgerUsage(usage), model: target.model, provider: target.provider };
  } catch (err) {
    if (err instanceof SidecallError) throw err;
    if (signal?.aborted) throw new SidecallError('TIMEOUT', 'the model call was cancelled or timed out', 504);
    throw failure(err);
  }
}

function failure(f) {
  const status = Number.isInteger(f?.status) ? f.status : undefined;
  const code = status === 401 || status === 403 ? 'AUTH' : 'MODEL';
  const e = new SidecallError(code, String(f?.message ?? f ?? 'model call failed').slice(0, RAW_MESSAGE_CHARS), HTTP[code]);
  e.providerStatus = status;
  return e;
}

const MIN_RUN = 20;                                  // a run of the prompt this long is the prompt, whatever surrounds it
const MIN_WHOLE = 8;                                 // a shorter prompt is only removed whole (it would mangle the message otherwise)

/**
 * A provider's error text for the reply: the endpoint token and the prompt (whole, or any run of it
 * of MIN_RUN characters or more) removed, then cut to MAX_MESSAGE_CHARS. Providers echo requests in
 * their errors; the reply goes back to the core, which writes it to `errors.log`.
 */
export function scrub(message, { token, prompt } = {}) {
  let text = String(message ?? '').slice(0, RAW_MESSAGE_CHARS);
  if (token) text = text.split(token).join('[redacted]');
  if (typeof prompt === 'string' && prompt.length >= MIN_WHOLE) {
    text = text.split(prompt).join('[redacted]');
    if (prompt.length >= MIN_RUN) {
      let out = '';
      for (let i = 0; i < text.length;) {
        let end = i + MIN_RUN;
        if (end <= text.length && prompt.includes(text.slice(i, end))) {
          while (end < text.length && prompt.includes(text.slice(i, end + 1))) end += 1;
          out += '[redacted]';
          i = end;
        } else {
          out += text[i];
          i += 1;
        }
      }
      text = out;
    }
  }
  return text.slice(0, MAX_MESSAGE_CHARS);
}

/**
 * The endpoint. `llm` is a getter (DSH's model service is read at call time, so a plugin without
 * it still loads); `route(sessionId)` reads the route of the named session (of the last one observed when the call names none).
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

  /** The request body as text, counted in BYTES; cut off at the deadline (`signal`), so a half-sent body cannot hold a slot. */
  const readBody = (req, signal) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const done = (fn, v) => {
      signal.removeEventListener('abort', onAbort);
      req.off('data', onData);
      fn(v);
    };
    const onAbort = () => done(reject, new SidecallError('TIMEOUT', 'the request body did not arrive in time', 408));
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return done(reject, new SidecallError('TOO_LARGE', 'body too large', 413));
      chunks.push(chunk);
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort);
    req.on('data', onData);
    req.once('end', () => done(resolve, Buffer.concat(chunks).toString('utf8')));
    req.once('error', (err) => done(reject, err));
    req.once('close', () => { if (!req.complete) done(reject, new SidecallError('BAD_REQUEST', 'the request was closed before its body arrived', 400)); });
  });

  /** A body that was not read to its end: cut the connection (a stalled sender), or discard the rest for a moment so the sender can still read its reply (an oversize one). */
  function closeUnread(req, res, now) {
    if (now) {
      res.once('finish', () => req.destroy());
      return;
    }
    req.resume();
    const t = setTimeout(() => req.destroy(), LINGER_MS);
    t.unref();
    req.once('close', () => clearTimeout(t));
  }

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
    let bodyDone = false;
    let prompt;
    try {
      const raw = await readBody(req, ac.signal);
      bodyDone = true;
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return fail(res, 'BAD_REQUEST', 'body is not JSON');
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 'BAD_REQUEST', 'body must be an object');
      prompt = body.prompt;
      const named = body.session;
      if (named !== undefined && named !== null && typeof named !== 'string') return fail(res, 'BAD_REQUEST', 'session must be a string');
      const out = await complete(llm(), route(named || undefined), body, ac.signal);   // the route of the session the core names
      send(res, 200, out);
      log('debug', `side call done (${out.usage ? out.usage.input_tokens + out.usage.cache_read_input_tokens : '?'} prompt tokens)`);
    } catch (err) {
      const e = err instanceof SidecallError ? err : failure(err);
      if (!res.writableEnded && !res.destroyed) fail(res, e.code, scrub(e.message, { token, prompt }), e.status, e.providerStatus ? { status: e.providerStatus } : {});
      if (!bodyDone) closeUnread(req, res, e.code === 'TIMEOUT');
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
            const dir = endpointDir(stateRoot);
            mkdirSync(dir, { recursive: true });
            if (!lstatSync(dir).isDirectory()) throw new Error('the endpoint directory is not a plain directory (a symlink?)');   // never write through a link
            sweep(stateRoot);
            const file = endpointPath(stateRoot);
            try {
              lstatSync(file);                                // lstat: a link is looked at, not followed
              unlinkSync(file);                               // whatever is there (a planted symlink, a stale file) goes; its target is never touched
            } catch (err) {
              if (err?.code !== 'ENOENT') throw err;
            }
            writeFileSync(file, `${JSON.stringify({ port: state.port, token, pid: process.pid, started: Math.floor(Date.now() / 1000) })}\n`, { mode: 0o600, flag: 'wx' });   // wx: never opens an existing path, a link included
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
