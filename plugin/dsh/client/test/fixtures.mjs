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
