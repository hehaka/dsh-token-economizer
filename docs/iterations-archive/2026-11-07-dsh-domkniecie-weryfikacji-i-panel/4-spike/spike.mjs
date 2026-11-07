#!/usr/bin/env node
// Spike scratch (not part of the product). Usage:
//   node docs/iterations/4-spike/spike.mjs seq      # 3 sessions, same repo+home, TE_FOLD_SYNC=1
//   node docs/iterations/4-spike/spike.mjs control  # control session in the same repo+home
//   node docs/iterations/4-spike/spike.mjs async    # fresh repo+home, NO TE_FOLD_SYNC, 1 session, poll 30 s
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dsh, fakeGitRepo, jsonl, loadProfileEnv, overlay, prepareWork, requestTools, tail, REPO } from '../../../plugin/dsh/test/live/common.mjs';

const mode = process.argv[2];
const profile = 'headless';
loadProfileEnv(profile);
const name = mode === 'async' ? 'te-dsh-spike4-async' : 'te-dsh-spike4';
let work, entry;
if (mode === 'control') {
  work = join(tmpdir(), name);
  const pkg = join(work, 'pkg');
  entry = 'file://' + join(pkg, 'index.mjs');
} else ({ work, entry } = prepareWork(name));
const repo = join(work, 'repo');
if (mode !== 'control') fakeGitRepo(repo);
const state = join(work, 'state');
const patch = mode === 'control' ? join(work, 'real.patch.yml') : overlay(work, entry, 'real', {});
const base = { TOKENECONOMIZER_HOME: state, CLAUDE_CONFIG_DIR: join(work, 'claude'),
  TE_TOOLPRUNE: 'auto', TE_TOOLPRUNE_EVIDENCE: '1', TE_TOOLPRUNE_MIN_SESSIONS: '1', TE_TOOLPRUNE_SESSIONS: '2', TE_TOOLPRUNE_QUIET_MINUTES: '0' };
if (mode !== 'async') base.TE_FOLD_SYNC = '1';
const MCP = 'mcp__postgres__postgres_mcp_list_connection_profiles';
const localFile = join(repo, '.dsh', 'token-economizer.local.json');
const spools = () => (existsSync(join(state, 'dsh-sessions')) ? readdirSync(join(state, 'dsh-sessions')).filter((n) => n.endsWith('.jsonl')) : []);
const readDeny = () => { try { return JSON.parse(readFileSync(localFile, 'utf8')).tokeneconomizer?.deny ?? null; } catch { return null; } };
const catalog = () => { try { return JSON.parse(readFileSync(join(state, 'hosts', 'dsh', 'catalog.json'), 'utf8')).tools; } catch { return []; } };

function report(label, before) {
  const sid = spools().filter((n) => !before.includes(n)).map((n) => n.replace(/\.jsonl$/, ''));
  console.log(`[${label}] new spool(s): ${sid.join(',') || 'none'}`);
  for (const id of sid) {
    const rows = jsonl(join(state, 'dsh-sessions', `${id}.jsonl`));
    const calls = rows.flatMap((r) => (r.message?.content ?? []).filter((b) => b?.type === 'toolCall').map((b) => b.name));
    console.log(`[${label}] spool toolCall names: ${JSON.stringify(calls)}`);
    for (const r of rows.filter((r) => r.message?.role === 'toolResult')) {
      console.log(`[${label}] toolResult ${r.message.toolName ?? ''} isError=${r.message.isError} :: ${JSON.stringify(r.message.content).slice(0, 220)}`);
    }
    const rt = requestTools(id);
    console.log(`[${label}] request/header tools: ${rt ? rt.length : 'n/a'}; bash=${rt?.includes('bash')}; ${MCP}=${rt?.includes(MCP)}; mcp__ in request=${rt?.filter((t) => t.startsWith('mcp__')).length}`);
    return { id, rt };
  }
  return {};
}
const cat = () => catalog();
function localState(label) {
  const deny = readDeny();
  const c = cat();
  const mcpCat = c.filter((t) => t.startsWith('mcp__') && t !== MCP);
  console.log(`[${label}] catalog=${c.length} mcp_in_catalog=${c.filter((t) => t.startsWith('mcp__')).length} (minus used: ${mcpCat.length}); local.json exists=${existsSync(localFile)}`);
  if (deny) console.log(`[${label}] deny count=${deny.length}; mcp__ in deny=${deny.filter((t) => t.startsWith('mcp__')).length}; non-mcp in deny=${JSON.stringify(deny.filter((t) => !t.startsWith('mcp__')))}; contains used MCP=${deny.includes(MCP)}; contains bash=${deny.includes('bash')}; deny subset of catalog-minus-used=${deny.every((t) => mcpCat.includes(t))}; catalog-minus-used missing from deny=${mcpCat.filter((t) => !deny.includes(t)).length}`);
  return deny;
}
const run = (prompt, label) => {
  const before = spools();
  const t0 = Date.now();
  const r = dsh(work, ['--profile', profile, '--patch', patch, prompt], base, 300_000, repo);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[${label}] exit=${r.status} secs=${secs}`);
  if (r.status !== 0) console.log(tail(r.stderr));
  console.log(`[${label}] answer: ${(r.stdout || '').trim().slice(-120)}`);
  return { before, exit: r.status, t1: Date.now() };
};
const prompt = (n) => `Use the tool ${MCP} once (it is read-only), then run bash echo spike-${n} and reply done`;

if (mode === 'seq') {
  for (const n of [1, 2, 3]) {
    const x = run(prompt(n), `S${n}`);
    report(`S${n}`, x.before);
    localState(`S${n}-after-exit`);
  }
} else if (mode === 'control') {
  const x = run('Reply with the single word ok', 'CTRL');
  const { rt } = report('CTRL', x.before);
  const deny = readDeny() ?? [];
  console.log(`[CTRL] tools in request=${rt?.length}; denied names present in request=${deny.filter((t) => rt?.includes(t)).length}/${deny.length}; bash=${rt?.includes('bash')}; used mcp=${rt?.includes(MCP)}`);
} else if (mode === 'async') {
  const x = run(prompt(1), 'A1');
  const exitAt = x.t1;
  const atExit = existsSync(localFile);
  const mtimeRel = atExit ? ((statSync(localFile).mtimeMs - exitAt) / 1000).toFixed(2) : 'n/a';
  console.log(`[A1] immediately after exit: local.json exists=${atExit}; its mtime relative to exit = ${mtimeRel} s (negative = written before exit)`);
  report('A1', x.before);
  let seen = null;
  for (let i = 0; i < 60; i++) {
    if (existsSync(localFile)) { seen = ((Date.now() - exitAt) / 1000).toFixed(1); break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`[A1] polling after report: first seen ${seen === null ? 'NEVER within 30 s' : seen + ' s after exit'}`);
  localState('A1-final');
}
