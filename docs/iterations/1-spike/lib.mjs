// Shared helpers of the 1-spike scratch scripts (no credential values are ever printed).
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as live from '../../../plugin/dsh/test/live/common.mjs';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..', '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { live };

/** `--patch` text carrying the headless profile's models (copied as text; names env vars, no secrets). */
export function profileModelPatch(work, { defaultProvider, defaultModel } = {}) {
  const file = join(homedir(), '.dsh', 'profiles', 'headless', 'cordis.patch.yml');
  const keep = [];
  let on = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const id = /^- id: (\S+)/.exec(line)?.[1];
    if (id) on = id === 'llm-pi-ai' || id === 'agent-default-model';
    else if (/^\S/.test(line) && !line.startsWith('#')) on = false;
    if (on) keep.push(line);
  }
  let text = keep.join('\n');
  if (defaultModel) text = text.replace(/(- id: agent-default-model[\s\S]*?provider: )\S+(\s+model: )\S+/, `$1${defaultProvider}$2${defaultModel}`);
  const out = join(work, 'headless-models.patch.yml');
  writeFileSync(out, `${text}\n`);
  return out;
}

export function makeRepo(repo) {
  mkdirSync(join(repo, '.git', 'info'), { recursive: true });
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/widget.git\n');
}

/** Builds the plugin package into <work>/pkg. */
export function buildPkg(work) {
  const pkg = join(work, 'pkg');
  const b = spawnSync('python3', [join(ROOT, 'scripts', 'build_dsh_plugin.py'), '--out', pkg], { encoding: 'utf8' });
  if (b.status !== 0) throw new Error(`build failed: ${b.stderr}`);
  return pkg;
}

export function freshWork(name) {
  const work = join(tmpdir(), name);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  return work;
}

export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };

/** Isolated `dsh web`: own DSH_HOME, TE state, documents dir; the repo is the session workspace. */
export async function startWeb(work, { extraPatchText = '', defaultProvider, defaultModel, teConfig = '' } = {}) {
  live.loadProfileEnv('headless');
  const pkg = buildPkg(work);
  const documents = join(work, 'documents');
  const repo = join(documents, 'deepseek-harness', 'default-workspace');
  makeRepo(repo);
  const patch = join(work, 'te.yml');
  writeFileSync(patch, `- insert:\n    - id: te-browser\n      name: "file://${pkg}/index.mjs"\n${teConfig}- id: workspace-controller\n  name: '@deepseek-ai/dsh-api-workspace-controller'\n  config:\n    documentsDirectory: ${JSON.stringify(documents)}\n${extraPatchText}`);
  const models = profileModelPatch(work, { defaultProvider, defaultModel });
  const home = join(work, 'home');
  const state = join(work, 'state');
  const env = { ...process.env, DSH_HOME: home, TOKENECONOMIZER_HOME: state, CLAUDE_CONFIG_DIR: join(work, 'claude'), TE_FOLD_SYNC: '1' };
  for (const k of ['DSH_WEB_URL', 'DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_SHELL']) delete env[k];   // inherited from the parent dsh session
  const args = ['--profile', 'web', '--patch', patch, '--patch', models, '--port', '0', '--no-open'];
  const server = spawn('dsh', args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const logFile = join(work, 'server.log');
  server.stdout.on('data', (d) => { out += d; appendFileSync(logFile, d); });
  server.stderr.on('data', (d) => { appendFileSync(logFile, d); });
  for (let i = 0; i < 80 && !/dsh web: \S+/.test(out); i += 1) await sleep(500);
  const url = /dsh web: (\S+)/.exec(out)?.[1];
  if (!url) throw new Error(`server did not start; see ${logFile}`);
  return { server, url, home, state, repo, documents, env, pkg, args };
}
