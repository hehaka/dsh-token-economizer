import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { PANEL, SERIES, STATUS } from './fixtures.mjs';

const { fmtTokens, fmtPct, parsePanel, toViewState, buildModel } = createRequire(import.meta.url)('../src/model.cjs');

const ok = (text, kind = 'success') => ({ ok: true, value: { result: { kind, text } } });

test('token counts are short and honest', () => {
  assert.equal(fmtTokens(53937.3), '53.9k');
  assert.equal(fmtTokens(1234567), '1.23M');
  assert.equal(fmtTokens(2500), '2.50k');
  assert.equal(fmtTokens(0), '0');
  assert.equal(fmtTokens(undefined), '—');
  assert.equal(fmtTokens(NaN), '—');
  assert.equal(fmtPct(0.0123), '1.2%');
  assert.equal(fmtPct(null), '—');
});

test('what the command answered is parsed, and anything else is an error with a reason', () => {
  const ok = parsePanel(JSON.stringify(PANEL));
  assert.equal(ok.ok, true);
  assert.equal(ok.status.repo, 'acme/widget');
  assert.equal(ok.series.sessions.length, 5);
  const bare = parsePanel(JSON.stringify(STATUS));                       // a core older than `te panel`
  assert.equal(bare.ok, true);
  assert.equal(bare.series, null);
  assert.equal(parsePanel('not json').ok, false);
  assert.match(parsePanel('Unknown command "x".').error, /Unknown command/);
  assert.equal(parsePanel('{"a":1}').ok, false);
  assert.equal(parsePanel(JSON.stringify({ status: { ledger: {} } })).ok, false);
  assert.equal(parsePanel('').ok, false);
});

test('the view model comes straight from the core\'s numbers', () => {
  const m = buildModel(STATUS);
  assert.equal(m.repo, 'acme/widget');
  assert.equal(m.host, 'dsh');
  assert.equal(m.ledger.sessions, 1);
  assert.equal(m.ledger.effective, '53.9k');
  assert.equal(m.ledger.overhead, '0');
  assert.equal(m.ledger.empty, false);
  assert.deepEqual(m.mechanisms.map((x) => x.key), ['microskills', 'toolprune', 'loopguard']);
  assert.equal(m.mechanisms[2].mode, 'nudges');
  assert.match(m.mechanisms[2].detail, /1 turn\(s\) ended green/);
  assert.equal(buildModel({ ...STATUS, ledger: { ...STATUS.ledger, sessions: 0 } }).ledger.empty, true);
  assert.equal(buildModel({ ...STATUS, config: { ...STATUS.config, mode: 'shadow' } }).shadow, true);
  assert.deepEqual(buildModel({ ...STATUS, warnings: ['a', 2] }).warnings, ['a', '2']);
  assert.match(buildModel({ ...STATUS, notes: { toolprune: 'tool pruning is off' } }).mechanisms[1].detail, /tool pruning is off/);
});

test('every way the command can fail becomes an error state, never a throw', () => {
  assert.equal(toViewState(ok(JSON.stringify(PANEL))).state, 'ready');
  assert.equal(toViewState(ok(JSON.stringify(PANEL))).series.sessions.length, SERIES.sessions.length);
  assert.equal(toViewState(ok(JSON.stringify(STATUS))).series, null);
  assert.deepEqual(toViewState(ok('boom', 'error')), { state: 'error', message: 'boom' });
  assert.equal(toViewState(ok('garbage')).state, 'error');
  assert.match(toViewState({ ok: true, value: undefined }).message, /not available/);
  assert.match(toViewState({ ok: false, error: { message: 'gateway down' } }).message, /gateway down/);
  assert.equal(toViewState(undefined).state, 'error');
  assert.equal(toViewState(null).state, 'error');
  assert.equal(toViewState(ok('x'.repeat(2000), 'error')).message.length, 400);
});

const withTools = (toolprune, extra = {}) => ({ ...STATUS, toolprune: { ...STATUS.toolprune, ...toolprune }, ...extra });
const detailOf = (status) => buildModel(status).mechanisms[1].detail;

test('tool pruning shows what is applied, what is proposed and where the tool list came from', () => {
  const d = detailOf(withTools({ applied: ['read_image', 'web_fetch'], proposal: ['notebook_edit'], catalog_source: 'claude-session' }));
  assert.match(d, /2 applied/);
  assert.match(d, /read_image/);
  assert.match(d, /1 proposed/);
  assert.match(d, /catalog: claude-session/);
  assert.ok(d.indexOf('applied') < d.indexOf('proposed') && d.indexOf('proposed') < d.indexOf('catalog'), `order applied, proposed, catalog: ${d}`);
});

test('tool pruning without a catalog says none yet, and with nothing applied says so', () => {
  const d = detailOf(withTools({ applied: [], proposal: ['a', 'b', 'c'], catalog_source: null }));
  assert.match(d, /0 applied/);
  assert.match(d, /3 proposed/);
  assert.match(d, /catalog: none yet/);
  assert.match(detailOf(STATUS), /catalog: none yet/);               // the fixture has no catalog_source at all
});

test('a long applied list names only the first few', () => {
  const applied = Array.from({ length: 12 }, (_, i) => `tool_${String(i).padStart(2, '0')}`);
  const d = detailOf(withTools({ applied, catalog_source: 'x' }));
  assert.match(d, /12 applied/);
  assert.match(d, /tool_00/);
  assert.ok(!d.includes('tool_11'), `the last name is left out: ${d}`);
});

test('a note from the core is still shown for tool pruning', () => {
  const d = detailOf(withTools({ applied: ['a'], catalog_source: 'x' }, { notes: { toolprune: 'proposal awaiting approval; see toolprune' } }));
  assert.match(d, /proposal awaiting approval/);
});

const SIDE_ACTIVE = { paused: null, host: 'dsh' };
const SIDE_PAUSED = { paused: { at: 1762500000, reason: 'Please run /login' }, host: 'dsh' };
const calls = (payload) => buildModel(payload).modelCalls ?? {};

test('model calls are active when the core reports no pause', () => {
  const c = calls({ ...PANEL, side: SIDE_ACTIVE });
  assert.equal(c.key, 'modelcalls');
  assert.equal(c.title, 'Model calls');
  assert.equal(c.state, 'active');
  assert.match(c.detail, /answered through DSH's model service/);
});

test('model calls are paused with the reason and how to lift the pause', () => {
  const c = calls({ ...PANEL, side: SIDE_PAUSED });
  assert.equal(c.key, 'modelcalls');
  assert.equal(c.state, 'paused');
  assert.match(c.detail, /Please run \/login/);
  assert.match(c.detail, /te config set microskills\|loopguard/);
});

test('a very long pause reason is cut to 120 characters', () => {
  const reason = `${'x'.repeat(100)}${'y'.repeat(400)}`;
  const c = calls({ ...PANEL, side: { paused: { at: 1, reason }, host: 'dsh' } });
  assert.equal(c.state, 'paused');
  assert.ok(c.detail.includes('x'.repeat(100)), 'the start of the reason is kept');
  assert.ok(!c.detail.includes('y'.repeat(21)), 'the reason is cut at 120 characters');
  assert.ok(c.detail.length < 400, `the detail stays short: ${c.detail.length}`);
});

test('a pause without a reason is still a pause', () => {
  assert.equal(calls({ ...PANEL, side: { paused: { at: 1 }, host: 'dsh' } }).state, 'paused');
});

test('model calls are unknown for a core that sends no side data', () => {
  for (const older of [STATUS, PANEL, { ...PANEL, side: undefined }]) {
    const c = calls(older);
    assert.equal(c.key, 'modelcalls');
    assert.equal(c.title, 'Model calls');
    assert.equal(c.state, 'unknown');
    assert.equal(c.detail, 'no data');
  }
});

test('the three mechanisms keep their order whatever the model calls say', () => {
  for (const side of [undefined, SIDE_ACTIVE, SIDE_PAUSED]) {
    const m = buildModel({ ...PANEL, side });
    assert.deepEqual(m.mechanisms.map((x) => x.key), ['microskills', 'toolprune', 'loopguard']);
    assert.equal(m.mechanisms.length, 3);
    assert.equal(m.repo, 'acme/widget');
    assert.ok(m.modelCalls, 'modelCalls sits beside the mechanisms');
  }
});

test('the view state of a panel answer carries the model calls from its side data', () => {
  const state = (obj) => toViewState(ok(JSON.stringify(obj)));
  assert.equal(state({ ...PANEL, side: SIDE_PAUSED }).model.modelCalls?.state, 'paused');
  assert.equal(state({ ...PANEL, side: SIDE_ACTIVE }).model.modelCalls?.state, 'active');
  assert.equal(state(STATUS).model.modelCalls?.state, 'unknown');
  assert.equal(state({ ...PANEL, side: SIDE_PAUSED }).model.repo, 'acme/widget');
});

// ---- G6: a damaged pause is still a pause; only a missing `side` is unknown ---------------------
test('G6: any pause value that is not null or false is a pause, whatever its shape', () => {
  for (const paused of [true, [], ['x'], 'yes', 1, 0, '', {}, { reason: 7 }, { reason: ['x'] }, { at: 'now' }]) {
    const c = calls({ ...PANEL, side: { paused, host: 'dsh' } });
    assert.equal(c.state, 'paused', `paused=${JSON.stringify(paused)}`);
    assert.match(c.detail, /te config set microskills\|loopguard/);
  }
  for (const paused of [null, false]) assert.equal(calls({ ...PANEL, side: { paused, host: 'dsh' } }).state, 'active', `paused=${paused}`);
});

test('G6: only a missing side is unknown, also through the view state', () => {
  assert.equal(calls({ ...PANEL, side: undefined }).state, 'unknown');
  const state = (obj) => toViewState(ok(JSON.stringify(obj)));
  assert.equal(state({ ...PANEL, side: 'broken' }).model.modelCalls.state, 'unknown');         // not an object at all: no side data
  assert.equal(state({ ...PANEL, side: { paused: true } }).model.modelCalls.state, 'paused');
  assert.equal(state({ ...PANEL, side: { paused: 'x' } }).model.modelCalls.state, 'paused');
});

test('G6: the reason is shown only when it is a string', () => {
  assert.match(calls({ ...PANEL, side: { paused: { reason: 'Please run /login' } } }).detail, /^Please run \/login · paused until/);
  for (const reason of [7, ['x'], { a: 1 }, true, null]) {
    assert.match(calls({ ...PANEL, side: { paused: { reason } } }).detail, /^paused until/, `reason=${JSON.stringify(reason)}`);
  }
  assert.match(calls({ ...PANEL, side: { paused: 'Please run /login' } }).detail, /^paused until/);    // a string pause has no reason field
});

// ---- G7: the tool-pruning detail is bounded, and `proposal` counts only as an array --------------
test('G7: the tool-pruning detail is capped at 300 characters', () => {
  const long = withTools({ applied: ['a'.repeat(500), 'b', 'c'], catalog_source: 'x'.repeat(500) }, { notes: { toolprune: 'n'.repeat(900) } });
  const d = detailOf(long);
  assert.ok(d.length <= 300, `capped: ${d.length}`);
  assert.ok(d.startsWith('n'.repeat(50)), 'the start is kept');
  const short = detailOf(withTools({ applied: ['a'], proposal: [], catalog_source: 'x' }));
  assert.ok(short.length < 300 && !short.endsWith('…'), 'a short detail is left as it is');
  assert.equal(detailOf(withTools({ applied: ['z'.repeat(298)], catalog_source: null })).length <= 300, true);
});

test('G7: a proposal that is not an array is not counted', () => {
  for (const proposal of [{ length: 9 }, 'abcdefghi', 9, null, { a: 1 }]) {
    assert.match(detailOf(withTools({ applied: [], proposal, catalog_source: 'x' })), /0 proposed/, JSON.stringify(proposal));
  }
  assert.match(detailOf(withTools({ applied: [], proposal: ['a', 'b'], catalog_source: 'x' })), /2 proposed/);
});
