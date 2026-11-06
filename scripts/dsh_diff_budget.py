#!/usr/bin/env python3
"""Enforce the fork's additive rule (docs/dsh/adr/0002): how much of UPSTREAM's own files the
DSH branch changes.

    python scripts/dsh_diff_budget.py [--base upstream/main] [--head HEAD] [--budget 60]

New files are free: they cannot conflict with upstream. What is counted is every line added or
removed in a file that already exists on the merge base (modified, deleted or type-changed), and
the total must stay within the budget. The comparison is `base...head`, from the merge base, so
upstream moving ahead never counts against the branch. Exit status 1 when over budget.
"""
import argparse
import os
import subprocess
import sys

DEFAULT_BUDGET = 60


def measure(base, head="HEAD", cwd=None):
    """[(path, added, removed)] for files that exist on the merge base and changed on `head`."""
    out = subprocess.run(
        ["git", "diff", "--numstat", "--no-renames", "--diff-filter=MDT", f"{base}...{head}"],
        cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or f"git diff {base}...{head} failed")
    rows = []
    for line in out.stdout.splitlines():
        added, removed, path = line.split("\t", 2)
        # A binary file shows "-": its size is not in lines, so it counts as one big change.
        rows.append((path, int(added) if added != "-" else DEFAULT_BUDGET + 1,
                     int(removed) if removed != "-" else 0))
    return rows


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--base", default="upstream/main")
    ap.add_argument("--head", default="HEAD")
    ap.add_argument("--budget", type=int,
                    default=int(os.environ.get("DSH_DIFF_BUDGET", DEFAULT_BUDGET)))
    args = ap.parse_args(argv)
    try:
        rows = measure(args.base, args.head)
    except RuntimeError as e:
        print(f"dsh-diff-budget: {e}", file=sys.stderr)
        return 2
    total = sum(a + r for _, a, r in rows)
    for path, a, r in sorted(rows, key=lambda x: -(x[1] + x[2])):
        print(f"  +{a:<4} -{r:<4} {path}")
    print(f"changed lines in upstream files: {total} (budget {args.budget})")
    if total > args.budget:
        print("over budget: move the change into a new file, or raise the budget in the PR "
              "with a reason (docs/dsh/adr/0002).", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
