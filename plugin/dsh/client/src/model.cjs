'use strict';
// The panel's view model: `te status --json` in, plain data for the view out. Pure (no React, no
// DOM), so it runs under node:test. The core owns every number; nothing is recomputed here.

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 53937.3 -> "53.9k", 1234567 -> "1.23M", 0 -> "0". */
function fmtTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(2)}k`;
  return String(Math.round(n));
}

/** 0.0123 -> "1.2%". */
function fmtPct(f) {
  return typeof f === 'number' && Number.isFinite(f) ? `${(f * 100).toFixed(1)}%` : '—';
}

/** The text a `/te` command answered with -> {ok, status} or {ok: false, error}. */
function parseStatus(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, error: String(text ?? '').trim().slice(0, 400) || 'empty answer' };
  }
  if (!isObject(v) || !isObject(v.ledger) || !isObject(v.config)) return { ok: false, error: 'unexpected status shape' };
  return { ok: true, status: v };
}

const MODE_LABEL = { off: 'off', on: 'on', auto: 'automatic', propose: 'proposals only', nudge: 'nudges', shadow: 'shadow (observe only)' };
const label = (m) => (typeof m === 'string' ? (MODE_LABEL[m] ?? m) : '—');

/** A CommandResult (or a transport failure) -> {state: 'ready'|'error', ...}. */
function toViewState(exec) {
  if (!exec || exec.ok === false) return { state: 'error', message: exec?.error?.message ?? 'The command did not run.' };
  const result = exec.value?.result;
  if (!result) return { state: 'error', message: 'The /te command is not available (is the plugin loaded?).' };
  if (result.kind !== 'success') return { state: 'error', message: String(result.text ?? 'te failed').slice(0, 400) };
  const parsed = parseStatus(result.text);
  return parsed.ok ? { state: 'ready', model: buildModel(parsed.status) } : { state: 'error', message: parsed.error };
}

/** Status -> what the view draws. */
function buildModel(s) {
  const ledger = s.ledger ?? {};
  const mp = s.microskills ?? {};
  const tp = s.toolprune ?? {};
  const lg = s.loopguard ?? {};
  const cfg = s.config ?? {};
  const sessions = Number(ledger.sessions) || 0;
  return {
    repo: s.repo ?? '—',
    host: s.host ?? '—',
    enabled: cfg.enabled !== false,
    shadow: cfg.mode === 'shadow',
    mechanisms: [
      { key: 'microskills', title: 'Learned facts', mode: label(cfg.microskills),
        detail: `${Number(mp.injected_lines) || 0} line(s) injected · ${Number(mp.sessions_folded) || 0} session(s) learned from` },
      { key: 'toolprune', title: 'Tool pruning', mode: label(cfg.toolprune),
        detail: s.notes?.toolprune ?? `${(tp.proposal ?? []).length} proposed · ${(tp.applied ?? []).length} applied` },
      { key: 'loopguard', title: 'Loop guard', mode: label(cfg.loopguard),
        detail: `${Number(lg.ended_green_turns) || 0} turn(s) ended green · ${Number(ledger.nudges) || 0} nudge(s) · ${Number(ledger.aborts) || 0} abort(s)` },
    ],
    ledger: {
      sessions,
      priced: Number(ledger.priced_sessions) || 0,
      effective: fmtTokens(ledger.effective_tokens),
      overhead: fmtTokens(ledger.overhead_tokens),
      overheadPct: fmtPct(ledger.overhead_frac),
      requests: Number(ledger.requests) || 0,
      turns: Number(ledger.turns) || 0,
      empty: sessions === 0,
    },
    warnings: Array.isArray(s.warnings) ? s.warnings.map(String) : [],
    note: typeof s.session_note === 'string' ? s.session_note : '',
  };
}

module.exports = { fmtTokens, fmtPct, parseStatus, toViewState, buildModel, label };
