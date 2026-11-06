#!/usr/bin/env node
// Acceptance check of the panel in a real browser against a real `dsh web` (ADR 0003).
//
//   node plugin/dsh/client/test/browser/browser-check.mjs [--env-file F] [--patch P]... [--keep]
//
// Starts an isolated `dsh web` (own DSH_HOME and TokenEconomizer state, random port) with the
// plugin built from this checkout, drives headless Chrome over CDP, and checks the panel from the
// right-sidebar guide card down to the numbers. A session needs a model: pass `--patch` overlay(s)
// that configure one and `--env-file` with its key (loaded into the child process only, never
// printed). Without them the checks that need a session are reported as skipped.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..', '..', '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const values = (n) => argv.flatMap((a, i) => (a === n ? [argv[i + 1]] : []));
const envFile = values('--env-file')[0];
const extraPatches = values('--patch').map((p) => resolve(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const skip = (name, why) => console.log(`SKIP  ${name}  (${why})`);

function parseEnv(file) {
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const work = mkdtempSync(join(tmpdir(), 'te-browser-'));
let server; let browser;
async function cleanup() {
  try { await browser?.close(); } catch { /* */ }
  try { server?.kill(); } catch { /* */ }
  if (!flag('--keep') && !flag.keepOnError) { await sleep(500); try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* */ } }
  else console.log(`kept: ${work}`);
}

try {
  const pkg = join(work, 'pkg');
  const build = spawnSync('python3', [join(ROOT, 'scripts', 'build_dsh_plugin.py'), '--out', pkg], { encoding: 'utf8' });
  check('the distribution package builds, client.js included', build.status === 0, build.status === 0 ? '' : build.stderr.slice(-300));
  if (build.status !== 0) throw new Error('build failed');

  const repo = join(work, 'repo');
  mkdirSync(join(repo, '.git', 'info'), { recursive: true });
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/widget.git\n');
  const patch = join(work, 'te.yml');
  writeFileSync(patch, `- insert:\n    - id: te-browser\n      name: "file://${pkg}/index.mjs"\n`);
  const state = join(work, 'state');
  const env = { ...process.env, ...(envFile ? parseEnv(envFile) : {}), DSH_HOME: join(work, 'home'), TOKENECONOMIZER_HOME: state, CLAUDE_CONFIG_DIR: join(work, 'claude') };
  const args = ['--profile', 'web', '--patch', patch, ...extraPatches.flatMap((p) => ['--patch', p]), '--port', '0', '--no-open'];
  server = spawn('dsh', args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stdout.on('data', (d) => { out += d; });
  server.stderr.on('data', () => {});
  for (let i = 0; i < 80 && !/dsh web: \S+/.test(out); i += 1) await sleep(500);
  const url = /dsh web: (\S+)/.exec(out)?.[1];
  check('dsh web started with the plugin', Boolean(url));
  if (!url) throw new Error('server did not start');

  browser = await launch({ port: 9400 + Math.floor(Math.random() * 400) });
  await browser.goto(url);
  await browser.waitFor("document.body.innerText.includes('Standard mode')", { label: 'app shell' });
  await sleep(1500);
  const clickByLabel = (label) => browser.evaluate(`(()=>{const e=[...document.querySelectorAll('button,[role=button],[aria-label]')].find(x=>(x.getAttribute('aria-label')||x.innerText.trim())===${JSON.stringify(label)});if(!e)return false;e.click();return true})()`);
  const marks = () => browser.evaluate("[...document.querySelectorAll('[data-te]')].map(e=>e.getAttribute('data-te'))");
  const openPanel = async () => {
    if (!(await browser.evaluate("document.body.innerText.includes('Learned facts, tool pruning')"))) await clickByLabel('Open right sidebar');
    await browser.waitFor("document.body.innerText.includes('Learned facts, tool pruning')", { label: 'guide card' });
    await browser.evaluate(`(()=>{const e=[...document.querySelectorAll('*')].filter(x=>x.children.length<4&&x.innerText&&x.innerText.trim().startsWith('TokenEconomizer')).pop();(e.closest('button,[role=button],a')||e).click()})()`);
    await browser.waitFor("!!document.querySelector('[data-te=ready],[data-te=error]')", { label: 'panel settled' });
  };

  for (const label of ['Continue', 'Close']) {            // the first-run notices of a fresh DSH_HOME
    if (await clickByLabel(label)) await sleep(700);
  }
  await clickByLabel('Open right sidebar');
  await sleep(1200);
  check('the right sidebar offers a TokenEconomizer page with its description', await browser.evaluate("document.body.innerText.includes('Learned facts, tool pruning')"));
  // A draft has no history yet; running a command in it before the first message would stall the
  // draft -> session step in DSH, so the panel is opened only once a session exists.
  if (!extraPatches.length) {
    skip('panel inside a real session', 'no model configured: pass --patch and --env-file');
  } else {
    await browser.evaluate("document.querySelector('[role=textbox]').focus()");
    await browser.send('Input.insertText', { text: 'Reply with the single word ok' });
    await sleep(600);
    await browser.evaluate("document.querySelector('[aria-label=\"Send message\"]').click()");
    await browser.waitFor("!document.body.innerText.includes('Into the Unknown')", { timeout: 45000, label: 'session view' });
    await sleep(6000);
    await openPanel();
    await browser.waitFor("!!document.querySelector('[data-te=ready]')", { timeout: 30000, label: 'ready panel' });
    const m = await marks();
    check('inside a real session the panel reads the core\'s status', m.includes('ready') && m.includes('mechanism-microskills') && m.includes('mechanism-toolprune') && m.includes('mechanism-loopguard'), m.join(','));
    check('an empty ledger says so', m.includes('empty'));
    const repoRoot = /"repo_root":\s*"([^"]+)"/.exec(await browser.evaluate('document.body.innerText'))?.[1];
    check('the panel\'s command ran through the host (its output is in the chat)', Boolean(repoRoot), repoRoot ?? 'no repo_root in the page');
    if (repoRoot) {
      const seed = spawnSync('python3', [join(HERE, 'seed_session.py'), repoRoot, state], { encoding: 'utf8', env: { ...env, PYTHONPATH: ROOT } });
      check('a finished session was folded into the ledger (real hook lifecycle)', seed.status === 0, seed.status === 0 ? '' : seed.stderr.slice(-300));
      await browser.evaluate("document.querySelector('[data-te=refresh]').click()");
      await browser.waitFor("!!document.querySelector('[data-te=stat-Sessions]')", { timeout: 30000, label: 'numbers' });
      const text = await browser.evaluate("document.querySelector('[data-te]').parentElement.innerText");
      check('after Refresh the panel shows the ledger numbers', /Sessions\s*\n?\s*1/.test(text) && /Effective tokens/.test(text) && /Plugin overhead/.test(text), text.replace(/\s+/g, ' ').slice(0, 160));
      check('the cached-token-heavy usage is priced (non-zero effective tokens)', !/Effective tokens\s*\n?\s*0\b/.test(text));
    }
    await browser.screenshot(join(work, 'panel.png'));
    if (flag('--keep')) console.log(`screenshot: ${join(work, 'panel.png')}`);
  }
  const bad = browser.logs.filter((l) => ['error', 'exception'].includes(l.type));
  check('no console errors or exceptions in the page', bad.length === 0, bad.slice(0, 2).map((l) => l.text.slice(0, 120)).join(' | '));
} catch (err) {
  console.log(`ERROR  ${err.message}`);
  try { await browser?.screenshot(join(work, 'error.png')); console.log(`error screenshot: ${join(work, 'error.png')}`); console.log(`page: ${(await browser.evaluate('document.body.innerText')).slice(0, 500).replace(/\n+/g, ' | ')}`); } catch { /* */ }
  if (!flag('--keep')) flag.keepOnError = true;
  results.push({ name: 'run', ok: false });
} finally {
  await cleanup();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
