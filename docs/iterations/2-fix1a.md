# Iteration 2 — fix 1a: failing tests for the one-variant-per-hook stub

changed:
- Added `plugin/dsh/test/stub_core.test.mjs` only (node:test, loopback fake `/v1/complete`, Bearer token check,
  endpoint file `{port, token, pid}`, spawns `TE_PYTHON || python3 stub_core.py hook --host dsh` with the
  payload on stdin, async spawn so the in-process fake can answer). No production, stub, docs/dod.md or other
  test changes; nothing committed.
- Test 5 (concurrency) makes the fake hold each answer until 3 requests are in flight (2.5 s cap) and asserts
  `maxInflight === 3`. That is how "at most one variant per process" shows under concurrency: the current
  stub already yields 3 distinct rows there (one process runs all three serially), so a rows-only check would pass.
- Tests 3 and 6 assert step by step (after each process / after SessionStart) so they fail on the current
  stub rather than passing vacuously.

gates: `TE_PYTHON=/tmp/te-venv/bin/python node --test test/stub_core.test.mjs` (in plugin/dsh) — 7 tests, 1 pass, 6 fail, all failures are AssertionErrors:
1. one PostToolUse process = 1 row, 1 request — FAIL: variants `['', 'other/model', 'bare-model']`, expected `['']` ("one hook process, one variant")
2. successive processes, in order, paid_model in body — FAIL: after process 1 rows are all three variants, expected `['']`
3. 4th process adds nothing — FAIL: after process 1 all three variants already written, expected `['']`
4. Stop / SessionEnd / PostToolUse claim in turn — FAIL: Stop writes no row, expected `['']`
5. 4 concurrent processes, 3 variants — FAIL: `maxInflight` 1 !== 3 (all variants run serially in one process)
6. SessionStart runs nothing, answers `TE-LIVE-FACTS-7f3a`, next PostToolUse takes first variant only — FAIL: the next PostToolUse writes all three, expected `['']`
7. legacy mode (no TE_LIVE_RUNNER): one row with keys `endpoint_env`, `reply`, no `variant` — PASS
- Sanity check: against a scratch copy (outside the repo, deleted) of the stub with per-variant O_EXCL claim
  files, one variant per process, and Stop/SessionEnd handled like PostToolUse, all 7 tests pass. So the tests
  are satisfiable and not flaky there.

open:
- Test 5 depends on the barrier: with a correct implementation all 3 claiming processes must reach their request
  within 2.5 s of each other (it passed in the scratch run). On a very loaded machine it could flake; raise `ms` if so.
- The tests assume the claim covers Stop and SessionEnd as well as PostToolUse, and that a PostToolUse hook
  still prints the TE-LIVE-REDIRECT note when nothing is left to claim (test 3 checks that).
- The implementer must keep the per-variant claim marker name free; tests don't read marker files.
