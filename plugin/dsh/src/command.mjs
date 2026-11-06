// `/te`: the core's own command line (`te status`, `te toolprune show`, ...), run for the session's
// repository. The core owns every behaviour and every word of output; this file only splits the
// line, runs `te_bootstrap.py cli --host dsh` (no shell, so an argument is never a command) and
// hands the text back to DSH, which prints it in the chat without sending it to the model.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { disabled, pythonCandidates } from './bridge.mjs';

export const CLI_TIMEOUT_MS = 30_000;
export const OUTPUT_CAP = 20_000;
// What a person may run from the chat. `fold` and `judge` are the core's own background jobs;
// `probe` would make model calls the DSH plugin does not wire yet.
export const ALLOWED = new Set(['status', 'panel', 'microskills', 'facts', 'toolprune', 'untool', 'config', 'doctor', 'history', 'repos', 'repomap']);
export const USAGE = `Usage: /te <command> [arguments]   (default: status)
Commands: ${[...ALLOWED].filter((c) => !['facts', 'untool'].includes(c)).join(', ')}
Examples: /te status --json   /te toolprune show   /te config show`;

/** Split a command line into arguments: whitespace separates, quotes group, a backslash escapes. */
export function splitArgs(line) {
  const out = [];
  let cur = '';
  let inToken = false;
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inToken = true;
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
      inToken = true;
    } else if (/\s/.test(c)) {
      if (inToken) out.push(cur);
      cur = '';
      inToken = false;
    } else {
      cur += c;
      inToken = true;
    }
  }
  if (quote) return null;                      // an unterminated quote is a mistake, not an argument
  if (inToken) out.push(cur);
  return out;
}

function runOnce(python, argv, { env, cwd, timeoutMs, signal }) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    let child;
    try {
      child = spawn(python, argv, { cwd, env: { ...env, PYTHONUTF8: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal });
    } catch {
      return finish({ spawned: false });
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ spawned: true, code: null, out, timedOut: true });
    }, timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      finish(e?.name === 'AbortError' ? { spawned: true, code: null, out, aborted: true } : { spawned: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ spawned: true, code, out });
    });
  });
}

/** Run one `/te` line. Resolves to a DSH CommandResult; it never throws. */
export async function runTe(rawInput, { env = process.env, bootstrap, cwd, timeoutMs = CLI_TIMEOUT_MS, signal } = {}) {
  if (disabled(env)) return { kind: 'error', text: 'TokenEconomizer is turned off (TE_DISABLE).' };
  if (!bootstrap) return { kind: 'error', text: 'The TokenEconomizer launcher (scripts/te_bootstrap.py) was not found; reinstall the plugin.' };
  const args = splitArgs(String(rawInput ?? ''));
  if (!args) return { kind: 'error', text: `Unbalanced quote.\n${USAGE}` };
  if (args.length === 0) args.push('status');
  if (['help', '--help', '-h'].includes(args[0])) return { kind: 'success', text: USAGE };
  if (!ALLOWED.has(args[0])) return { kind: 'error', text: `Unknown command "${args[0]}".\n${USAGE}` };
  const dir = cwd && existsSync(cwd) ? cwd : process.cwd();
  const argv = [bootstrap, 'cli', '--host', 'dsh', '--cwd', dir, ...args];
  for (const python of pythonCandidates(env)) {
    const r = await runOnce(python, argv, { env, cwd: dir, timeoutMs, signal });
    if (!r.spawned) continue;
    if (r.timedOut) return { kind: 'error', text: `te ${args[0]} did not finish in ${Math.round(timeoutMs / 1000)} s.` };
    if (r.aborted) return { kind: 'error', text: 'Cancelled.' };
    const text = r.out.length > OUTPUT_CAP ? `${r.out.slice(0, OUTPUT_CAP)}\n… (output cut at ${OUTPUT_CAP} characters)` : r.out;
    const body = text.trim() || '(no output)';
    return r.code === 0 ? { kind: 'success', text: body } : { kind: 'error', text: body };
  }
  return { kind: 'error', text: 'Python 3.10 or newer was not found (set TE_PYTHON).' };
}
