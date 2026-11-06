// The session spool: what the plugin keeps of a DSH session so the TokenEconomizer core can fold
// it when the session ends. DSH's own log is a Zstandard stream no hook script reads, so the
// plugin writes a small Pi-format session tree instead (a header line, then one `message` entry
// per prompt, assistant message and tool result), which the core's trace seam already reads
// (`trace.pi_session_to_claude`, `pi_prompt_count`, `pi_session_usage`). See
// docs/dsh/spike-phase-b.md for the mapping and the check against a real session.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// The longest tool result or argument string kept: failures show early, and a file a tool wrote
// is not something any mechanism reads.
export const RESULT_CAP = 20000;
const clip = (s) => (typeof s === 'string' && s.length > RESULT_CAP ? s.slice(0, RESULT_CAP) : s);

export const safeId = (id) => basename(String(id)).replace(/[^A-Za-z0-9._-]/g, '_') || 'session';
export const spoolPath = (stateRoot, sessionId) =>
  join(stateRoot, 'dsh-sessions', `${safeId(sessionId)}.jsonl`);

export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/** DSH's usage (`inputTokens` excludes the cache, as in pi-ai) in Pi's field names. */
export function toPiUsage(u) {
  if (!u || typeof u !== 'object') return undefined;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  return {
    input: n(u.inputTokens),
    output: n(u.outputTokens),
    cacheRead: n(u.cacheReadTokens),
    cacheWrite: n(u.cacheWriteTokens),
  };
}

/** Tool arguments as an object: DSH records them as a JSON string. */
export function parseArgs(a) {
  let v = a;
  if (typeof a === 'string') {
    try {
      v = JSON.parse(a);
    } catch {
      return { raw: clip(a) };
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v === undefined ? {} : { value: v };
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x)]));
}

function assistantBlocks(content) {
  const out = [];
  for (const b of Array.isArray(content) ? content : []) {
    if (b?.type === 'text' && typeof b.text === 'string') out.push({ type: 'text', text: b.text });
    else if (b?.type === 'tool-call') {
      out.push({ type: 'toolCall', id: b.id, name: b.name, arguments: parseArgs(b.arguments) });
    }
  }
  return out;
}

export class Spool {
  constructor(path, { sessionId, cwd }) {
    this.path = path;
    this.header = { type: 'session', version: 3, id: String(sessionId), cwd };
    this.parent = null;
    this.n = 0;
    this.ready = false;
  }

  #write(row) {
    appendFileSync(this.path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  }

  #ensure() {
    if (this.ready) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    if (existsSync(this.path)) {
      // A resumed session: carry on from the last entry, not a second header.
      const rows = readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
      for (const line of rows) {
        try {
          const r = JSON.parse(line);
          if (r?.id) {
            this.parent = r.id;
            this.n += 1;
          }
        } catch {
          /* a torn last line is skipped */
        }
      }
    } else {
      this.#write(this.header);
      try {
        chmodSync(this.path, 0o600);
      } catch {
        /* best effort */
      }
    }
    this.ready = true;
  }

  #add(message) {
    this.#ensure();
    this.n += 1;
    const id = `e${String(this.n).padStart(5, '0')}`;
    this.#write({ type: 'message', id, parentId: this.parent, message });
    this.parent = id;
  }

  /**
   * Record one DSH session event. Returns `{kind: 'prompt', text}` for a person's prompt,
   * otherwise `{kind}` of what was recorded, or null for an event the spool does not keep.
   * Only `source.kind === 'user'` is a prompt: context DSH injects (instructions, runtime
   * context, the skill catalog, this plugin's own) is a user-role message too, and counting it
   * would make the core see a prompt that nobody typed.
   */
  record(event) {
    const d = event?.data;
    if (!d || typeof event.type !== 'string') return null;
    if (event.type === 'user/message') {
      if (d.role !== 'user' || d.source?.kind !== 'user') return null;
      const text = textOf(d.content);
      this.#add({ role: 'user', content: [{ type: 'text', text }] });
      return { kind: 'prompt', text };
    }
    if (event.type === 'assistant/message') {
      const m = d.message ?? {};
      const msg = { role: 'assistant', content: assistantBlocks(m.content), model: m.source?.model };
      const usage = toPiUsage(d.usage);
      if (usage) msg.usage = usage;
      this.#add(msg);
      return { kind: 'assistant' };
    }
    if (event.type === 'tool/result') {
      const m = d.message ?? {};
      this.#add({
        role: 'toolResult',
        toolCallId: m.toolCallId,
        isError: Boolean(m.isError),
        content: [{ type: 'text', text: clip(textOf(m.content)) }],
      });
      return { kind: 'tool-result' };
    }
    return null;
  }
}
