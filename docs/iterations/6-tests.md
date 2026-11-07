# Iteration 6 — tests (TDD step 2a): T7 panel `side`, Model calls row, tool-pruning detail (DoD D6, D12, D13)

changed:
- `tests/test_panel.py`: the `run` fixture now also exposes `go.ctx` and `go.repo` (additive); new `pause_file` helper and 9 test cases (6 functions, one parametrised x4):
  `test_side_without_a_pause_file_says_not_paused_and_names_the_host`,
  `test_side_carries_the_pause_reason_and_time_from_the_documented_file`,
  `test_side_follows_the_pause_the_sidecall_module_writes_and_lifts` (real `sidecall._no_reply` writer, then `resume`),
  `test_a_damaged_pause_file_means_not_paused_not_a_crash[4 inputs]`,
  `test_the_other_keys_are_unchanged_and_side_is_the_only_addition` (key set, `schema`, `status` == `te status --json`, `series`),
  `test_the_text_view_does_not_print_the_pause_reason` (also asserts the reason is in `side`, so it is not vacuous).
- `plugin/dsh/client/test/model.test.mjs`: example note text replaced by `tool pruning is off` (same assertion; `grep "not available on dsh"` now finds nothing); 12 new tests: tool-pruning detail line (applied/proposed/catalog order, `none yet`, long applied list names only the first few, core note still shown), `modelCalls` active / paused / long reason cut at 120 / paused without reason / unknown (`STATUS`, `PANEL`, `side: undefined` -> detail `no data`), `mechanisms` keep 3 keys in order, `toViewState` carries `modelCalls` from `side`.
- `plugin/dsh/client/test/view.test.mjs`: 5 new tests (row after the mechanisms; active/paused/unknown each show title, state word and detail; a state badge element of its own whose text is exactly the state word; row drawn with an empty ledger).
- Contracts the tests pin that the spec left open (implementation must follow, or tell me to adjust): the row carries `data-te="modelcalls"` (NOT `mechanism-modelcalls`: the existing test requires exactly three `mechanism-*` rows); the badge is a single element whose text is the state word (`active`/`paused`/`unknown`, case-insensitive); `buildModel` accepts the panel payload (`{status, series, side}`) as well as a bare status, and `toViewState` must pass `side` through (today it passes only `parsed.status`); a pause object without a `reason` still gives `paused`.

gates:
- `/tmp/te-venv/bin/python -m pytest -q tests/test_panel.py`: 9 new cases ran, 9 fail, 13 old pass. Each fails on an assertion: `assert None == {'paused': None, 'host': 'dsh'}` (side absent; x6 incl. the 4 damaged-file cases), `assert (None is not None)` (carries reason), `assert (False)` isinstance dict (sidecall writer), `AssertionError: assert {'schema', 'series', 'status'} == {'schema', 'series', 'side', 'status'}` (other keys), `assert {} == {'at': 1234.5, 'reason': ...}` (text view test's non-vacuity check).
- `cd plugin/dsh && npm test`: 122 tests, 107 pass (106 old + 1 new guard), 15 fail. All failures are `AssertionError`: tests 17–19 (detail was `'1 proposed · 2 applied'`, no `catalog:`), 21–25 (`modelCalls` undefined: expected key `'modelcalls'` / state `'paused'`), 26 (expected repo `'acme/widget'`, got `'—'`: buildModel does not accept the payload form), 27 (expected `'paused'`), 44–48 (`a row marked modelcalls` / row text empty).
- New test that passes today on purpose: `a note from the core is still shown for tool pruning` (guards existing behaviour; named in the spec as "keep"). Not a failing-first test.
- D12's grep half: no occurrence of `not available on dsh` left in `model.test.mjs`.
- No production code touched; no commit; `docs/dod.md` untouched.

open:
- The exact detail wording beyond the spec is only pinned by regexes (`N applied`, first name present, last of 12 absent, `M proposed`, `catalog: <source|none yet>`, order applied < proposed < catalog); how many names are shown is the implementer's choice (must be < 12).
- "Mutations" (D6) are not run in this step; the cases are written so that dropping the `side` key, the 120 cut, the `unknown` branch or the row would each break a test.
- `te panel` text output was not extended with a side line; the test only requires it not to leak the reason.
