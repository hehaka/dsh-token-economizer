# Iteration 2 — T3 (DoD D2): side-call live check, paid_model routes

changed:
- plugin/dsh/src/sidecall.mjs — `complete()` returns `{ text, usage, model, provider }` (provider = target.provider).
- plugin/dsh/test/sidecall.test.mjs — two deepEqual reply assertions now include `provider`; the `paid_model` test also asserts `openai/gpt-6-mini` -> provider `openai` and a bare model keeps the route's provider (`anthropic`). (sidecall.e2e.test.mjs asserts no reply shape, so it needed no change.)
- plugin/dsh/test/live/stub_core.py — raw-POST mode (TE_LIVE_SIDE on PostToolUse) untouched; new opt-in mode TE_LIVE_RUNNER=1 (real `sidecall.runner_for("dsh", cfg)` per variant of TE_LIVE_PAID, raw endpoint reply captured by wrapping `urlopen` in `dsh_sidecall`, one JSON line per variant appended at once, never raises, runs once per process tree via an O_EXCL marker `<TE_LIVE_SIDE>.runner-done`).
- plugin/dsh/test/live/live-sidecall.mjs — new (usage/exit 2 on unknown flags or `--only`; group `paid`; group `route` prints `route group: not implemented yet (task T4)` and exits 1, also in a full run).
- docs/iterations/2-implement.md — this report.

gates:
- `node --check` on sidecall.mjs, sidecall.test.mjs, live-sidecall.mjs: pass.
- `cd plugin/dsh && npm test`: pass — 91 tests, 0 failures.
- `/tmp/te-venv/bin/python -m pytest -q tests/test_dsh_sidecall.py`: pass (unchanged test file).
- `node plugin/dsh/test/live/live-check.mjs`: pass — 25/25 (stub change did not break the raw-POST path).
- `node plugin/dsh/test/live/live-sidecall.mjs --only paid`: pass — 12/12, exit 0. Session route anthropic/claude-haiku-5-5; "" -> anthropic/claude-haiku-5-5; A -> azure-openai-responses/gpt-6-luna; B (bare) -> anthropic/claude-sonnet-5-5; all three returned text "pong", effective 36/43/38, usage.input_tokens 16/13/18.
- Arg handling: `--bogus` and `--only foo` -> usage, exit 2; `--only route` -> not-implemented line, exit 1.

open:
- A full run (no `--only`) exits 1 by design until T4 implements the `route` group.
- Timing risk: the plugin's hook timeout is 20 s (bridge.mjs HOOK_TIMEOUT_MS) and the stub makes the three calls sequentially in one PostToolUse hook; they fit comfortably in the live run (each ~1-3 s), rows are written per variant so a slow model would show as a missing variant row (a strict FAIL), not hidden. A slower paid model could trip that limit.
- Not committed; docs/dod.md untouched.
