#!/usr/bin/env node
// Live check of per-session model routes (docs/dsh/adr/0004, plan 2026-11-07-dsh-brakujace-kontrole-na-zywo task T2,
// criteria D1 and D2): several sessions on different models in ONE `dsh web` process, and a resumed session.
// About 6-8 tiny model calls on haiku and sonnet.
//
//   node plugin/dsh/test/live/live-multisession.mjs [--profile headless] [--only models|resume] [--model-b provider/model]
//
// Groups (both run by default):
//   models  (D1) one isolated `dsh web` (REAL core, TE_TOOLPRUNE off, own TOKENECONOMIZER_HOME, a temp git repository as
//           the workspace). No browser: the server's own JSON RPC (docs/iterations/1-spike.md Q1) creates two sessions;
//           `session/selectModel` puts A on anthropic/claude-haiku-5-5 and B on --model-b (default
//           anthropic/claude-sonnet-5-5); each gets `Reply with the single word: ok` and is waited for. The route of each
//           is read from its session log (`request/context`), its id from the plugin's spool file name. Then
//           POST /v1/complete {prompt, session} on the plugin's endpoint: A, B, A again, an unknown session, no session.
//           Checks: (a) A's reply names A's route, B's names B's, and they differ; (b) A again = A (nothing leaked from B);
//           (c) the unknown session is 409 NO_ROUTE and not a model answer; (d) no `session` is a 200 (INFO: on which
//           route); (e) every 200 reply carries non-zero usage; (g) the endpoint file is gone once the server is
//           terminated (INFO when it is not). INFO (f), a KNOWN LIMIT and not a failure: what route a call for B gets
//           after `selectModel` and before B's first request (the spike saw the profile default, haiku, not B's choice:
//           the plugin only learns a route from `agent.options` at `agent/created` and from `request/context`).
//   resume  (D2) headless: a session on the profile default (haiku) with a tiny prompt; then
//           `dsh ... --patch <stub> --patch <overlay> --session-id <id>` (same cwd) where the overlay sets the config of
//           `agent-default-model` to --model-b, and the stub core runs in TE_LIVE_ROUTE=1 mode. Checks: (a) the resumed
//           session's `request/context` names --model-b; (b) the stub's UserPromptSubmit row (after `agent/created`,
//           before the first request) is a success that NAMED the session, on --model-b (a reply on the old default is
//           printed as a FINDING and fails); (c) the PostToolUse row (the model runs `echo te-live-resume`) is a success on
//           --model-b (without that row: INFO, the UserPromptSubmit row alone decides).
// Exit 0 only when every check of the executed groups passed (INFOs do not fail). State goes to temp directories;
// credentials come from the profile's `.env` and are never printed; text from replies and errors goes through redact().
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  HERE, REPO, alive, arg, dsh as runDsh, endpointFiles, endpointPost, fakeGitRepo, jsonl, loadProfileEnv, makeChecker, overlay as makeOverlay,
  prepareWork, readSessionEvents, redact, sessionLogFile, sleep, spoolIds, startWeb, tail, waitFor, webClient,
} from './common.mjs';

const USAGE = 'usage: node plugin/dsh/test/live/live-multisession.mjs [--profile headless] [--only models|resume] [--model-b provider/model]';
const KNOWN = new Set(['--profile', '--only', '--model-b']);
const GROUPS = ['models', 'resume'];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (!KNOWN.has(argv[i]) || i + 1 >= argv.length) {
    console.error(`unknown or incomplete argument: ${argv[i]}\n${USAGE}`);
    process.exit(2);
  }
  i += 1;                                               // every flag takes a value
}
const only = arg('--only', undefined);
if (only !== undefined && !GROUPS.includes(only)) {
  console.error(`unknown --only value: ${only}\n${USAGE}`);
  process.exit(2);
}
const profile = arg('--profile', 'headless');
const MODEL_A = 'anthropic/claude-haiku-5-5';
const MODEL_B = arg('--model-b', 'anthropic/claude-sonnet-5-5');
const split = (m) => { const i = m.indexOf('/'); return { provider: m.slice(0, i), model: m.slice(i + 1) }; };
if (!/^[^/\s]+\/[^/\s]+/.test(MODEL_B) || MODEL_B === MODEL_A) {
  console.error(`--model-b must be provider/model and differ from ${MODEL_A}: ${MODEL_B}\n${USAGE}`);
  process.exit(2);
}
const { check, summary } = makeChecker();
const info = (name, value) => console.log(`INFO  ${name}: ${value}`);
const knownLimits = [];
const routeOf = (events) => { const d = events.filter((e) => e.type === 'request/context').at(-1)?.data; return d ? { provider: d.provider, model: d.model } : {}; };
const fmt = (r) => `${r?.provider}/${r?.model}`;
const sameRoute = (a, b) => Boolean(a?.provider && a?.model) && a.provider === b?.provider && a.model === b?.model;
const tokens = (u) => (u && typeof u === 'object' ? ['input_tokens', 'output_tokens'].reduce((n, k) => n + (Number.isFinite(u[k]) ? u[k] : 0), 0) : 0);
const describe = (r) => `HTTP ${r.status} ${fmt(r)} text=${JSON.stringify(redact(r.text ?? '').slice(0, 30))} usage=${tokens(r.usage)} code=${r.code ?? 'none'}`;
const turnEnded = (sid) => () => { try { return readSessionEvents(sid).some((e) => e.type === 'turn/end'); } catch { return false; } };

// -- (A) models: two sessions on different models in one `dsh web` -----------------------------------------------
async function modelsGroup() {
  console.log('\n== models ==');
  loadProfileEnv(profile);                                       // before DSH_HOME is pointed at the isolated home
  const prep = prepareWork('te-dsh-live-multi-models');
  const savedHome = process.env.DSH_HOME;
  let web;
  let owner;
  try {
    web = await startWeb(prep, { TE_TOOLPRUNE: 'off' }, profile);
    process.env.DSH_HOME = web.home;                             // the session-log helpers read it
    check('the isolated dsh web started', Boolean(web.url));
    const client = await webClient(web.url);
    const ws = (await client.rpc('workspace/initializeDefault', {})).value?.workspace?.workspaceId;
    check('the default workspace exists (RPC workspace/initializeDefault)', typeof ws === 'string' && ws.length > 0);

    // One session: create, pick the model, send the tiny prompt; its id is then found in the plugin's spool.
    const start = async (label, pick, prompt) => {
      const created = await client.rpc('session/create', { request: { workspaceId: ws } });
      const id = created.value?.sessionId;
      const m = split(pick);
      const sel = await client.rpc('session/selectModel', { request: { sessionId: id, provider: m.provider, model: m.model } });
      check(`session ${label}: created and put on ${pick} (session/selectModel)`, typeof id === 'string' && sel.ok, sel.ok ? id : `create ${created.status}, select ${redact(sel.error?.code ?? sel.status)}`);
      return { id, pick, prompt, label };
    };
    const send = async (s) => {
      const r = await client.rpc('session/prompt', { request: { sessionId: s.id, requestId: randomUUID(), content: [{ type: 'text', text: s.prompt }], mode: 'queue', clientTimeZone: 'Europe/Warsaw' } });
      check(`session ${s.label}: the prompt was accepted (session/prompt)`, r.ok && r.value?.accepted === true, r.ok ? '' : redact(r.error?.code ?? r.status));
      const spooled = await waitFor(() => spoolIds(web.state).includes(s.id), 90_000, 500);
      const ended = Boolean(spooled) && Boolean(await waitFor(turnEnded(s.id), 150_000, 1000));
      s.route = routeOf(readSessionEvents(s.id));
      check(`session ${s.label}: the plugin spooled it and the turn ended`, ended, ended ? `spool ${s.id}` : `spool ${Boolean(spooled)}, log ${sessionLogFile(s.id) ? 'present' : 'missing'}`);
      check(`session ${s.label}: its session log (request/context) names ${s.pick}`, fmt(s.route) === s.pick, fmt(s.route));
    };
    const prompt = 'Reply with the single word: ok';
    const A = await start('A', MODEL_A, prompt);
    await send(A);
    const files = endpointFiles(web.state);
    check('the plugin published exactly one endpoint file for the process (one per dsh process, not per session)', files.length === 1, files.join(', ') || 'none');
    owner = Number(/sidecall\.(\d+)\./.exec(files[0] ?? '')?.[1]) || undefined;
    const B = await start('B', MODEL_B, prompt);

    // (f) after selectModel, before B's first request: what the endpoint says for B (KNOWN LIMIT, not graded)
    const early = await endpointPost(web.state, { prompt: 'Reply with the single word: pong', session: B.id });
    const earlyText = `HTTP ${early.status}, ${early.status === 200 ? fmt(early) : `code ${early.code}`}`;
    info(`(f) a call naming B after selectModel(${B.pick}) and BEFORE B's first request`, earlyText);
    if (early.status === 200 && fmt(early) !== B.pick) knownLimits.push(`before a session's first model request the plugin's route is the server's default model, not the model chosen by session/selectModel: the call named for B (selected ${B.pick}) was answered by ${fmt(early)}`);
    else if (early.status === 200) info('(f) the early call ran on B\'s selected model', 'the known limit did not show in this run');
    else knownLimits.push(`before a session's first model request a call naming it got ${earlyText} (selected ${B.pick})`);
    await send(B);
    check('the two sessions are different, on different models', A.id !== B.id && fmt(A.route) !== fmt(B.route), `${fmt(A.route)} vs ${fmt(B.route)}`);

    // The five calls of D1.
    const q = { prompt: 'Reply with the single word: pong' };
    const a1 = await endpointPost(web.state, { ...q, session: A.id });
    const b1 = await endpointPost(web.state, { ...q, session: B.id });
    const a2 = await endpointPost(web.state, { ...q, session: A.id });
    const unknown = await endpointPost(web.state, { ...q, session: 'session-does-not-exist' });
    const none = await endpointPost(web.state, q);
    for (const [tag, r] of [['A', a1], ['B', b1], ['A again', a2], ['unknown session', unknown], ['no session', none]]) console.log(`  POST ${tag}: ${describe(r)}`);
    check('(a) A\'s reply names A\'s route (session log)', a1.status === 200 && sameRoute(a1, A.route), `${fmt(a1)} vs ${fmt(A.route)}`);
    check('(a) B\'s reply names B\'s route (session log)', b1.status === 200 && sameRoute(b1, B.route), `${fmt(b1)} vs ${fmt(B.route)}`);
    check('(a) A\'s and B\'s replies are on different models', a1.status === 200 && b1.status === 200 && fmt(a1) !== fmt(b1), `${fmt(a1)} vs ${fmt(b1)}`);
    check('(b) A again is on A\'s route (nothing leaked from B)', a2.status === 200 && sameRoute(a2, A.route), `${fmt(a2)} vs ${fmt(A.route)}`);
    check('(c) an unknown session is 409 NO_ROUTE', unknown.status === 409 && unknown.code === 'NO_ROUTE', `HTTP ${unknown.status}, ${unknown.code}`);
    check('(c) ... and that reply is not a model answer (no text, provider or model)', !unknown.text && !unknown.provider && !unknown.model && tokens(unknown.usage) === 0, describe(unknown));
    check('(d) a call naming no session is HTTP 200 with text', none.status === 200 && Boolean(none.text?.trim()), describe(none));
    info('(d) a call naming no session ran on', `${fmt(none)} = ${sameRoute(none, B.route) ? 'B, the last route observed' : sameRoute(none, A.route) ? 'A (not the last one observed)' : 'neither A nor B'}`);
    for (const [tag, r] of [['A', a1], ['B', b1], ['A again', a2], ['no session', none]]) {
      if (r.status === 200) check(`(e) the ${tag} reply carries non-zero usage`, tokens(r.usage) > 0, `input+output tokens ${tokens(r.usage)}`);
    }

    // (g) the endpoint file once the server is terminated
    if (owner) {
      web.server.kill('SIGTERM');
      const exited = await waitFor(() => !alive(owner), 20_000, 200);
      await sleep(500);
      const left = endpointFiles(web.state);
      if (!left.length) check('(g) after SIGTERM the endpoint file is gone', true);
      else info('(g) after SIGTERM the endpoint file remained', `${left.join(', ')}${exited ? '' : ' (its process is still running)'}; the next start sweeps it (live-sessions.mjs covers that)`);
    } else info('(g) the endpoint file after termination', 'not checked: no endpoint file owner');
  } catch (e) {
    check('the models group ran to the end', false, redact(e?.message ?? e));
  } finally {
    if (web) {
      try { web.server.kill('SIGTERM'); } catch { /* gone */ }
      await sleep(300);
      for (const pid of [owner, web.server.pid]) {              // never leave the app behind
        if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      }
    }
    if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome;
  }
  return prep.work;
}

// -- (B) resume: the route of a session resumed on another default model ---------------------------------------------
async function resumeGroup() {
  console.log('\n== resume ==');
  loadProfileEnv(profile);
  const { work, pkg, entry } = prepareWork('te-dsh-live-multi-resume');
  fakeGitRepo(join(work, 'repo'));
  const stub = join(pkg, 'test-stub-core.py');
  copyFileSync(join(HERE, 'stub_core.py'), stub);
  const real = makeOverlay(work, entry, 'real', {});
  const stubbed = makeOverlay(work, entry, 'stub', { bootstrap: stub });
  const m = split(MODEL_B);
  const overlayB = join(work, 'default-model-b.patch.yml');
  writeFileSync(overlayB, `- id: agent-default-model\n  name: "@deepseek-ai/dsh-agent-default-model"\n  config:\n    provider: ${m.provider}\n    model: ${m.model}\n`);
  const state = join(work, 'state');
  const sideFile = join(work, 'side.jsonl');
  const hooksFile = join(work, 'hooks.jsonl');
  const base = { TOKENECONOMIZER_HOME: state, CLAUDE_CONFIG_DIR: join(work, 'claude'), TE_FOLD_SYNC: '1' };

  // Run 1: a new session on the profile default.
  const r1 = runDsh(work, ['--profile', profile, '--patch', real, 'Reply with the single word: ok'], base, 240_000);
  check('run 1 (new session, profile default model): the headless run exited 0', r1.status === 0, `exit ${r1.status}`);
  if (r1.status !== 0) console.log(redact(tail(r1.stderr)));
  const sid = spoolIds(state)[0];
  check('run 1: the plugin spooled one session (its id is the spool file name)', Boolean(sid) && spoolIds(state).length === 1, sid ?? 'none');
  if (!sid) return work;
  const first = routeOf(readSessionEvents(sid));
  check(`run 1: the session ran on the profile default, not on ${MODEL_B} (so the resume below is not vacuous)`, Boolean(first.model) && fmt(first) !== MODEL_B, fmt(first));

  // Run 2: the same session id, the default model overlaid with --model-b, the stub core in route mode.
  const env2 = { ...base, TE_LIVE_LOG: hooksFile, TE_LIVE_SIDE: sideFile, TE_LIVE_ROUTE: '1', TE_LIVE_RUNNER: '', TE_LIVE_REPO: REPO };
  const r2 = runDsh(work, ['--profile', profile, '--patch', stubbed, '--patch', overlayB, '--session-id', sid,
    'Use the bash tool to run `echo te-live-resume`, then reply: done'], env2, 300_000);
  check(`run 2 (resume ${sid} with the default model overlaid by ${MODEL_B}): the headless run exited 0`, r2.status === 0, `exit ${r2.status}`);
  if (r2.status !== 0) console.log(redact(tail(r2.stderr)));
  const routes = readSessionEvents(sid).filter((e) => e.type === 'request/context').map((e) => `${e.data?.provider}/${e.data?.model}`);
  console.log(`  request/context routes of the session, in order: ${routes.join(', ')}`);
  check(`(a) the resumed session's request/context names ${MODEL_B}`, routes.length >= 2 && routes.at(-1) === MODEL_B, routes.at(-1) ?? 'none');

  const rows = jsonl(sideFile);
  const hooks = jsonl(hooksFile).map((x) => x.payload?.hook_event_name);
  const row = (phase) => rows.find((x) => x.phase === phase);
  console.log(`  hooks the stub core saw in run 2: ${hooks.join(', ') || 'none'}; side rows: ${rows.map((x) => x.phase).join(', ') || 'none'}`);
  const verdict = (x) => {
    const got = fmt(x?.reply);
    return `${got} vs ${MODEL_B}, text ${JSON.stringify(redact(x?.text ?? '').slice(0, 30))}, error ${redact(x?.error ?? x?.reply?.error?.code ?? 'none')}`;
  };
  const good = (x) => Boolean(x) && !x.error && Boolean(x.text) && fmt(x.reply) === MODEL_B;
  const ups = row('UserPromptSubmit');
  if (ups && fmt(ups.reply) === fmt(first)) console.log(`FINDING: the UserPromptSubmit side call of the RESUMED session ran on the old default model ${fmt(first)}, not on ${MODEL_B}`);
  check(`(b) UserPromptSubmit (after agent/created, before the first request): the side call succeeded on ${MODEL_B}`, good(ups), ups ? verdict(ups) : 'no row');
  check('(b) ... and its request named the resumed session (TE_DSH_SESSION)', Boolean(ups) && ups.session === sid, `${ups?.session ?? 'none'} vs ${sid}`);
  const pt = row('PostToolUse');
  if (!pt) info('(c) PostToolUse row', `none (the stub core got ${hooks.includes('PostToolUse') ? 'a PostToolUse hook without a row' : 'no PostToolUse hook'} in the resumed session); the UserPromptSubmit row alone decides`);
  else {
    if (fmt(pt.reply) === fmt(first)) console.log(`FINDING: the PostToolUse side call of the RESUMED session ran on the old default model ${fmt(first)}`);
    check(`(c) PostToolUse (after the first request): the side call succeeded on ${MODEL_B}`, good(pt), verdict(pt));
    check('(c) ... and its request named the resumed session (TE_DSH_SESSION)', pt.session === sid, `${pt.session ?? 'none'} vs ${sid}`);
  }
  info('SessionStart side call of the resumed run', row('SessionStart') ? (row('SessionStart').reply?.error?.code === 'NO_ROUTE' ? 'NO_ROUTE (before agent/created)' : `${fmt(row('SessionStart').reply)}`) : 'no row');
  return work;
}

// ---------------------------------------------------------------------------------------------------------------
let work = '(none)';
if (only === undefined || only === 'models') work = await modelsGroup();
if (only === undefined || only === 'resume') work = await resumeGroup();
for (const k of knownLimits) console.log(`KNOWN LIMIT: ${k}`);
process.exit(summary(work) ? 1 : 0);
