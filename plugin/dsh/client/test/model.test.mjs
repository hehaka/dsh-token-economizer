import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { STATUS } from './fixtures.mjs';

const { fmtTokens, fmtPct, parseStatus, toViewState, buildModel } = createRequire(import.meta.url)('../src/model.cjs');

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
  assert.equal(parseStatus(JSON.stringify(STATUS)).ok, true);
  assert.equal(parseStatus('not json').ok, false);
  assert.match(parseStatus('Unknown command "x".').error, /Unknown command/);
  assert.equal(parseStatus('{"a":1}').ok, false);
  assert.equal(parseStatus('').ok, false);
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
  assert.match(buildModel({ ...STATUS, notes: { toolprune: 'tool pruning is not available on dsh' } }).mechanisms[1].detail, /not available on dsh/);
});

test('every way the command can fail becomes an error state, never a throw', () => {
  assert.equal(toViewState(ok(JSON.stringify(STATUS))).state, 'ready');
  assert.deepEqual(toViewState(ok('boom', 'error')), { state: 'error', message: 'boom' });
  assert.equal(toViewState(ok('garbage')).state, 'error');
  assert.match(toViewState({ ok: true, value: undefined }).message, /not available/);
  assert.match(toViewState({ ok: false, error: { message: 'gateway down' } }).message, /gateway down/);
  assert.equal(toViewState(undefined).state, 'error');
  assert.equal(toViewState(null).state, 'error');
  assert.equal(toViewState(ok('x'.repeat(2000), 'error')).message.length, 400);
});
