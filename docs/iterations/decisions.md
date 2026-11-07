# Decisions

- it0: D7 command fixed before freeze. Why: the plan's D7 grep pattern with \\\| escapes matched everything (empty ERE alternative), so D7 could never pass; replaced by an awk check of severity/disposition columns, tested on open-high, fixed-high and missing file. Rejected: keeping the plan wording.
- it0: no instruction file. Why: plan has none, repo has no docs/development-instruction.md; repo CLAUDE.md conventions and gates (pytest tests experiments/tests, npm test) apply; commit messages in repo style, no push until End (user asked to push earlier work, final push at End needs the 'cannot decide' rule: push was already authorised in this session for this branch).
- it1: D5/D13 pass vacuously today. Why: browser-check.mjs ignores unknown flags, so --prune/--only panel run the old 4 checks and pass; T6 must make unknown flags exit 2 and --prune/--only select real new checks, so the DoD commands are meaningful.
