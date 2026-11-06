// A real `te status --json` for a repository with one folded DSH session (trimmed to what the panel reads).
export const STATUS = {
  repo: 'acme/widget', host: 'dsh',
  config: { enabled: true, mode: 'auto', microskills: 'off', toolprune: 'auto', loopguard: 'nudge' },
  warnings: [], session_note: null,
  microskills: { profile: 'off', injected_lines: 0, sessions_folded: 0, imported_sessions: 0 },
  toolprune: { mode: 'auto', sessions: 0, proposal: [], applied: [] },
  loopguard: { mode: 'nudge', envelope: null, ended_green_turns: 1 },
  ledger: { sessions: 1, priced_sessions: 1, effective_tokens: 53937.3, overhead_tokens: 0, overhead_frac: 0, requests: 3, nudges: 0, aborts: 0, turns: 1, injected_sessions: 0 },
};

/** Epoch seconds of 2026-11-<day> <hour>:<min> UTC (the tests that use dates run with TZ=UTC). */
export const at = (day, hour = 12, min = 0) => Date.UTC(2026, 10, day, hour, min) / 1000;

/** One entry of `te panel --json`'s series.sessions. */
export function session(over = {}) {
  const parts = { input: 4, cache_read: 232.6, cache_write: 17217.5, output: 105 };
  return { id: 's', started: at(4), ended: at(4) + 60, model: 'claude-haiku-5-5', effective: 17559.1, parts, overhead: 0, cache_hit: 0.35, requests: 3, turns: 1, nudges: 0, aborts: 0, injected: false, shadow: false, ...over };
}

export const SERIES = {
  sessions: [
    session({ id: 'a', started: at(4, 9) }),
    session({ id: 'b', started: at(4, 17), effective: 30000, parts: { input: 1000, cache_read: 9000, cache_write: 15000, output: 5000 }, cache_hit: 0.8, injected: true }),
    session({ id: 'c', started: at(5, 10), effective: 8000, parts: { total: 8000 }, cache_hit: null, nudges: 2, aborts: 1, overhead: 400 }),
    session({ id: 'd', started: at(6, 11), effective: null, parts: null, cache_hit: null }),
    session({ id: 'e', started: at(6, 15), effective: 12000, parts: { input: 2000, cache_read: 4000, cache_write: 3000, output: 3000 }, cache_hit: 0.6 }),
  ],
  earlier: 0, imported: 0, unattributed_overhead: 0, generated: at(6, 16),
};

/** What `te panel --json` prints. */
export const PANEL = { schema: 1, status: STATUS, series: SERIES };
