import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPlugin } from '../src/plugin.mjs';
import { Spool, unproxy } from '../src/spool.mjs';
import { DENY_FILE, applyDeny, catalogPath, readDeny, toolNames, writeCatalog } from '../src/tools.mjs';
import { BOOTSTRAP, fakeCtx, fakeRepo, isolatedEnv, readJsonl, rootSession, subSession, tmp } from './helpers.mjs';

const ALL = ['bash', 'read', 'tool_call', 'mcp__crm__search', 'mcp__crm__update', 'mcp__docs__lookup'];
const registry = (names = ALL) => ({ schemas: () => names.map((name) => ({ name, description: '', parameters: {} })) });
// What DSH's `restrict` does with a name it does not know.
const strictAgent = (known = ALL) => {
  const restricted = [];
  return {
    restricted,
    agent: (session) => ({ session, ctx: { tools: { restrict: (f) => { for (const n of f.deny) if (!known.includes(n)) throw new Error(`unknown global tool "${n}"`); restricted.push(...f.deny); return () => {}; } } } }),
  };
};
const writeDeny = (repo, deny, extra = {}) => {
  mkdirSync(join(repo, '.dsh'), { recursive: true });
  writeFileSync(join(repo, DENY_FILE), JSON.stringify({ tokeneconomizer: { deny }, ...extra }));
};

function setup(over = {}) {
  const root = tmp();
  const repo = fakeRepo(root);
  const env = isolatedEnv(root);
  const ctx = fakeCtx();
  ctx.tools = registry();
  const plugin = createPlugin(ctx, { env, bootstrap: BOOTSTRAP, closeOnExit: false, run: async () => ({}), ...over });
  return { root, repo, env, ctx, plugin, state: env.TOKENECONOMIZER_HOME };
}

test('the deny list is read from the repository file, tolerating anything else', () => {
  const root = tmp();
  assert.deepEqual(readDeny(root), []);                                         // no file
  writeDeny(root, ['mcp__a__b', 'mcp__a__b', '', 7, 'mcp__c__d']);
  assert.deepEqual(readDeny(root), ['mcp__a__b', 'mcp__c__d']);                // deduplicated, strings only
  writeFileSync(join(root, DENY_FILE), '{ not json');
  assert.deepEqual(readDeny(root), []);
  writeFileSync(join(root, DENY_FILE), JSON.stringify({ tokeneconomizer: { deny: 'mcp__a__b' } }));
  assert.deepEqual(readDeny(root), []);
  writeFileSync(join(root, DENY_FILE), JSON.stringify([1, 2]));
  assert.deepEqual(readDeny(root), []);
  assert.equal(DENY_FILE, join('.dsh', 'token-economizer.local.json'));          // the path the core writes
});

test('the tool list is read from DSH\'s registry; a missing or broken one is an empty list', () => {
  assert.deepEqual(toolNames(registry(['b', 'a', 'b', ''])), ['a', 'b']);
  assert.deepEqual(toolNames(undefined), []);
  assert.deepEqual(toolNames({}), []);
  assert.deepEqual(toolNames({ schemas() { throw new Error('boom'); } }), []);
  assert.deepEqual(toolNames({ schemas: () => 'nope' }), []);
  assert.deepEqual(toolNames({ schemas: () => [null, { name: 3 }, { name: 'x' }] }), ['x']);
});

test('the catalog is written for the core, owner-only, and only when it changed', () => {
  const state = join(tmp(), 'state');
  assert.equal(writeCatalog(state, []), false);
  assert.equal(existsSync(catalogPath(state)), false);
  assert.equal(writeCatalog(state, ['a', 'b']), true);
  const doc = JSON.parse(readFileSync(catalogPath(state), 'utf8'));
  assert.deepEqual(doc.tools, ['a', 'b']);                                      // the format `te toolprune refresh-catalog` writes
  assert.equal(statSync(catalogPath(state)).mode & 0o777, 0o600);
  const mtime = statSync(catalogPath(state)).mtimeMs;
  assert.equal(writeCatalog(state, ['a', 'b']), false);
  assert.equal(statSync(catalogPath(state)).mtimeMs, mtime);
  assert.equal(writeCatalog(state, ['a', 'b', 'c']), true);
  assert.deepEqual(JSON.parse(readFileSync(catalogPath(state), 'utf8')).tools, ['a', 'b', 'c']);
});

test('only tools DSH knows are passed to restrict, which throws for any other name', () => {
  const { restricted, agent } = strictAgent();
  assert.deepEqual(applyDeny(agent(rootSession('s', '/r')), ['mcp__crm__update', 'mcp__gone__tool'], ALL), ['mcp__crm__update']);
  assert.deepEqual(restricted, ['mcp__crm__update']);
  assert.deepEqual(applyDeny(agent(rootSession('s', '/r')), ['mcp__gone__tool'], ALL), []);   // nothing to hide: restrict({}) would throw
  assert.deepEqual(restricted, ['mcp__crm__update']);
});

test('an agent is created: the tool list is recorded and the deny list hides its tools', async () => {
  const { repo, ctx, state } = setup();
  writeDeny(repo, ['mcp__crm__update', 'mcp__docs__lookup', 'mcp__removed__tool']);
  const { restricted, agent } = strictAgent();
  await ctx.handlers['agent/created'][0]({ agent: agent(rootSession('a1', repo)), source: 'new' });
  assert.deepEqual(restricted, ['mcp__crm__update', 'mcp__docs__lookup']);
  assert.deepEqual(JSON.parse(readFileSync(catalogPath(state), 'utf8')).tools, [...ALL].sort());   // the full list, not the masked one
});

// DSH's web profile puts the model-facing tools on the agent plane (an ancestor layer of the agent's
// scope), so the registry's global view lists almost nothing (found live: `working_directory` only) and only
// `schemas(agent)` shows what the agent can call and what `restrict` accepts.
const scoped = (globalNames, byAgent) => ({
  schemas: (scope) => (scope ? byAgent : globalNames).map((name) => ({ name, description: '', parameters: {} })),
});

test('the registry is read as the agent sees it: tools on the agent plane are known, recorded and hidden', async () => {
  const { repo, ctx, state } = setup();
  ctx.tools = scoped(['working_directory'], [...ALL, 'working_directory']);
  writeDeny(repo, ['mcp__crm__update', 'bash']);
  const { restricted, agent } = strictAgent([...ALL, 'working_directory']);
  await ctx.handlers['agent/created'][0]({ agent: agent(rootSession('a1', repo)), source: 'new' });
  assert.deepEqual(restricted, ['mcp__crm__update', 'bash']);                                          // not dropped as "unknown"
  assert.deepEqual(JSON.parse(readFileSync(catalogPath(state), 'utf8')).tools, [...ALL, 'working_directory'].sort());
});

test('toolNames passes the viewing scope on to the registry', () => {
  assert.deepEqual(toolNames(scoped(['g'], ['a', 'b']), { id: 'agent' }), ['a', 'b']);
  assert.deepEqual(toolNames(scoped(['g'], ['a', 'b'])), ['g']);                                       // no scope: the global view, as before
});

test('a subagent is not restricted, and its tools are not the catalog\'s business', async () => {
  const { repo, ctx, state } = setup();
  writeDeny(repo, ['mcp__crm__update']);
  const { restricted, agent } = strictAgent();
  await ctx.handlers['agent/created'][0]({ agent: agent(subSession('child', repo)) });
  assert.deepEqual(restricted, []);
  assert.equal(existsSync(catalogPath(state)), false);
});

test('without a deny file nothing is restricted but the catalog is still recorded', async () => {
  const { repo, ctx, state } = setup();
  const { restricted, agent } = strictAgent();
  await ctx.handlers['agent/created'][0]({ agent: agent(rootSession('a1', repo)) });
  assert.deepEqual(restricted, []);
  assert.equal(existsSync(catalogPath(state)), true);
});

test('nothing in tool pruning can fail an agent\'s creation', async () => {
  const { repo, ctx } = setup();
  writeDeny(repo, ['mcp__crm__update']);
  const run = (payload) => ctx.handlers['agent/created'][0](payload);
  await assert.doesNotReject(async () => run(undefined));
  await assert.doesNotReject(async () => run({}));
  await assert.doesNotReject(async () => run({ agent: { session: rootSession('a', repo) } }));      // no ctx.tools on the agent
  const throwing = { session: rootSession('b', repo), ctx: { tools: { restrict() { throw new Error('boom'); } } } };
  await assert.doesNotReject(async () => run({ agent: throwing }));
  ctx.tools = { schemas() { throw new Error('boom'); } };
  await assert.doesNotReject(async () => run({ agent: strictAgent().agent(rootSession('c', repo)) }));
});

test('applyDeny:false leaves the list alone (the catalog is still recorded)', async () => {
  const { repo, ctx, state } = setup({ applyDeny: false });
  writeDeny(repo, ['mcp__crm__update']);
  const { restricted, agent } = strictAgent();
  await ctx.handlers['agent/created'][0]({ agent: agent(rootSession('a1', repo)) });
  assert.deepEqual(restricted, []);
  assert.equal(existsSync(catalogPath(state)), true);
});

// ---- the proxy ------------------------------------------------------------------------------
test('a proxy call is recorded as the tool it carries, so a tool used only through it counts as used', () => {
  assert.deepEqual(unproxy('tool_call', { name: 'mcp__crm__search', arguments: { q: 'x' } }), { name: 'mcp__crm__search', arguments: { q: 'x' } });
  assert.deepEqual(unproxy('tool_call', { name: 'mcp__crm__search', arguments: '{"q":"x"}' }), { name: 'mcp__crm__search', arguments: { q: 'x' } });
  assert.deepEqual(unproxy('tool_call', { arguments: {} }), { name: 'tool_call', arguments: { arguments: {} } });   // not a proxy call
  assert.deepEqual(unproxy('tool_call', { name: '' }), { name: 'tool_call', arguments: { name: '' } });
  assert.deepEqual(unproxy('bash', { name: 'x' }), { name: 'bash', arguments: { name: 'x' } });                     // only the proxy
  const dir = tmp();
  const spool = new Spool(join(dir, 's.jsonl'), { sessionId: 's', cwd: dir });
  const ev = (type, data) => ({ type, seq: 0, time: 0, data });
  spool.record(ev('user/message', { role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }));
  spool.record(ev('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 }, message: { role: 'assistant', source: { kind: 'model', model: 'm' }, content: [{ type: 'tool-call', id: 'c1', name: 'tool_call', arguments: JSON.stringify({ name: 'mcp__crm__search', arguments: { q: 'x' } }) }] } }));
  const call = readJsonl(spool.path).find((r) => r.message?.role === 'assistant').message.content[0];
  assert.deepEqual([call.type, call.id, call.name, call.arguments], ['toolCall', 'c1', 'mcp__crm__search', { q: 'x' }]);
});
