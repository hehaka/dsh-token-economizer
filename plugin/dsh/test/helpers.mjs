import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, '..', '..', '..');
export const BOOTSTRAP = join(REPO, 'plugin', 'scripts', 'te_bootstrap.py');

export const tmp = (p = 'te-dsh-') => mkdtempSync(join(tmpdir(), p));

/** A git checkout the core can identify (a remote makes it a repository it knows). */
export function fakeRepo(root) {
  const repo = join(root, 'repo');
  mkdirSync(join(repo, '.git', 'info'), { recursive: true });
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/widget.git\n');
  return repo;
}

/** The environment a hook process gets: isolated state, no real agent history, inline fold. */
export function isolatedEnv(root) {
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    TOKENECONOMIZER_HOME: join(root, 'state'),
    TE_FOLD_SYNC: '1',
    GIT_CEILING_DIRECTORIES: root,
  };
}

export function fakeCtx() {
  const handlers = {};
  return {
    handlers,
    on(event, fn) {
      (handlers[event] ??= []).push(fn);
    },
    logger: { info() {}, warn() {}, debug() {} },
  };
}

export const rootSession = (id, cwd) => ({ id, header: { id, cwd } });
export const subSession = (id, cwd) => ({ id, header: { id, cwd, parentSession: 'parent', origin: 'subagent' } });

const text = (t) => [{ type: 'text', text: t }];
let seq = 0;
const ev = (type, data) => ({ type, seq: seq++, time: 0, data });

/** Events shaped like the ones a real DSH session logs (docs/dsh/spike-phase-b.md). */
export function dshEvents({ model = 'claude-haiku-5-5' } = {}) {
  const usage = { inputTokens: 4, outputTokens: 105, totalTokens: 16209, cacheReadTokens: 2326, cacheWriteTokens: 13774 };
  const call = (id, name, args) => ev('assistant/message', {
    turn: 1, step: 1, usage,
    message: { role: 'assistant', content: [{ type: 'text', text: `calling ${name}` }, { type: 'tool-call', id, name, arguments: JSON.stringify(args) }], source: { kind: 'model', model } },
  });
  const result = (id, t, isError = false) => ev('tool/result', {
    turn: 1, step: 1, message: { role: 'tool', toolCallId: id, isError, content: text(t), source: { kind: 'tool', callId: id } },
  });
  return [
    // context DSH injects is a user-role message too, but not a prompt
    ev('user/message', { role: 'user', content: text('<system-reminder>instructions</system-reminder>'), source: { kind: 'agent-instructions' } }),
    ev('user/message', { role: 'user', content: text('fix the failing test'), source: { kind: 'user' }, id: 'u1' }),
    call('c1', 'bash', { command: 'pytest -q' }),
    result('c1', 'bash: pytest: command not found', true),
    call('c2', 'bash', { command: 'python -m pytest -q' }),
    result('c2', '1 passed'),
    call('c3', 'read', { path: 'a.py' }),
    result('c3', 'x = 1'),
    ev('session/title', { title: 'ignored' }),
  ];
}

/** Read a spool with the core's own readers and report what they see. */
export function coreView(spoolFile, workdir) {
  const script = `
import json, sys
from tokeneconomizer import trace
p, out = sys.argv[1], sys.argv[2]
n = trace.pi_session_to_claude(p, out)
u = trace.pi_session_usage(p)
traj = trace.load_trajectory(out)
print(json.dumps({"calls": n, "prompts": trace.pi_prompt_count(p), "usage": u,
                  "traj": [[c[0], c[3]] for c in traj]}))`;
  const r = spawnSync('python3', ['-c', script, spoolFile, join(workdir, 'claude.jsonl')], {
    env: { ...process.env, PYTHONPATH: REPO, PYTHONUTF8: '1' }, encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`core reader failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

export function findFiles(root, name) {
  return readdirSync(root, { recursive: true }).filter((f) => String(f).endsWith(name)).map((f) => join(root, String(f)));
}

export const readJsonl = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
