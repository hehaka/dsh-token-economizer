#!/usr/bin/env node
// Acceptance check of the panel in a real browser against a real `dsh web` (ADR 0003, ADR 0004).
//
//   node plugin/dsh/client/test/browser/browser-check.mjs [--env-file F] [--patch P]... [--keep]
//   node plugin/dsh/client/test/browser/browser-check.mjs --prune [--only panel|prune] [--keep]
//
// Without `--prune`: starts an isolated `dsh web` (own DSH_HOME and TokenEconomizer state, random
// port) with the plugin built from this checkout, drives headless Chrome over CDP, and checks the
// panel from the right-sidebar guide card down to the numbers. A session needs a model: pass `--patch`
// overlay(s) that configure one and `--env-file` with its key (loaded into the child process only,
// never printed). Without them the checks that need a session are reported as skipped.
//
// With `--prune` a second scenario runs against its own `dsh web`, with the REAL core (no stub) and a
// repository whose `.dsh/token-economizer.local.json` denies `read_image`. ONE tiny prompt is sent
// through the UI in a new session; then
//   group `prune`  the first `request/header` of the session log lacks `read_image` and keeps `bash`;
//                  while the server runs exactly one side-call endpoint file exists and a POST to it
//                  answers with the session's model; after SIGTERM the file is gone (or, INFO: remained);
//   group `panel`  the right-sidebar panel shows the `Model calls` row as `active` and a Tool pruning
//                  row whose applied/proposed numbers equal `te status --json` and that names the catalog.
// `--only prune|panel` runs one group only (it still needs `--prune`); both run by default, after the
// old checks. Exit 0 only when every check of the executed groups passed.
//
// The model of the `--prune` scenario: unless `--patch` is given, the profile's own models are used.
// `~/.dsh/profiles/headless/.env` is loaded as the live scripts do (common.mjs `loadProfileEnv`; values
// never printed) and the two entries of that profile that name the models (`llm-pi-ai` and
// `agent-default-model`, so anthropic/claude-haiku-5-5) are lifted from its `cordis.patch.yml` into a
// `--patch` overlay of the `web` profile. DSH_HOME stays ISOLATED: the web profile does not need the
// headless profile's MCP servers (nor its secrets), so sessions land in the temporary home.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..', '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -- command line (strict: an unknown flag or a bad value is a usage error, exit 2) ------------------
const USAGE = `usage: node browser-check.mjs [--env-file FILE] [--patch FILE]... [--keep]
       node browser-check.mjs --prune [--only panel|prune] [--env-file FILE] [--patch FILE]... [--keep]

  --env-file FILE   environment file with the model's key (loaded into the child process only)
  --patch FILE      extra overlay for the web profile (repeatable); configures a model
  --keep            keep the temporary work directory (screenshots)
  --prune           also run the tool-pruning scenario (real core, one prompt); without --patch it uses
                    the models of the headless profile (~/.dsh/profiles/headless)
  --only GROUP      with --prune: run only the group 'panel' (panel rows) or 'prune' (request header,
                    endpoint); default both
  -h, --help        this text`;

function parseCli(args) {
  const o = { keep: false, prune: false, only: undefined, envFile: undefined, patches: [] };
  const bad = (msg) => { console.error(`browser-check: ${msg}\n${USAGE}`); process.exit(2); };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else if (a === '--keep') o.keep = true;
    else if (a === '--prune') o.prune = true;
    else if (a === '--env-file' || a === '--patch' || a === '--only') {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) bad(`${a} needs a value`);
      i += 1;
      if (a === '--patch') o.patches.push(resolve(v));
      else if (a === '--env-file') o.envFile ??= v;
      else o.only = v;
    } else bad(`unknown argument: ${a}`);
  }
  if (o.only !== undefined && !['panel', 'prune'].includes(o.only)) bad(`unknown --only value: ${o.only} (panel or prune)`);
  if (o.only !== undefined && !o.prune) bad('--only needs --prune');
  return o;
}
const cli = parseCli(process.argv.slice(2));
const { envFile, patches: extraPatches } = cli;
const flag = (n) => n === '--keep' && cli.keep;

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const skip = (name, why) => console.log(`SKIP  ${name}  (${why})`);
const info = (name, text) => console.log(`INFO  ${name}: ${text}`);

function parseEnv(file) {
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/**
 * A temporary work directory and its cleanup around one scenario. `body(h)` registers what must be
 * stopped with `h.onCleanup(fn)` and sets `h.browser`; an exception is reported as a failed `run`.
 */
async function withWork(prefix, body) {
  const work = mkdtempSync(join(tmpdir(), prefix));
  const cleanups = [];
  const h = { work, browser: undefined, keepOnError: false, onCleanup: (fn) => cleanups.push(fn) };
  try {
    await body(h);
  } catch (err) {
    console.log(`ERROR  ${err.message}`);
    try { await h.browser?.screenshot(join(work, 'error.png')); console.log(`error screenshot: ${join(work, 'error.png')}`); console.log(`page: ${(await h.browser.evaluate('document.body.innerText')).slice(0, 500).replace(/\n+/g, ' | ')}`); } catch { /* */ }
    if (!flag('--keep')) h.keepOnError = true;
    results.push({ name: 'run', ok: false });
  } finally {
    for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* */ } }
    if (!flag('--keep') && !h.keepOnError) { await sleep(500); try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* */ } }
    else console.log(`kept: ${work}`);
  }
}

/** Builds the distribution package into <work>/pkg (a failing build ends the scenario). */
function buildPackage(work, label = '') {
  const pkg = join(work, 'pkg');
  const build = spawnSync('python3', [join(ROOT, 'scripts', 'build_dsh_plugin.py'), '--out', pkg], { encoding: 'utf8' });
  check(`${label}the distribution package builds, client.js included`, build.status === 0, build.status === 0 ? '' : build.stderr.slice(-300));
  if (build.status !== 0) throw new Error('build failed');
  return pkg;
}

/** A tiny git repository with a github remote, so the plugin resolves a repository name. */
function makeRepo(repo) {
  mkdirSync(join(repo, '.git', 'info'), { recursive: true });
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/widget.git\n');
}

/** `dsh web` in `cwd` (the web session's working directory); resolves to { server, url }. */
async function startServer(h, args, env, cwd) {
  const server = spawn('dsh', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  h.onCleanup(() => { try { server.kill(); } catch { /* */ } });
  let out = '';
  const logFile = join(h.work, 'server.log');             // kept with --keep: what the server said, for a failing run
  server.stdout.on('data', (d) => { out += d; appendFileSync(logFile, d); });
  server.stderr.on('data', (d) => { appendFileSync(logFile, d); });
  for (let i = 0; i < 80 && !/dsh web: \S+/.test(out); i += 1) await sleep(500);
  const url = /dsh web: (\S+)/.exec(out)?.[1];
  return { server, url };
}

/** The page helpers shared by the scenarios (one browser). */
function pageTools(browser) {
  const clickByLabel = (label) => browser.evaluate(`(()=>{const e=[...document.querySelectorAll('button,[role=button],[aria-label]')].find(x=>(x.getAttribute('aria-label')||x.innerText.trim())===${JSON.stringify(label)});if(!e)return false;e.click();return true})()`);
  const marks = () => browser.evaluate("[...document.querySelectorAll('[data-te]')].map(e=>e.getAttribute('data-te'))");
  const openPanel = async () => {
    if (!(await browser.evaluate("document.body.innerText.includes('Learned facts, tool pruning')"))) await clickByLabel('Open right sidebar');
    await browser.waitFor("document.body.innerText.includes('Learned facts, tool pruning')", { label: 'guide card' });
    await browser.evaluate(`(()=>{const e=[...document.querySelectorAll('*')].filter(x=>x.children.length<4&&x.innerText&&x.innerText.trim().startsWith('TokenEconomizer')).pop();(e.closest('button,[role=button],a')||e).click()})()`);
    await browser.waitFor("!!document.querySelector('[data-te=ready],[data-te=error]')", { label: 'panel settled' });
  };
  // Types one prompt into the draft and sends it; returns once the draft has become a session view.
  const sendPrompt = async (text) => {
    await browser.evaluate("document.querySelector('[role=textbox]').focus()");
    await browser.send('Input.insertText', { text });
    await sleep(600);
    await browser.evaluate("document.querySelector('[aria-label=\"Send message\"]').click()");
    await browser.waitFor("!document.body.innerText.includes('Into the Unknown')", { timeout: 45000, label: 'session view' });
  };
  return { clickByLabel, marks, openPanel, sendPrompt };
}

// -- the old checks (without --prune: exactly as before) -----------------------------------------------
async function existingGroup(h) {
  const { work } = h;
  const pkg = buildPackage(work);

  const repo = join(work, 'repo');
  makeRepo(repo);
  const patch = join(work, 'te.yml');
  writeFileSync(patch, `- insert:\n    - id: te-browser\n      name: "file://${pkg}/index.mjs"\n`);
  const state = join(work, 'state');
  const env = { ...process.env, ...(envFile ? parseEnv(envFile) : {}), DSH_HOME: join(work, 'home'), TOKENECONOMIZER_HOME: state, CLAUDE_CONFIG_DIR: join(work, 'claude') };
  const args = ['--profile', 'web', '--patch', patch, ...extraPatches.flatMap((p) => ['--patch', p]), '--port', '0', '--no-open'];
  const { url } = await startServer(h, args, env, repo);
  check('dsh web started with the plugin', Boolean(url));
  if (!url) throw new Error('server did not start');

  const browser = await launch({ port: 9400 + Math.floor(Math.random() * 400) });
  h.browser = browser;
  h.onCleanup(() => browser.close());
  await browser.goto(url);
  await browser.waitFor("document.body.innerText.includes('Standard mode')", { label: 'app shell' });
  await sleep(1500);
  const { clickByLabel, marks, openPanel, sendPrompt } = pageTools(browser);

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
    await sendPrompt('Reply with the single word ok');
    await sleep(6000);
    await openPanel();
    await browser.waitFor("!!document.querySelector('[data-te=ready]')", { timeout: 30000, label: 'ready panel' });
    const m = await marks();
    check('inside a real session the panel reads the core\'s status', m.includes('ready') && m.includes('mechanism-microskills') && m.includes('mechanism-toolprune') && m.includes('mechanism-loopguard'), m.join(','));
    check('an empty ledger says so', m.includes('empty'));
    const repoRoot = /"repo_root":\s*"([^"]+)"/.exec(await browser.evaluate('document.body.innerText'))?.[1];
    check('the panel\'s command ran through the host (its output is in the chat)', Boolean(repoRoot), repoRoot ?? 'no repo_root in the page');
    if (repoRoot) {
      const N = 9;
      const seed = spawnSync('python3', [join(HERE, 'seed_session.py'), repoRoot, state, '--sessions', String(N), '--days', '4', '--facts', '--stuck', '6'], { encoding: 'utf8', env: { ...env, PYTHONPATH: ROOT } });
      check(`${N} finished sessions on different days, with learned facts injected and one looping turn, were folded into the ledger (real hook lifecycle)`, seed.status === 0, seed.status === 0 ? '' : seed.stderr.slice(-300));
      // What the core says was recorded: the DOM is compared with this, not with numbers typed here.
      const truth = JSON.parse(spawnSync('python3', [join(ROOT, 'plugin', 'scripts', 'te_bootstrap.py'), 'cli', '--host', 'dsh', '--cwd', repoRoot, 'panel', '--json'], { encoding: 'utf8', env: { ...env, PYTHONPATH: ROOT } }).stdout).series.sessions;
      const injected = truth.filter((r) => r.injected).length;
      const redirects = truth.reduce((a, r) => a + (r.nudges > 0 ? 1 : 0) + (r.aborts > 0 ? 1 : 0), 0);
      check('the seed really produced injected facts and a redirected loop (the checks below are not vacuous)', injected >= 1 && injected < N && truth.some((r) => r.nudges > 0) && truth.some((r) => r.aborts > 0), `${injected} injected, ${truth.filter((r) => r.nudges > 0).length} session(s) with a redirect`);
      await browser.evaluate("document.querySelector('[data-te=refresh]').click()");
      await browser.waitFor("!!document.querySelector('[data-te=stat-Sessions]') && !!document.querySelector('[data-te=history]')", { timeout: 30000, label: 'numbers and history' });
      const text = await browser.evaluate("document.querySelector('[data-te]').parentElement.innerText");
      check('after Refresh the panel shows the ledger numbers', new RegExp(`Sessions\\s*\\n?\\s*${N}\\b`).test(text) && /Effective tokens/.test(text) && /Plugin overhead/.test(text), text.replace(/\s+/g, ' ').slice(0, 120));
      check('the recorded usage is priced (non-zero effective tokens)', !/Effective tokens\s*\n?\s*0\b/.test(text));

      const q = (expr) => browser.evaluate(expr);
      const bars = await q("(()=>{const c=document.querySelector('[data-te=chart-sessions] svg');return c?+c.getAttribute('data-te-bars'):-1})()");
      check('History: one bar per session in the per-session chart', bars === N, `bars ${bars}`);
      const segs = await q("document.querySelectorAll('[data-te=chart-sessions] [data-te-seg]').length");
      check('History: each bar is stacked from the four recorded parts', segs === N * 4, `segments ${segs}`);
      const sums = await q(`(()=>{const out=[];document.querySelectorAll('[data-te=chart-sessions] [data-te-bar]').forEach(b=>{let t=0;b.querySelectorAll('[data-te-seg]').forEach(r=>{t+=+r.getAttribute('data-te-value')});out.push(Math.round(t))});return out})()`);
      const shown = await q("document.querySelector('[data-te=\"stat-Effective tokens\"]')?.innerText ?? ''");
      const m = /([\d.]+)\s*([kM]?)/.exec(shown.replace('Effective tokens', '').trim());
      const ledgerTokens = m ? Number(m[1]) * (m[2] === 'M' ? 1e6 : m[2] === 'k' ? 1e3 : 1) : NaN;
      const barTotal = sums.reduce((a, b) => a + b, 0);
      check('History: the bars add up to the ledger\'s effective tokens (to the tile\'s rounding)', sums.length === N && Math.abs(barTotal - ledgerTokens) <= Math.max(60, barTotal * 0.0006), `bars ${barTotal}, tile ${shown.replace(/\s+/g, ' ').trim()}`);
      const pts = await q("(()=>{const c=document.querySelector('[data-te=chart-cache] svg');return c?+c.getAttribute('data-te-points'):-1})()");
      check('History: the cache hit rate has a point per session', pts === N, `points ${pts}`);
      const dayBars = await q("(()=>{const c=document.querySelector('[data-te=chart-days] svg');return c?+c.getAttribute('data-te-bars'):-1})()");
      check('History: the per-day chart has one bar per calendar day', dayBars === new Set(truth.map((r) => new Date(r.started * 1000).toDateString())).size, `days ${dayBars}`);
      check('History: the facts-injected marker is drawn once per session that had facts', (await q("document.querySelectorAll('[data-te=chart-sessions] [data-te-marker]').length")) === injected, `${injected} session(s)`);
      check('History: the caption and the chart note the injected sessions', (await q("(()=>{const t=document.querySelector('[data-te=history]').innerText;return t.includes('facts injected in " + injected + "')&&t.includes('facts injected')})()")) === true);
      check('History: the loop-guard chart appears because the guard fired', (await q("!!document.querySelector('[data-te=chart-redirects]')")) === true);
      const rd = await q("(()=>{const c=document.querySelector('[data-te=chart-redirects]');return {bars:+c.querySelector('svg').getAttribute('data-te-bars'),segs:[...c.querySelectorAll('[data-te-seg]')].map(r=>r.getAttribute('data-te-seg')),caption:c.innerText}})()");
      check('History: the loop-guard chart has a bar per session and one segment per redirect and notice', rd.bars === N && rd.segs.length === redirects && rd.segs.includes('nudges') && rd.segs.includes('aborts'), `${rd.bars} bars, segments ${rd.segs.join(',')}`);
      check('History: the tooltip of the looping session carries its 40 requests and its redirect', (await q("[...document.querySelectorAll('[data-te=chart-sessions] [data-te-bar] title')].some(t=>/40 requests/.test(t.textContent)&&/1 redirect\\(s\\), 1 still-stuck/.test(t.textContent))")) === true);
      const geo = await q(`(()=>{const svg=document.querySelector('[data-te=chart-sessions] svg');const box=svg.parentElement.getBoundingClientRect();const w=svg.getBoundingClientRect().width;const bad=[...svg.querySelectorAll('[data-te-seg]')].filter(r=>{const b=r.getBoundingClientRect();return !(b.height>0&&b.width>0)}).length;return {w:Math.round(w),box:Math.round(box.width),bad}})()`);
      check('History: the chart fills its container width and every segment has size', geo.w > 300 && Math.abs(geo.w - geo.box) <= 2 && geo.bad === 0, `svg ${geo.w}px in ${geo.box}px, ${geo.bad} empty segment(s)`);
      check('History: the legend names the parts and the page claims no saving', (await q("(()=>{const t=document.querySelector('[data-te=history]').innerText;return /Cache reads/.test(t)&&/Fresh input/.test(t)&&/Recorded values only/.test(t)&&!/\\bsaved\\b|you save/i.test(t)})()")) === true);
      check('History: a bar carries a tooltip with its session', (await q("/effective tokens/.test(document.querySelector('[data-te=chart-sessions] [data-te-bar] title')?.textContent ?? '')")) === true);

      const rowsBefore = await q("(document.body.innerText.match(/\"schema\":1/g) || []).length");
      await q("document.querySelector('[data-te=range-10]').click()");
      await sleep(800);
      const rowsAfter = await q("(document.body.innerText.match(/\"schema\":1/g) || []).length");
      check('Switching the range re-draws without running another command', (await q("document.querySelector('[data-te=range-10]').getAttribute('aria-pressed')")) === 'true' && rowsAfter === rowsBefore, `command rows ${rowsBefore} -> ${rowsAfter}`);
      await q("document.querySelector('[data-te=history]').scrollIntoView()");
      await sleep(400);
      await browser.screenshot(join(work, 'history.png'));
      if (flag('--keep')) console.log(`screenshot: ${join(work, 'history.png')}`);
      await q("document.querySelector('[data-te=refresh]').click()");
      await sleep(600);
    }
    await browser.screenshot(join(work, 'panel.png'));
    if (flag('--keep')) console.log(`screenshot: ${join(work, 'panel.png')}`);
  }
  const bad = browser.logs.filter((l) => ['error', 'exception'].includes(l.type));
  check('no console errors or exceptions in the page', bad.length === 0, bad.slice(0, 2).map((l) => l.text.slice(0, 120)).join(' | '));
}

// -- the `--prune` scenario ------------------------------------------------------------------------------
const DENIED = 'read_image';                  // a built-in tool that is visible in the profile and harmless to lose
const PRUNE_PROMPT = 'Use the bash tool to run echo te-browser-prune, then reply done';

/**
 * The web profile's `--patch` overlay that carries the headless profile's models: the top-level entries
 * `llm-pi-ai` and `agent-default-model` of its `cordis.patch.yml`, copied as text (no YAML library; the
 * entries name the key's environment variable, not the key, and the MCP servers of that file are left out).
 */
function profileModelPatch(work) {
  const file = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'headless', 'cordis.patch.yml');
  if (!existsSync(file)) throw new Error(`no ${file}: pass --patch with a model configuration`);
  const keep = [];
  let on = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const id = /^- id: (\S+)/.exec(line)?.[1];
    if (id) on = id === 'llm-pi-ai' || id === 'agent-default-model';
    else if (/^\S/.test(line) && !line.startsWith('#')) on = false;
    if (on) keep.push(line);
  }
  const text = keep.join('\n');
  if (!/^- id: llm-pi-ai/m.test(text) || !/^- id: agent-default-model/m.test(text)) throw new Error(`${file} has no llm-pi-ai / agent-default-model entry`);
  const out = join(work, 'headless-models.patch.yml');
  writeFileSync(out, `${text}\n`);
  return out;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };

async function pruneScenario(h, groups) {
  const { work } = h;
  const wantPrune = groups.has('prune');
  const wantPanel = groups.has('panel');
  // The live helpers (profile `.env`, DSH's own session log, endpoint files) are shared with the live scripts.
  const live = await import('../../../test/live/common.mjs');
  const pkg = buildPackage(work, 'prune scenario: ');

  // The web session's workspace is NOT the server's cwd: DSH creates a first-use workspace under
  // `<Documents>/deepseek-harness/default-workspace` and every new session starts there (its `session`
  // event carries that `cwd`). `documentsDirectory` of the workspace controller moves that Documents
  // directory into the work directory, so the repository below is the session's workspace.
  const documents = join(work, 'documents');
  const repo = join(documents, 'deepseek-harness', 'default-workspace');
  makeRepo(repo);

  const patch = join(work, 'te.yml');
  writeFileSync(patch, `- insert:\n    - id: te-browser\n      name: "file://${pkg}/index.mjs"\n- id: workspace-controller\n  name: '@deepseek-ai/dsh-api-workspace-controller'\n  config:\n    documentsDirectory: ${JSON.stringify(documents)}\n`);
  let modelPatches = extraPatches;
  if (!extraPatches.length) {
    live.loadProfileEnv('headless');                 // before DSH_HOME is touched below; values are never printed
    modelPatches = [profileModelPatch(work)];
  }
  const state = join(work, 'state');
  const home = join(work, 'home');
  const env = { ...process.env, ...(envFile ? parseEnv(envFile) : {}), DSH_HOME: home, TOKENECONOMIZER_HOME: state, CLAUDE_CONFIG_DIR: join(work, 'claude') };
  const args = ['--profile', 'web', '--patch', patch, ...modelPatches.flatMap((p) => ['--patch', p]), '--port', '0', '--no-open'];
  // The deny list is written by the core's own writer (`te toolprune apply`, what mode `auto` calls), so the
  // file is `{"tokeneconomizer":{"deny":["read_image"]}}` AND the core records it as applied for this repository
  // (a hand-written file would leave `te status` saying 0 applied, and the panel numbers would be 0 = 0).
  const apply = spawnSync('python3', [join(ROOT, 'plugin', 'scripts', 'te_bootstrap.py'), 'cli', '--host', 'dsh', '--cwd', repo, 'toolprune', 'apply', DENIED], { encoding: 'utf8', env: { ...env, PYTHONPATH: ROOT } });
  let written;
  try { written = JSON.parse(readFileSync(join(repo, '.dsh', 'token-economizer.local.json'), 'utf8')); } catch { /* checked below */ }
  check(`prune scenario: the core wrote the deny list ${DENIED} into .dsh/token-economizer.local.json`, apply.status === 0 && JSON.stringify(written) === JSON.stringify({ tokeneconomizer: { deny: [DENIED] } }), apply.status === 0 ? JSON.stringify(written) : apply.stderr.slice(-200));
  // The session log helpers read DSH_HOME of this process: point them at the isolated home for this scenario.
  const savedHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  h.onCleanup(() => { if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome; });

  const { server, url } = await startServer(h, args, env, repo);      // cwd = the repository: DSH's web session workspace
  check('prune scenario: dsh web started with the plugin in the repository', Boolean(url));
  if (!url) throw new Error('server did not start');

  const browser = await launch({ port: 9400 + Math.floor(Math.random() * 400) });
  h.browser = browser;
  h.onCleanup(() => browser.close());
  await browser.goto(url);
  await browser.waitFor("document.body.innerText.includes('Standard mode')", { label: 'app shell' });
  await sleep(1500);
  const { clickByLabel, openPanel, sendPrompt } = pageTools(browser);
  for (const label of ['Continue', 'Close']) {
    if (await clickByLabel(label)) await sleep(700);
  }

  await sendPrompt(PRUNE_PROMPT);
  const sid = await live.waitFor(() => live.spoolIds(state)[0], 90_000, 500);
  check('prune scenario: the plugin saw one new root session (its spool file)', Boolean(sid) && live.spoolIds(state).length === 1, sid ?? 'no spool file');
  if (!sid) throw new Error('no session');
  const events = () => { try { return live.readSessionEvents(sid); } catch { return []; } };
  const done = await live.waitFor(() => events().some((e) => e.type === 'turn/end'), 150_000, 1000);
  check('prune scenario: the model answered (the turn ended in the session log)', Boolean(done), done ? '' : `event types ${[...new Set(events().map((e) => e.type))].join(',')}`);
  if (!done) throw new Error('no answer');
  const route = events().find((e) => e.type === 'request/context')?.data ?? {};
  info('session model', `${route.provider}/${route.model}`);

  let endpointFile;
  if (wantPrune) {
    // (a) the deny-list took the tool off the first request of the session; the unlisted tools stay
    const tools = live.requestTools(sid);
    check(`prune: the first request/header of the session lacks ${DENIED}`, Array.isArray(tools) && !tools.includes(DENIED), tools ? `${tools.length} tools` : 'no request/header');
    check('prune: ... and still has bash', Array.isArray(tools) && tools.includes('bash'));
    // (b) the side-call endpoint exists while the server runs, and answers on the session's route
    const files = live.endpointFiles(state);
    check('prune: exactly one side-call endpoint file exists while the server runs', files.length === 1, files.join(', ') || 'none');
    if (files.length === 1) {
      endpointFile = join(state, 'hosts', 'dsh', files[0]);
      const owner = Number(/sidecall\.(\d+)\./.exec(files[0])?.[1]);
      h.onCleanup(() => { if (owner && alive(owner)) { try { process.kill(owner, 'SIGKILL'); } catch { /* */ } } });   // never leave the app behind
      let ep = {};
      try { ep = JSON.parse(readFileSync(endpointFile, 'utf8')); } catch { /* checked below */ }
      check('prune: the endpoint file names a port and a token', Number.isInteger(ep.port) && ep.port > 0 && typeof ep.token === 'string' && ep.token.length > 0);
      let status; let body = {};
      try {
        const res = await fetch(`http://127.0.0.1:${ep.port}/v1/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.token}` }, body: JSON.stringify({ prompt: 'Reply with the single word: pong' }), signal: AbortSignal.timeout(120_000) });
        status = res.status;
        body = await res.json();
      } catch (e) { body = { error: String(e).slice(0, 120) }; }
      check('prune: POST /v1/complete answers 200 with text', status === 200 && typeof body.text === 'string' && body.text.trim().length > 0, `status ${status}${body.error ? `, ${typeof body.error === 'object' ? body.error.code : body.error}` : ''}`);
      check('prune: the answer came from the session\'s model', Boolean(route.model) && body.model === route.model, `${body.provider}/${body.model} vs ${route.provider}/${route.model}`);
    }
  }

  if (wantPanel) {
    await openPanel();
    await browser.waitFor("!!document.querySelector('[data-te=ready]')", { timeout: 30000, label: 'ready panel' });
    const rows = await browser.evaluate(`(()=>{const t=s=>document.querySelector(s)?.textContent.trim()??null;return {calls:t('[data-te=modelcalls]'),badge:t('[data-te=modelcalls-state]'),toolprune:t('[data-te=mechanism-toolprune]')}})()`);
    check('panel: the Model calls row exists', typeof rows.calls === 'string' && /Model calls/.test(rows.calls), rows.calls?.slice(0, 60));
    check('panel: the Model calls row shows the badge `active`', rows.badge === 'active', String(rows.badge));
    // The core's own numbers for this repository, from the CLI the way the plugin runs it.
    const cliRun = spawnSync('python3', [join(ROOT, 'plugin', 'scripts', 'te_bootstrap.py'), 'cli', '--host', 'dsh', '--cwd', repo, 'status', '--json'], { encoding: 'utf8', env: { ...env, PYTHONPATH: ROOT } });
    let tp = {};
    try { tp = JSON.parse(cliRun.stdout).toolprune ?? {}; } catch { /* checked below */ }
    const applied = tp.applied?.length; const proposed = tp.proposal?.length;
    check('panel: te status --json answered with the tool-pruning numbers', Number.isInteger(applied) && Number.isInteger(proposed), `applied ${applied}, proposed ${proposed}${cliRun.status ? `, exit ${cliRun.status}` : ''}`);
    const shownApplied = /(\d+) applied/.exec(rows.toolprune ?? '')?.[1];
    const shownProposed = /(\d+) proposed/.exec(rows.toolprune ?? '')?.[1];
    check('panel: the Tool pruning row shows the applied count of te status --json', shownApplied !== undefined && Number(shownApplied) === applied, `${shownApplied} vs ${applied}`);
    check('panel: the Tool pruning row shows the proposed count of te status --json', shownProposed !== undefined && Number(shownProposed) === proposed, `${shownProposed} vs ${proposed}`);
    check('panel: the Tool pruning row names the catalog', /catalog/.test(rows.toolprune ?? ''), (rows.toolprune ?? '').replace(/\s+/g, ' ').slice(0, 140));
    check(`panel: the Tool pruning row names the applied tool (${DENIED})`, (rows.toolprune ?? '').includes(DENIED), (rows.toolprune ?? '').replace(/\s+/g, ' ').slice(0, 140));
    check(`panel: the deny-list's tool (${DENIED}) is among the applied ones`, Number.isInteger(applied) && tp.applied.includes(DENIED), JSON.stringify(tp.applied));
    await browser.evaluate("document.querySelector('[data-te=modelcalls]').scrollIntoView()");
    await sleep(400);
    await browser.screenshot(join(work, 'panel-prune.png'));
    if (flag('--keep')) console.log(`screenshot: ${join(work, 'panel-prune.png')}`);
  }

  if (wantPrune && endpointFile) {
    // (c) the process the endpoint belongs to: DSH may run the app as a child of the `dsh` launcher
    const owner = Number(/sidecall\.(\d+)\./.exec(endpointFile)?.[1]);
    server.kill('SIGTERM');
    const exited = await live.waitFor(() => !alive(owner), 20_000, 200);
    await sleep(500);
    const left = live.endpointFiles(state);
    if (!left.length) check('prune: after SIGTERM the endpoint file is gone', true);
    else info('after SIGTERM the endpoint file remained', `${left.join(', ')}${exited ? '' : ' (its process is still running)'}; the next start sweeps it (live-sessions.mjs covers that)`);
  }
}

// -- run -------------------------------------------------------------------------------------------------
const groups = new Set(cli.only ? [cli.only] : cli.prune ? ['existing', 'prune', 'panel'] : ['existing']);
if (groups.has('existing')) await withWork('te-browser-', existingGroup);
if (groups.has('prune') || groups.has('panel')) await withWork('te-browser-prune-', (h) => pruneScenario(h, groups));

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
