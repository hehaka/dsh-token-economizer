import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createPlugin } from '../src/plugin.mjs';
import { Spool, unproxy } from '../src/spool.mjs';
import { DENY_FILE, applyDeny, catalogPath, readDeny, repoCatalogPath, repoRoot, toolNames, writeCatalog } from '../src/tools.mjs';
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

// ---- G1: one bad name must not disable all pruning --------------------------------------------
// DSH's `restrict` is all-or-nothing: it throws before applying anything when ANY name is unknown
// or reserved (`run_code` is always refused; a name on the agent's own layer may be too).
const atomicAgent = (refuse = [], log = []) => ({
  log,
  restricted: [],
  agent(session) {
    const self = this;
    return { session, ctx: { tools: { restrict: (f) => { log.push([...f.deny]); const bad = f.deny.find((n) => refuse.includes(n)); if (bad) throw new Error(`cannot restrict "${bad}"`); self.restricted.push(...f.deny); return () => {}; } } } };
  },
});
const WITH_RUN_CODE = [...ALL, 'run_code'];

test('G1: a name restrict refuses does not stop the others from being hidden', () => {
  const a = atomicAgent(['mcp__docs__lookup']);
  let applied;
  assert.doesNotThrow(() => { applied = applyDeny(a.agent(rootSession('s', '/r')), ['mcp__crm__search', 'mcp__docs__lookup', 'mcp__crm__update'], ALL); });
  assert.deepEqual(a.restricted, ['mcp__crm__search', 'mcp__crm__update']);
  assert.deepEqual(applied, ['mcp__crm__search', 'mcp__crm__update']);          // what was actually restricted
});

test('G1: run_code, tool_call and tool_search are never sent to restrict', () => {
  const a = atomicAgent(['run_code']);
  let applied;
  assert.doesNotThrow(() => { applied = applyDeny(a.agent(rootSession('s', '/r')), ['run_code', 'tool_call', 'tool_search', 'mcp__crm__update'], [...WITH_RUN_CODE, 'tool_search']); });
  assert.deepEqual(a.log.flat(), ['mcp__crm__update']);                          // not even in a retry
  assert.deepEqual(applied, ['mcp__crm__update']);
  const b = atomicAgent();
  assert.deepEqual(applyDeny(b.agent(rootSession('s', '/r')), ['run_code'], WITH_RUN_CODE), []);
  assert.deepEqual(b.log, []);                                                    // nothing left to send: no call at all
});

test('G1: a restrict that refuses everything leaves applied empty and does not throw', () => {
  const lines = [];
  const a = atomicAgent(['mcp__crm__search', 'mcp__crm__update']);
  let applied;
  assert.doesNotThrow(() => { applied = applyDeny(a.agent(rootSession('s', '/r')), ['mcp__crm__search', 'mcp__crm__update'], ALL, (m) => lines.push(m)); });
  assert.deepEqual(applied, []);
  assert.deepEqual(a.restricted, []);
  assert.equal(lines.length, 1);                                                  // one line, naming the refused tools
  assert.match(lines[0], /mcp__crm__search/);
  assert.match(lines[0], /mcp__crm__update/);
});

test('G1: the batch is tried first (one call when nothing is refused), each name alone only after a throw', () => {
  const ok = atomicAgent();
  applyDeny(ok.agent(rootSession('s', '/r')), ['mcp__crm__search', 'mcp__crm__update'], ALL);
  assert.deepEqual(ok.log, [['mcp__crm__search', 'mcp__crm__update']]);
  const bad = atomicAgent(['mcp__crm__update']);
  assert.doesNotThrow(() => applyDeny(bad.agent(rootSession('s', '/r')), ['mcp__crm__search', 'mcp__crm__update'], ALL));
  assert.deepEqual(bad.log, [['mcp__crm__search', 'mcp__crm__update'], ['mcp__crm__search'], ['mcp__crm__update']]);
});

test('G1: at agent creation one refused name still lets the rest be hidden, and the refusal is logged once', async () => {
  const logs = [];
  const root = tmp();
  const repo = fakeRepo(root);
  const ctx = fakeCtx();
  ctx.tools = registry(WITH_RUN_CODE);
  ctx.logger = { warn: (m) => logs.push(m), info: () => {}, debug: () => {} };
  createPlugin(ctx, { env: isolatedEnv(root), bootstrap: BOOTSTRAP, closeOnExit: false, run: async () => ({}) });
  writeDeny(repo, ['run_code', 'mcp__docs__lookup', 'mcp__crm__update']);
  const a = atomicAgent(['mcp__docs__lookup']);
  await ctx.handlers['agent/created'][0]({ agent: a.agent(rootSession('a1', repo)), source: 'new' });
  assert.deepEqual(a.restricted, ['mcp__crm__update']);
  assert.equal(a.log.flat().includes('run_code'), false);
  assert.equal(logs.filter((m) => /mcp__docs__lookup/.test(m)).length, 1);
});

// ---- G2: the core writes the deny file at the repository root, a session may start below it ----
const nestedRepo = (parent, name) => {
  const dir = join(parent, name);
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
};

test('G2: a session started in a subdirectory reads the deny file at the repository root', () => {
  const repo = fakeRepo(tmp());
  writeDeny(repo, ['mcp__crm__update']);
  const sub = join(repo, 'packages', 'web', 'src');
  mkdirSync(sub, { recursive: true });
  assert.deepEqual(readDeny(sub), ['mcp__crm__update']);
  assert.deepEqual(readDeny(repo), ['mcp__crm__update']);
});

test('G2: without a repository the file next to the session is read, and no parent\'s', () => {
  const root = tmp();
  const child = join(root, 'child');
  mkdirSync(child);
  writeDeny(root, ['mcp__parent__tool']);                                        // a parent's file is nobody's here
  assert.deepEqual(readDeny(child), []);
  writeDeny(child, ['mcp__crm__update']);
  assert.deepEqual(readDeny(child), ['mcp__crm__update']);
});

test('G2: in a nested repository the nearest .git wins; a .git file (worktree) counts', () => {
  const outer = nestedRepo(tmp(), 'outer');
  writeDeny(outer, ['mcp__outer__tool']);
  const inner = nestedRepo(outer, 'inner');
  writeDeny(inner, ['mcp__inner__tool']);
  const sub = join(inner, 'a', 'b');
  mkdirSync(sub, { recursive: true });
  assert.deepEqual(readDeny(sub), ['mcp__inner__tool']);
  const wt = join(outer, 'wt');                                                   // a linked worktree: `.git` is a file naming a real gitdir
  mkdirSync(join(wt, 'deep'), { recursive: true });
  mkdirSync(join(outer, '.git', 'worktrees', 'wt'), { recursive: true });
  writeFileSync(join(wt, '.git'), `gitdir: ${join(outer, '.git', 'worktrees', 'wt')}\n`);
  writeDeny(wt, ['mcp__wt__tool']);
  assert.deepEqual(readDeny(join(wt, 'deep')), ['mcp__wt__tool']);
  assert.equal(repoRoot(join(wt, 'deep')), wt);
  assert.equal(repoRoot(sub), inner);
});

test('G2: at agent creation a subdirectory session gets the root\'s deny list', async () => {
  const { repo, ctx } = setup();
  writeDeny(repo, ['mcp__crm__update']);
  const sub = join(repo, 'src');
  mkdirSync(sub);
  const { restricted, agent } = strictAgent();
  await ctx.handlers['agent/created'][0]({ agent: agent(rootSession('a1', sub)), source: 'new' });
  assert.deepEqual(restricted, ['mcp__crm__update']);
});

// ---- G4: a corrupt catalog is repaired, not left alone for ever -------------------------------
test('G4: an unreadable previous catalog is treated as changed and rewritten atomically', () => {
  const state = join(tmp(), 'state');
  assert.equal(writeCatalog(state, ['a', 'b']), true);
  for (const junk of ['{ not json', '', 'null', '{"tools": "x"}', '[1,2]']) {
    writeFileSync(catalogPath(state), junk);
    assert.equal(writeCatalog(state, ['a', 'b']), true, `repairs ${JSON.stringify(junk)}`);
    assert.deepEqual(JSON.parse(readFileSync(catalogPath(state), 'utf8')).tools, ['a', 'b']);
    assert.equal(statSync(catalogPath(state)).mode & 0o777, 0o600);
    assert.equal(writeCatalog(state, ['a', 'b']), false);                         // and then it is left alone again
  }
  assert.deepEqual(readdirSync(dirname(catalogPath(state))).filter((f) => f.endsWith('.tmp')), []);
});

// ---- G3: a catalog per repository, next to the host-wide one ------------------------------------
test('G3: the catalog is also written per repository, named by the sha1 of its root', () => {
  const state = join(tmp(), 'state');
  const own = repoCatalogPath(state, '/r/a');
  assert.equal(own, join(state, 'hosts', 'dsh', 'catalogs', '124e753dd7ff7c84.json'));      // the core's tests pin the same name
  assert.equal(writeCatalog(state, ['a', 'b'], '/r/a'), true);
  assert.deepEqual(JSON.parse(readFileSync(own, 'utf8')).tools, ['a', 'b']);
  assert.deepEqual(JSON.parse(readFileSync(catalogPath(state), 'utf8')).tools, ['a', 'b']);    // the host-wide file stays
  assert.equal(statSync(own).mode & 0o777, 0o600);
  assert.equal(writeCatalog(state, ['a', 'b'], '/r/a'), false);                                // unchanged: nothing written
  assert.equal(writeCatalog(state, ['a', 'b', 'c'], '/r/a'), true);
  assert.deepEqual(JSON.parse(readFileSync(own, 'utf8')).tools, ['a', 'b', 'c']);
  writeFileSync(own, '{ broken');                                                              // G4 applies to it too
  assert.equal(writeCatalog(state, ['a', 'b', 'c'], '/r/a'), true);
  assert.deepEqual(JSON.parse(readFileSync(own, 'utf8')).tools, ['a', 'b', 'c']);
});

test('G3: two repositories give two catalog files; the host-wide one is the last session\'s', async () => {
  const { root, ctx, state } = setup();
  const repoA = nestedRepo(root, 'repo-a');
  const repoB = nestedRepo(root, 'repo-b');
  const agentFor = (cwd, names) => {
    ctx.tools = registry(names);
    return strictAgent(names).agent(rootSession(`s-${cwd}`, cwd));
  };
  mkdirSync(join(repoA, 'src'));
  await ctx.handlers['agent/created'][0]({ agent: agentFor(join(repoA, 'src'), [...ALL, 'mcp__crm__x']) });   // started in a subdirectory
  await ctx.handlers['agent/created'][0]({ agent: agentFor(repoB, ALL) });
  const read = (p) => JSON.parse(readFileSync(p, 'utf8')).tools;
  assert.deepEqual(read(repoCatalogPath(state, repoA)), [...ALL, 'mcp__crm__x'].sort());           // keyed by the root, not the subdirectory
  assert.deepEqual(read(repoCatalogPath(state, repoB)), [...ALL].sort());
  assert.notEqual(repoCatalogPath(state, repoA), repoCatalogPath(state, repoB));
  assert.deepEqual(read(catalogPath(state)), [...ALL].sort());                                    // the last session's, as before
  assert.equal(readdirSync(dirname(repoCatalogPath(state, repoA))).length, 2);
});
