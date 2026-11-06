// The bridge to the TokenEconomizer core: one hook call is one Python process (JSON in, JSON
// out), the way every host of the core runs it. It starts the core's OWN launcher,
// `scripts/te_bootstrap.py hook --host dsh`, so finding the package (`TE_CORE_PATH`, `lib/` in a
// bundle, the checkout one level up) is the core's logic, not a copy of it here. It never throws:
// a missing Python, a crash or a timeout is "no change" (`{}`), as in every host of the core.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOOK_TIMEOUT_MS = 20_000;
const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());

/** `TE_DISABLE=1` turns the plugin off, `TE_SIDECALL=1` marks the core's own side calls. */
export const disabled = (env) => truthy(env.TE_DISABLE) || truthy(env.TE_SIDECALL);

/** The launcher: `<bundle>/scripts/` in a bundle, `plugin/scripts/` beside `plugin/dsh/` in a checkout. */
export function findBootstrap(metaUrl) {
  const root = dirname(dirname(fileURLToPath(metaUrl)));
  for (const cand of [join(root, 'scripts', 'te_bootstrap.py'), join(root, '..', 'scripts', 'te_bootstrap.py')]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

export function pythonCandidates(env) {
  return [env.TE_PYTHON, 'python3', 'python'].filter(Boolean);
}

function once(python, bootstrap, input, { env, cwd, timeoutMs }) {
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
      child = spawn(python, [bootstrap, 'hook', '--host', 'dsh'], {
        cwd,
        env: { ...env, PYTHONUTF8: '1' },
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      return finish({ spawned: false });
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ spawned: true, answer: {} });
    }, timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => {
      clearTimeout(timer);
      finish({ spawned: false });
    });
    child.on('close', () => {
      clearTimeout(timer);
      let answer = {};
      try {
        const last = out.trim().split('\n').pop();
        const v = JSON.parse(last);
        if (v && typeof v === 'object' && !Array.isArray(v)) answer = v;
      } catch {
        /* not JSON (an old Python's syntax error, say): no change */
      }
      finish({ spawned: true, answer });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

/** One dispatcher call. Resolves to the answer object, `{}` on any failure. */
export async function runHook(payload, { env = process.env, bootstrap, cwd, timeoutMs = HOOK_TIMEOUT_MS } = {}) {
  if (disabled(env) || !bootstrap) return {};
  const dir = cwd && existsSync(cwd) ? cwd : process.cwd();
  for (const python of pythonCandidates(env)) {
    const r = await once(python, bootstrap, payload, { env, cwd: dir, timeoutMs });
    if (r.spawned) return r.answer;
  }
  return {};
}
