// The plugin proper: DSH session events -> the core's Claude-shaped hook protocol -> what the
// core answers, applied with DSH's own levers. All mechanism logic lives in the core; this file
// only translates (the same division as the Pi extension and the Hermes plugin upstream).
//
//   session/created        -> SessionStart      the learned facts, kept for the session
//   system-prompt/assemble    (inject)          the facts, as one context of the system prompt
//   session/event (prompt) -> UserPromptSubmit  opens a prompt-turn; `prompt_id` numbered here
//   tools/post-execute     -> PostToolUse       the guard; a redirect rides back as a context
//   agent/turn-stopping    -> Stop              closes the turn
//   session/disposed       -> SessionEnd        hands the session to a detached fold
//
// Only a person's own (root) sessions are followed, never a subagent's. Every handler contains
// its failures: the plugin never changes how a session runs unless the core says so.
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { disabled, findBootstrap, runHook } from './bridge.mjs';
import { runTe } from './command.mjs';
import { Spool, parseArgs, spoolPath, textOf } from './spool.mjs';

export const NAME = 'token-economizer';
const CONTEXT_NAME = 'tokeneconomizer';
const SOURCE = { kind: 'token-economizer' };
const START_WAIT_MS = 5000;

const sessionOf = (v) => (!v || typeof v !== 'object' ? undefined : (v.session ?? v.agent?.session ?? v));
const isRoot = (s) => {
  const h = s?.header;
  return h !== undefined && h.parentSession === undefined && h.origin !== 'subagent';
};
const sessionKey = (s) => s?.id ?? s?.header?.id;
const contextOf = (out) => out?.hookSpecificOutput?.additionalContext ?? out?.additionalContext ?? '';

function withTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((r) => (t = setTimeout(r, ms)))]).finally(() => clearTimeout(t));
}

// DSH's own context messages (agent instructions, the skill catalog) come wrapped like this; an
// unwrapped note after a tool result was read as noise by the model (docs/dsh/spike-phase-b.md).
export const reminder = (text) => `<system-reminder>\n${text}\n</system-reminder>`;

let makeUserMessage;
async function userMessage(text) {
  if (!makeUserMessage) {
    try {
      makeUserMessage = (await import('@deepseek-ai/dsh-llm')).createUserMessage;
    } catch {
      /* not resolvable from an out-of-tree plugin: build the message by hand */
    }
    makeUserMessage ??= ({ content, source }) => ({ id: randomUUID(), role: 'user', content, source });
  }
  return makeUserMessage({ content: [{ type: 'text', text: reminder(text) }], source: SOURCE });
}

export function createPlugin(ctx, options) {
  const config = options ?? {};          // DSH passes null for an entry without `config:` (found live)
  const env = config.env ?? process.env;
  const log = (level, msg) => {
    try {
      ctx.logger?.[level]?.(`token-economizer: ${msg}`);
    } catch {
      /* logging never matters */
    }
  };
  if (disabled(env) || config.enabled === false) {
    log('info', 'disabled (TE_DISABLE / TE_SIDECALL / config)');
    return null;
  }
  const stateRoot = config.stateRoot ?? env.TOKENECONOMIZER_HOME ?? join(homedir(), '.tokeneconomizer');
  const bootstrap = config.bootstrap ?? findBootstrap(import.meta.url);
  let run = config.run;
  if (!run) {
    if (!bootstrap) log('warn', 'the TokenEconomizer launcher (scripts/te_bootstrap.py) was not found: no hook will run');
    run = (payload, cwd) => runHook(payload, { env, bootstrap, cwd });
  }

  const states = new Map();

  function stateFor(session, create = true) {
    if (!session || !isRoot(session)) return undefined;
    const key = sessionKey(session);
    if (!key) return undefined;
    let st = states.get(key);
    if (!st && create) {
      const cwd = session.header?.cwd || process.cwd();
      st = {
        key,
        cwd,
        spool: new Spool(spoolPath(stateRoot, key), { sessionId: key, cwd }),
        promptN: 0,
        facts: [],
        q: Promise.resolve(),
        start: undefined,
      };
      states.set(key, st);
    }
    return st;
  }

  const inflight = new Set();
  const enqueue = (st, fn) => {
    const p = st.q.then(fn);
    const settled = p.catch(() => {});
    st.q = settled;
    inflight.add(settled);
    settled.finally(() => inflight.delete(settled));
    return p.catch(() => undefined);
  };
  // Resolves when every queued hook call has finished (tests; DSH never waits on it).
  const idle = async () => {
    while (inflight.size) await Promise.allSettled([...inflight]);
  };

  async function hook(st, event, extra = {}) {
    const payload = {
      session_id: st.key,
      cwd: st.cwd,
      transcript_path: st.spool.path,
      hook_event_name: event,
      ...extra,
    };
    try {
      const out = await run(payload, st.cwd);
      return out && typeof out === 'object' ? out : {};
    } catch {
      return {};
    }
  }

  const addFacts = (st, text) => {
    if (text && !st.facts.includes(text)) st.facts.push(text);
  };

  function ensureStarted(st) {
    st.start ??= enqueue(st, async () => {
      addFacts(st, contextOf(await hook(st, 'SessionStart', { source: 'startup' })));
    });
    return st.start;
  }

  ctx.on('session/created', (session) => {
    try {
      const st = stateFor(session);
      if (st) ensureStarted(st);
    } catch {
      /* never interrupt the agent */
    }
  });

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const resolved = await next();
    try {
      const st = stateFor(context?.agent?.session ?? context?.session);
      if (!st) return resolved;
      await withTimeout(ensureStarted(st), START_WAIT_MS);
      if (!st.facts.length || !Array.isArray(resolved?.contexts)) return resolved;
      resolved.contexts = [
        ...resolved.contexts.filter((e) => e?.name !== CONTEXT_NAME),
        { name: CONTEXT_NAME, text: st.facts.join('\n\n') },
      ];
    } catch (err) {
      log('debug', `facts not injected: ${err?.name ?? err}`);
    }
    return resolved;
  });

  ctx.on('session/event', (session, event) => {
    try {
      const st = stateFor(session);
      if (!st) return;
      ensureStarted(st);
      const rec = st.spool.record(event);
      if (rec?.kind !== 'prompt') return;
      st.promptN += 1;
      const prompt_id = `p${st.promptN}`;
      enqueue(st, async () => {
        addFacts(st, contextOf(await hook(st, 'UserPromptSubmit', { prompt_id, prompt: rec.text })));
      });
    } catch (err) {
      log('debug', `event not recorded: ${err?.name ?? err}`);
    }
  });

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next();
    try {
      const st = stateFor(exec?.agent?.session);
      if (!st) return decision;
      ensureStarted(st);
      const content = textOf(result?.content) || String(result?.error ?? '');
      const out = await enqueue(st, () =>
        hook(st, 'PostToolUse', {
          prompt_id: `p${st.promptN}`,
          tool_use_id: exec.id ?? exec.callId ?? '',
          tool_name: exec.name,
          tool_input: parseArgs(exec.arguments ?? exec.args),
          tool_response: { content, isError: Boolean(result?.isError) },
        }),
      );
      const text = [contextOf(out), out?.systemMessage].filter(Boolean).join('\n');
      if (!text) return decision;
      const message = await userMessage(text);
      return { ...decision, additionalContexts: [...(decision?.additionalContexts ?? []), message] };
    } catch {
      return decision;
    }
  });

  ctx.on('agent/turn-stopping', ({ agent } = {}) => {
    try {
      const st = stateFor(agent?.session, false);
      if (st) enqueue(st, () => hook(st, 'Stop', { prompt_id: `p${st.promptN}` }));
    } catch {
      /* ignore */
    }
  });

  ctx.on('session/disposed', (arg) => {
    try {
      const session = sessionOf(arg);
      const st = stateFor(session, false);
      if (!st) return;
      states.delete(st.key);
      enqueue(st, () => hook(st, 'SessionEnd', { reason: 'other' }));
    } catch {
      /* ignore */
    }
  });

  // `/te ...`: the core's command line, answered in the chat without a model call. Registered when
  // the `commands` service exists (`ctx.inject`), so a profile without it still gets the hooks; a
  // plain `inject: ['commands']` on the plugin would hold the whole plugin back instead.
  const registerCommand = (c) =>
    c.commands.register({
      name: 'te',
      description: 'TokenEconomizer: status, learned facts, tool pruning, settings',
      input: { hint: '[status | microskills | toolprune | config | doctor] [arguments]' },
      handler: async (invocation) => {
        try {
          const exec = config.runCommand ?? runTe;
          return await exec(invocation.rawInput, { env, bootstrap, cwd: invocation.agent?.session?.header?.cwd, signal: invocation.signal });
        } catch (err) {
          return { kind: 'error', text: `te failed: ${err?.message ?? err}` };
        }
      },
    });
  try {
    if (typeof ctx.inject === 'function') ctx.inject(['commands'], registerCommand);
    else if (ctx.commands?.register) registerCommand(ctx);
  } catch (err) {
    log('warn', `/te not registered: ${err?.message ?? err}`);
  }

  // `dsh headless` ends the process without a `session/disposed` (checked live, docs/dsh/
  // spike-phase-b.md), so sessions still open when the event loop drains are closed here: the
  // hook call is async work, which keeps the process alive until it is done. Whatever a killed
  // process leaves is folded by the core at the next session start in that repository.
  if (config.closeOnExit !== false) {
    const key = Symbol.for('dsh-token-economizer.exit');
    if (globalThis[key]) process.off('beforeExit', globalThis[key]);
    globalThis[key] = () => {
      for (const st of [...states.values()]) {
        states.delete(st.key);
        enqueue(st, () => hook(st, 'SessionEnd', { reason: 'other' }));
      }
    };
    process.on('beforeExit', globalThis[key]);
  }

  log('info', `active (state: ${stateRoot})`);
  return { states, idle };
}
