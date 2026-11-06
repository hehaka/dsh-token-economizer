import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPlugin } from '../src/plugin.mjs';
import { BOOTSTRAP, dshEvents, fakeCtx, fakeRepo, findFiles, isolatedEnv, readJsonl, rootSession, subSession, tmp } from './helpers.mjs';

const exec = (session, id, name, args) => ({ id, name, arguments: JSON.stringify(args), agent: { session } });
const passthrough = async () => ({ kind: 'accept' });

function setup(extra = {}) {
  const root = tmp();
  const repo = fakeRepo(root);
  const env = isolatedEnv(root);
  const ctx = fakeCtx();
  const plugin = createPlugin(ctx, { env, bootstrap: BOOTSTRAP, ...extra });
  return { root, repo, env, ctx, plugin };
}

async function drive(ctx, session) {
  ctx.handlers['session/created'][0](session);
  for (const e of dshEvents()) {
    ctx.handlers['session/event'][0](session, e);
    if (e.type === 'tool/result') {
      const call = readJsonl(join(session.header.stateSpool)).filter((r) => r.message?.role === 'assistant').at(-1).message.content.find((b) => b.type === 'toolCall');
      await ctx.handlers['tools/post-execute'][0](exec(session, call.id, call.name, call.arguments), { content: e.data.message.content, isError: e.data.message.isError }, passthrough);
    }
  }
  await ctx.handlers['agent/turn-stopping'][0]({ agent: { session } });
  ctx.handlers['session/disposed'][0](session);
}

test('a session is followed from start to a folded ledger record, through the real dispatcher', async () => {
  const { root, repo, env, ctx, plugin } = setup();
  const session = rootSession('dsh-1', repo);
  session.header.stateSpool = join(env.TOKENECONOMIZER_HOME, 'dsh-sessions', 'dsh-1.jsonl');
  await drive(ctx, session);
  await plugin.idle();

  const state = findFiles(env.TOKENECONOMIZER_HOME, join('dsh-1.json'));
  const sess = JSON.parse(readFileSync(state.find((f) => f.includes(join('sessions', 'dsh-1.json'))), 'utf8'));
  assert.equal(sess.turn, null);
  assert.equal(sess.turns.length, 1);
  assert.equal(sess.turns[0].tool_calls, 3);

  const ledger = findFiles(env.TOKENECONOMIZER_HOME, 'ledger.jsonl');
  assert.equal(ledger.length, 1);
  assert.ok(ledger[0].includes(`${join('dsh')}`), 'state is kept under the dsh agent, apart from Pi\'s');
  const rec = readJsonl(ledger[0]).find((r) => r.kind === 'session');
  assert.equal(rec.requests, 3);
  assert.equal(rec.model, 'claude-haiku-5-5');
  assert.equal(rec.output_tokens, 315);
  assert.equal(rec.priced_by, 'model');
  assert.ok(root);
});

test('a subagent session is not followed', async () => {
  const { repo, env, ctx, plugin } = setup();
  const sub = subSession('sub-1', repo);
  ctx.handlers['session/created'][0](sub);
  for (const e of dshEvents()) ctx.handlers['session/event'][0](sub, e);
  const decision = await ctx.handlers['tools/post-execute'][0](exec(sub, 'c1', 'bash', { command: 'ls' }), { content: [] }, passthrough);
  assert.deepEqual(decision, { kind: 'accept' });
  await plugin.idle();
  assert.equal(plugin.states.size, 0);
  assert.equal(existsSync(join(env.TOKENECONOMIZER_HOME, 'dsh-sessions', 'sub-1.jsonl')), false);
});

test('what the core answers rides back as context, and a failing core changes nothing', async () => {
  const calls = [];
  const answers = { SessionStart: { hookSpecificOutput: { additionalContext: 'FACTS' } }, PostToolUse: { hookSpecificOutput: { additionalContext: 'STOP LOOPING' } } };
  const { ctx, repo, plugin } = setup({ run: async (p) => (calls.push(p.hook_event_name), answers[p.hook_event_name] ?? {}) });
  const session = rootSession('s9', repo);
  ctx.handlers['session/created'][0](session);
  const resolved = await ctx.handlers['system-prompt/assemble'][0]({}, { agent: { session } }, async () => ({ contexts: [{ name: 'other', text: 'x' }] }));
  assert.deepEqual(resolved.contexts.map((c) => c.name), ['other', 'tokeneconomizer']);
  assert.equal(resolved.contexts[1].text, 'FACTS');

  const decision = await ctx.handlers['tools/post-execute'][0](exec(session, 'c1', 'bash', { command: 'ls' }), { content: [{ type: 'text', text: 'x' }] }, passthrough);
  assert.equal(decision.kind, 'accept');
  assert.equal(decision.additionalContexts.length, 1);
  assert.equal(decision.additionalContexts[0].role, 'user');
  assert.equal(decision.additionalContexts[0].content[0].text, 'STOP LOOPING');
  assert.deepEqual(decision.additionalContexts[0].source, { kind: 'token-economizer' });
  await plugin.idle();
  assert.deepEqual(calls.slice(0, 2), ['SessionStart', 'PostToolUse']);

  const bad = setup({ run: async () => { throw new Error('boom'); } });
  const s2 = rootSession('s10', repo);
  bad.ctx.handlers['session/created'][0](s2);
  const d2 = await bad.ctx.handlers['tools/post-execute'][0](exec(s2, 'c1', 'bash', { command: 'ls' }), { content: [] }, passthrough);
  assert.deepEqual(d2, { kind: 'accept' });
});

test('TE_DISABLE turns the plugin off', () => {
  const ctx = fakeCtx();
  assert.equal(createPlugin(ctx, { env: { TE_DISABLE: '1' } }), null);
  assert.deepEqual(ctx.handlers, {});
});
