# Iteration 2 — fix 1b: one paid_model variant per stub hook process

changed:
- `plugin/dsh/test/live/stub_core.py`: in TE_LIVE_RUNNER=1 mode PostToolUse, Stop and SessionEnd hooks each claim at most
  ONE variant of TE_LIVE_PAID atomically (`os.open` O_CREAT|O_EXCL on `<TE_LIVE_SIDE>.claim.<index>`), run only it through
  the real runner (same urlopen capture, same row shape, never raises) and exit; nothing is left -> does nothing.
  Old `.runner-done` marker removed. A setup failure (bad JSON, import) writes one `variant: null` row (claim `.claim.setup`).
  Legacy mode (TE_LIVE_SIDE without TE_LIVE_RUNNER) untouched.
- `plugin/dsh/test/live/live-sidecall.mjs`: the prompt asks for three separate bash calls (`echo te-live-sidecall-1/-2/-3`);
  new check "at least three variant rows were written" reports the row count; `redact()` (200 chars, 24+ `[A-Za-z0-9_-]` runs ->
  `<redacted>`) applied to `row.error`, the raw reply fields other than `text`, the setup error and the stderr tail; header comment
  about credentials now states what is guaranteed (best-effort filter only).

gates:
- `node --check` live-sidecall.mjs: ok
- `TE_PYTHON=/tmp/te-venv/bin/python node --test test/stub_core.test.mjs`: 7/7 pass (file unchanged)
- `cd plugin/dsh && npm test`: 98/98 pass
- `/tmp/te-venv/bin/python -m pytest -q tests/test_dsh_sidecall.py`: all pass
- `node plugin/dsh/test/live/live-sidecall.mjs --only paid` (real model): 13/13 PASS, 3 variant rows
- `node plugin/dsh/test/live/live-check.mjs`: 25/25 PASS

open:
- The redaction also hits the benign key `cache_creation_input_tokens` (26 chars) in the printed reply (shown as `<redacted>`);
  accepted per the spec, cosmetic.
- Without `--only`, live-sidecall still exits 1 because the route group is a T4 placeholder.
- Nothing committed; unrelated pre-existing modified files in the worktree were not touched.
