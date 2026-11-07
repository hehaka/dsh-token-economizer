# Iteration 6 — implement (TDD step 2b): T7 panel `side`, Model calls row, tool-pruning detail

changed:
- `tokeneconomizer/plugin/panel.py`: `payload` adds `side: {"paused": sidecall.paused(host, ctx.root), "host": host}`; schema stays 1; other keys unchanged; text view untouched (does not print the reason). Docstring mentions `side`.
- `plugin/dsh/client/src/model.cjs`: `parsePanel` also returns `side`; `toViewState` passes it to `buildModel(status, side)`; `buildModel` accepts the payload (`{status, series, side}`) or a bare status; tool-pruning detail line `N applied (first 3 names, …) · M proposed · catalog: <source|none yet>` (core note, if any, is put in front); new `modelCalls` (`key: 'modelcalls'`, title `Model calls`, state active/paused/unknown, detail: `answered through DSH's model service` / reason cut at 120 + `te config set microskills|loopguard <mode>` hint / `no data`); `mechanisms` unchanged (3 keys).
- `plugin/dsh/client/src/view.cjs`: `ModelCalls` row (`data-te="modelcalls"`, after the mechanisms, own badge span with the state word, `data-te="modelcalls-state"`); drawn for an empty ledger too.
- No tests, `docs/dod.md`, `cli.py` or built artifacts touched; no commit.

gates:
- `pytest -q tests/test_panel.py tests/test_dsh_host.py tests/test_dsh_sidecall.py`: all pass.
- `cd plugin/dsh && npm test`: 122 tests, 122 pass, 0 fail.
- `python3 scripts/dsh_diff_budget.py`: 32 (budget 60).
- `pytest -q tests experiments/tests` (background): ran to 100%, no F/E in the output (the log has no summary line, only dots and `s` skips).
- Mutations by hand (each restored byte-for-byte, checked with `cmp` against copies): (1) `panel.py` always `paused: None` -> 3 test_panel tests fail; (2) `buildModel` ignores `side` -> npm 115 pass / 7 fail; (3) badge text removed -> npm 119 pass / 3 fail. After restore: 122/122 and test_panel green. `git status` shows only the 3 intended production files modified.

open:
- With a core `note` for tool pruning (e.g. "not available on dsh") the counts follow the note (`note · 0 applied · …`); harmless, but counts on an unsupported host are noise.
- Full-suite log had no summary line, so the exit code was not seen; judged from the absence of failure marks.
