#!/usr/bin/env node
// Live check of the DSH side-call endpoint (docs/dsh/adr/0004) through the core's real runner:
// one `dsh headless` session, ~3 tiny model calls.
//
//   node plugin/dsh/test/live/live-sidecall.mjs [--profile headless] [--only paid|route]
//        [--paid-a azure-openai-responses/gpt-6-luna] [--paid-b claude-sonnet-5-5]
//
// Groups:
//   paid   the stub core calls `sidecall.runner_for("dsh", cfg)` for three `paid_model` variants:
//          "" (the session's own route), A (`provider/model`), B (a bare model id, which keeps the
//          session's provider); the endpoint's raw reply says what ran. Each hook process runs ONE
//          variant (DSH kills a hook after 20 s), so the session makes three separate bash calls =
//          three PostToolUse hooks; fewer than three variant rows fails the checks.
//   route  (task T4) one session, env TE_LIVE_ROUTE=1: the stub core runs the real runner with
//          `paid_model` "" ONCE on each of SessionStart, UserPromptSubmit and PostToolUse and records the
//          raw reply plus what a mechanism would charge. Checks: SessionStart (before `agent/created`,
//          so possibly no route yet) is either a clean NO_ROUTE (empty text, charge 0) or a success on
//          the session's route (it raced `agent/created`; which one happened is printed as INFO);
//          UserPromptSubmit (after `agent/created`, before the first model request) and PostToolUse
//          succeed on the session's provider/model; the host's side calls are not paused; all three
//          rows exist. The session's route is read from its log (`request/context`).
// State goes to a temp directory (TOKENECONOMIZER_HOME, CLAUDE_CONFIG_DIR). Credentials come from
// the profile's `.env`; the script never prints them itself. What it prints from provider-supplied
// text (`row.error`, the raw reply fields other than `text`, setup errors, the stderr tail) goes
// through redact(): cut to 200 characters, any run of 24+ [A-Za-z0-9_-] replaced by <redacted>.
// That is a best-effort filter for key-like tokens, not a proof that nothing secret is shown.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HERE, REPO, arg, dsh as runDsh, fakeGitRepo, jsonl, loadProfileEnv, makeChecker, overlay as makeOverlay,
  prepareWork, readSessionEvents, sessionLogFile, tail,
} from './common.mjs';

const USAGE = 'usage: node plugin/dsh/test/live/live-sidecall.mjs [--profile headless] [--only paid|route] [--paid-a provider/model] [--paid-b model]';
const KNOWN = new Set(['--profile', '--only', '--paid-a', '--paid-b']);
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (!KNOWN.has(argv[i]) || i + 1 >= argv.length) {
    console.error(`unknown or incomplete argument: ${argv[i]}\n${USAGE}`);
    process.exit(2);
  }
  i += 1;                                               // every flag takes a value
}
const only = arg('--only', undefined);
if (only !== undefined && only !== 'paid' && only !== 'route') {
  console.error(`unknown --only value: ${only}\n${USAGE}`);
  process.exit(2);
}
const profile = arg('--profile', 'headless');
const paidA = arg('--paid-a', 'azure-openai-responses/gpt-6-luna');
const paidB = arg('--paid-b', 'claude-sonnet-5-5');
const { check, summary } = makeChecker();

/** Best-effort scrub of provider-supplied text before printing: 200 chars, long token-like runs hidden. */
const redact = (v) => String(v ?? '').slice(0, 200).replace(/[A-Za-z0-9_-]{24,}/g, '<redacted>');

async function paidGroup() {
  loadProfileEnv(profile);
  const { work, pkg, entry } = prepareWork('te-dsh-live-sidecall');
  fakeGitRepo(join(work, 'repo'));
  const stub = join(pkg, 'test-stub-core.py');
  writeFileSync(stub, readFileSync(join(HERE, 'stub_core.py')));
  const logFile = join(work, 'hooks.jsonl');
  const sideFile = join(work, 'side.jsonl');
  const patch = makeOverlay(work, entry, 'stub', { bootstrap: stub });
  const env = {
    TOKENECONOMIZER_HOME: join(work, 'state'), CLAUDE_CONFIG_DIR: join(work, 'claude'), TE_FOLD_SYNC: '1',
    TE_LIVE_LOG: logFile, TE_LIVE_SIDE: sideFile, TE_LIVE_RUNNER: '1', TE_LIVE_REPO: REPO,
    TE_LIVE_PAID: JSON.stringify(['', paidA, paidB]),
  };
  const r = runDsh(work, ['--profile', profile, '--patch', patch,
    'Call the bash tool three times, as three separate tool calls one after another (never combine them): '
      + 'first `echo te-live-sidecall-1`, then `echo te-live-sidecall-2`, then `echo te-live-sidecall-3`. Then reply: done'], env, 300_000);
  check('the headless run finished', r.status === 0, `exit ${r.status}`);
  if (r.status !== 0) console.log(redact(tail(r.stderr)));

  // The session's own route, from DSH's log: what a call without paid_model runs on.
  const calls = jsonl(logFile).map((x) => x.payload);
  const spool = calls.find((p) => p.transcript_path)?.transcript_path;
  const sid = spool && /session-[0-9a-f-]+/.exec(spool)?.[0];
  const ctx = readSessionEvents(sid).find((e) => e.type === 'request/context');
  const route = { provider: ctx?.data?.provider, model: ctx?.data?.model };
  check('the session log names the session\'s route (request/context)', Boolean(route.provider && route.model),
    route.provider ? `${route.provider}/${route.model}` : (sessionLogFile(sid) ? 'no request/context event' : 'session log not found'));

  const rows = jsonl(sideFile);
  const rowOf = (variant) => rows.find((x) => x.variant === variant);
  const setup = rows.find((x) => x.variant === null);
  if (setup) console.log(`setup failed: ${redact(setup.error)}`);
  const variantRows = rows.filter((x) => x.variant !== null && x.variant !== undefined);
  check('at least three variant rows were written (one per PostToolUse hook)', variantRows.length >= 3, `${variantRows.length} variant row(s) found, ${rows.length} row(s) in side.jsonl`);
  const variants = [['own route', ''], [`A (${paidA})`, paidA], [`B (${paidB})`, paidB]];
  for (const [label, v] of variants) {
    const row = rowOf(v);
    check(`variant ${label}: the stub core ran the runner`, Boolean(row), row ? '' : `${rows.length} row(s) in side.jsonl`);
  }
  const rep = (v) => rowOf(v)?.reply;
  const sameRoute = rep('')?.provider === route.provider && rep('')?.model === route.model;
  check('variant "" -> the reply names the session\'s own provider and model', sameRoute, `${rep('')?.provider}/${rep('')?.model} vs ${route.provider}/${route.model}`);
  const slash = paidA.indexOf('/');
  const [aProv, aModel] = [paidA.slice(0, slash), paidA.slice(slash + 1)];
  check(`variant A -> provider ${aProv}, model ${aModel}`, rep(paidA)?.provider === aProv && rep(paidA)?.model === aModel, `${rep(paidA)?.provider}/${rep(paidA)?.model}`);
  check(`variant B (bare) -> the session's provider, model ${paidB}`, rep(paidB)?.provider === route.provider && rep(paidB)?.model === paidB, `${rep(paidB)?.provider}/${rep(paidB)?.model}`);
  for (const [label, v] of variants) {
    const row = rowOf(v);
    check(`variant ${label}: non-empty text and priced (effective > 0)`, Boolean(row?.text) && row.effective > 0, `text ${JSON.stringify((row?.text ?? '').slice(0, 40))}, effective ${row?.effective}`);
    if (row?.error) console.log(`  error (${label}): ${redact(row.error)}`);
  }
  check('the three replies carry usage with a numeric input_tokens', variants.every(([, v]) => Number.isFinite(rep(v)?.usage?.input_tokens)),
    variants.map(([, v]) => rep(v)?.usage?.input_tokens ?? 'none').join(', '));
  for (const row of rows) console.log(`  reply[${JSON.stringify(row.variant)}]: ${redact(JSON.stringify({ ...row.reply, text: undefined }))} text=${JSON.stringify((row.text ?? '').slice(0, 60))}`);
  return work;
}

async function routeGroup() {
  loadProfileEnv(profile);
  const { work, pkg, entry } = prepareWork('te-dsh-live-route');
  fakeGitRepo(join(work, 'repo'));
  const stub = join(pkg, 'test-stub-core.py');
  writeFileSync(stub, readFileSync(join(HERE, 'stub_core.py')));
  const logFile = join(work, 'hooks.jsonl');
  const sideFile = join(work, 'side.jsonl');
  const stateDir = join(work, 'state');
  const patch = makeOverlay(work, entry, 'stub', { bootstrap: stub });
  const env = {
    TOKENECONOMIZER_HOME: stateDir, CLAUDE_CONFIG_DIR: join(work, 'claude'), TE_FOLD_SYNC: '1',
    TE_LIVE_LOG: logFile, TE_LIVE_SIDE: sideFile, TE_LIVE_ROUTE: '1', TE_LIVE_REPO: REPO,
  };
  const r = runDsh(work, ['--profile', profile, '--patch', patch,
    'Use the bash tool to run `echo te-live-route`, then reply: done'], { ...env, TE_LIVE_RUNNER: '' }, 300_000);   // TE_LIVE_RUNNER blanked: route mode only
  check('the headless run finished', r.status === 0, `exit ${r.status}`);
  if (r.status !== 0) console.log(redact(tail(r.stderr)));

  const calls = jsonl(logFile).map((x) => x.payload);
  const spool = calls.find((p) => p.transcript_path)?.transcript_path;
  const sid = spool && /session-[0-9a-f-]+/.exec(spool)?.[0];
  const ctx = readSessionEvents(sid).find((e) => e.type === 'request/context');
  const route = { provider: ctx?.data?.provider, model: ctx?.data?.model };
  check('the session log names the session\'s route (request/context)', Boolean(route.provider && route.model),
    route.provider ? `${route.provider}/${route.model}` : (sessionLogFile(sid) ? 'no request/context event' : 'session log not found'));

  const rows = jsonl(sideFile);
  const row = (phase) => rows.find((x) => x.phase === phase);
  const names = ['SessionStart', 'UserPromptSubmit', 'PostToolUse'];
  const hooked = names.filter((n) => calls.some((p) => p.hook_event_name === n));
  check('all three rows exist (SessionStart, UserPromptSubmit, PostToolUse)', names.every((n) => row(n)),
    `${rows.filter((x) => names.includes(x.phase)).length} of 3 row(s) found; rows: ${rows.map((x) => x.phase).join(', ') || 'none'}; hooks seen: ${hooked.join(', ') || 'none'}`);
  const onRoute = (x) => x?.reply?.provider === route.provider && x?.reply?.model === route.model;
  const succeeded = (x) => Boolean(x) && !x.error && typeof x.reply?.text === 'string' && Boolean(x.text) && onRoute(x);
  const detail = (x) => (x ? `${x.reply?.provider}/${x.reply?.model} vs ${route.provider}/${route.model}, text ${JSON.stringify((x.text ?? '').slice(0, 30))}, effective ${x.effective}, charge ${x.charge}, error ${redact(x.error ?? x.reply?.error?.code ?? 'none')}` : 'no row');

  const ss = row('SessionStart');
  const clean = Boolean(ss) && ss.reply?.error?.code === 'NO_ROUTE' && !ss.text && ss.charge === 0;
  const won = Boolean(ss) && succeeded(ss) && ss.effective > 0;
  check('SessionStart: a clean NO_ROUTE (empty text, nothing charged) or a success on the session\'s route', clean || won,
    detail(ss));
  console.log(`INFO  SessionStart call: ${clean ? 'NO_ROUTE (the call came before agent/created)' : won ? 'success (the call raced agent/created and found the route)' : 'neither'}`);

  const ups = row('UserPromptSubmit');
  check('UserPromptSubmit: success on the session\'s provider/model, non-empty text, effective > 0',
    succeeded(ups) && ups.effective > 0, detail(ups));
  const pt = row('PostToolUse');
  check('PostToolUse: success on the session\'s route', succeeded(pt), detail(pt));
  check('the host\'s side calls were not paused', !existsSync(join(stateDir, 'hosts', 'dsh', 'sidecall.json')),
    join(stateDir, 'hosts', 'dsh', 'sidecall.json'));
  for (const x of rows) console.log(`  row[${x.phase ?? x.variant}]: ${redact(JSON.stringify({ ...x.reply, text: undefined }))} text=${JSON.stringify((x.text ?? '').slice(0, 60))} effective=${x.effective} charge=${x.charge}${x.error ? ` error=${redact(x.error)}` : ''}`);
  return work;
}

let work = '(none)';
if (only !== 'route') work = await paidGroup();
if (only === undefined || only === 'route') work = await routeGroup();
process.exit(summary(work) ? 1 : 0);
