# T7 review (sol, read-only; saved by the orchestrator)

| severity | file:line | reason |
|---|---|---|
| Minor | tokeneconomizer/plugin/panel.py:100 (source sidecall.py:107) | payload() passes a damaged sidecall.json through unvalidated: at as text, reason as number/array, a 1,000,000-char reason gives a 1,000,238-char `te panel --json` line (still one line). Declared shape {at: number, reason: string} and compactness are not guaranteed. |
| Minor | plugin/dsh/client/src/model.cjs:67 | side.paused as string/array/number is shown as `active` instead of `unknown`; a non-numeric `at` is shown as paused. |

Checked: 18 crafted cases (python panel.payload on temp state dirs; node buildModel/toViewState/view); ok: no pause, valid pause, array document, text view hides reason, old status and old panel payload -> unknown with 3 mechanisms, active/paused states, reason truncated to 120 chars in the model, React text child (no HTML injection), badge text for unknown, schema 1 and series unchanged, build ok and git status unchanged. Findings: the rows above. Note: a secret in the first 120 chars of a provider error stays visible in the UI; `te panel --json` carries the full reason by design.

Blocker 0, Major 0, Minor 2, Nit 0
