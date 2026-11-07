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

/**
 * The text `te panel --json` answered with -> {ok, status, series, side}. A bare `te status --json` document
 * is accepted too (no series), so a core older than the panel command still draws the overview.
 */
function parsePanel(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, error: String(text ?? '').trim().slice(0, 400) || 'empty answer' };
  }
  const status = isObject(v) && isObject(v.status) ? v.status : v;
  if (!isObject(status) || !isObject(status.ledger) || !isObject(status.config)) return { ok: false, error: 'unexpected status shape' };
  return { ok: true, status, series: isObject(v?.series) ? v.series : null, side: isObject(v?.side) ? v.side : null };
}

const MODE_LABEL = { off: 'off', on: 'on', auto: 'automatic', propose: 'proposals only', nudge: 'nudges', shadow: 'shadow (observe only)' };
const label = (m) => (typeof m === 'string' ? (MODE_LABEL[m] ?? m) : '—');

/** A CommandResult (or a transport failure) -> {state: 'ready'|'error', ...}. */
function toViewState(exec) {
  if (!exec || exec.ok === false) return { state: 'error', message: exec?.error?.message ?? 'The command did not run.' };
  const result = exec.value?.result;
  if (!result) return { state: 'error', message: 'The /te command is not available (is the plugin loaded?).' };
  if (result.kind !== 'success') return { state: 'error', message: String(result.text ?? 'te failed').slice(0, 400) };
  const parsed = parsePanel(result.text);
  return parsed.ok ? { state: 'ready', model: buildModel(parsed.status, parsed.side), series: parsed.series } : { state: 'error', message: parsed.error };
}

const MAX_REASON = 120;
const MAX_NAMES = 3;

/** What tool pruning did: applied (first few by name), proposed, and where the tool list came from. */
function toolpruneDetail(tp, note) {
  const applied = Array.isArray(tp.applied) ? tp.applied.map(String) : [];
  const names = applied.slice(0, MAX_NAMES).join(', ');
  const more = applied.length > MAX_NAMES ? ', …' : '';
  const counts = `${applied.length} applied${names ? ` (${names}${more})` : ''} · ${(tp.proposal ?? []).length} proposed · catalog: ${tp.catalog_source || 'none yet'}`;
  return typeof note === 'string' && note ? `${note} · ${counts}` : counts;
}

/** The core's `side` -> the Model calls row: the model calls the plugin makes itself, active or paused. */
function modelCalls(side) {
  const base = { key: 'modelcalls', title: 'Model calls' };
  if (!isObject(side) || !('paused' in side)) return { ...base, state: 'unknown', detail: 'no data' };
  if (!isObject(side.paused)) return { ...base, state: 'active', detail: "answered through DSH's model service" };
  const reason = typeof side.paused.reason === 'string' ? side.paused.reason.slice(0, MAX_REASON) : '';
  return { ...base, state: 'paused',
    detail: `${reason ? `${reason} · ` : ''}paused until you set microskills or loopguard again (te config set microskills|loopguard <mode>)` };
}

/**
 * What the view draws. Takes the panel payload ({status, series, side}) or a bare status; `side`
 * may also be passed on its own (toViewState has already taken the payload apart).
 */
function buildModel(payload, sideArg) {
  const s = isObject(payload?.status) && !isObject(payload.ledger) ? payload.status : payload;
  const side = sideArg ?? (s === payload ? undefined : payload.side);
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
        detail: toolpruneDetail(tp, s.notes?.toolprune) },
      { key: 'loopguard', title: 'Loop guard', mode: label(cfg.loopguard),
        detail: `${Number(lg.ended_green_turns) || 0} turn(s) ended green · ${Number(ledger.nudges) || 0} nudge(s) · ${Number(ledger.aborts) || 0} abort(s)` },
    ],
    modelCalls: modelCalls(side),
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

module.exports = { fmtTokens, fmtPct, parsePanel, toViewState, buildModel, label };
