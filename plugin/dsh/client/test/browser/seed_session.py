#!/usr/bin/env python3
"""Fold finished DSH-shaped sessions into a TokenEconomizer state directory through the real hook
lifecycle (SessionStart -> prompt -> tool calls -> Stop -> SessionEnd), so a panel check has numbers
and history to draw. Standard library only; the clock is driven so sessions fall on different days.

    seed_session.py <repo_dir> <state_dir> [--sessions N] [--days D] [--facts] [--stuck I,J]

`--facts` turns the microskills mechanism on (TE_MICROSKILLS=envfacts): a fact learned from earlier
sessions is injected at the start of later ones. `--stuck I,J` makes those sessions' turn a loop (an edit
that works, then the same failing command, over and over), which the loop guard answers with a redirect once
the repository has seen enough ordinary turns.
"""
import argparse
import datetime
import json
import os
import sys
import tempfile
from unittest import mock

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), *[".."] * 5))
sys.path.insert(0, ROOT)
from tokeneconomizer.plugin.hook import run  # noqa: E402

MODEL = "claude-haiku-5-5"
CALLS = [("bash", {"command": "pytest -q"}, "bash: pytest: command not found", True),
         ("bash", {"command": "python -m pytest -q"}, "1 passed", False),
         ("read", {"path": "a.py"}, "x = 1", False)]


def usage(i):
    """Session i's token usage: the first session writes the cache, later ones mostly read it."""
    base = 1 + (i * 7) % 5
    return {"input": 4 * base, "output": 105 * base, "cacheRead": 2326 * (i + 1), "cacheWrite": max(500, 13774 - i * 2600)}


STUCK_USAGE = {"input": 2, "output": 60, "cacheRead": 9000, "cacheWrite": 300}   # per call: a long turn stays comparable
FAIL = ("bash", {"command": "pytest -q"}, "Exit code 1\nFAILED tests/test_a.py::test_x - AssertionError: assert 1 == 2", True)
EDIT = ("edit", {"path": "pkg/a.py", "oldText": "x", "newText": "y"}, "ok", False)


def stuck_calls(n=40):
    return [EDIT if k % 2 == 0 else FAIL for k in range(n)]


def fold(repo, state, i, started, calls=CALLS, per_call=None, facts=False):
    sid = f"seed-{i}"
    rows, parent = [{"type": "session", "version": 3, "id": sid, "cwd": repo}], None

    def add(message):
        nonlocal parent
        eid = f"e{len(rows):03d}"
        rows.append({"type": "message", "id": eid, "parentId": parent, "message": message})
        parent = eid

    add({"role": "user", "content": [{"type": "text", "text": "fix the failing test"}]})
    for k, (name, args, text, err) in enumerate(calls):
        add({"role": "assistant", "model": MODEL, "usage": per_call or usage(i),
             "content": [{"type": "toolCall", "id": f"c{k}", "name": name, "arguments": args}]})
        add({"role": "toolResult", "toolCallId": f"c{k}", "isError": err, "content": [{"type": "text", "text": text}]})
    log = os.path.join(tempfile.mkdtemp(prefix="te-seed-"), f"{sid}.jsonl")
    with open(log, "w", encoding="utf-8") as fh:
        fh.write("\n".join(json.dumps(r) for r in rows) + "\n")
    env = dict(os.environ, TOKENECONOMIZER_HOME=state, TE_FOLD_SYNC="1")
    if facts:
        env["TE_MICROSKILLS"] = "envfacts"
    base = {"session_id": sid, "cwd": repo, "transcript_path": log}
    events = [("SessionStart", {"source": "startup"}), ("UserPromptSubmit", {"prompt_id": "p1", "prompt": "fix"})]
    events += [("PostToolUse", {"prompt_id": "p1", "tool_use_id": f"c{k}", "tool_name": n, "tool_input": a,
                                "tool_response": {"content": t, "isError": e, "exit_code": 1 if e else 0}})
               for k, (n, a, t, e) in enumerate(calls)]
    events += [("Stop", {"prompt_id": "p1"}), ("SessionEnd", {"reason": "other"})]
    clock = [started]

    def tick():
        clock[0] += 0.5
        return clock[0]
    with mock.patch("time.time", tick):
        for name, extra in events:
            run(dict(base, hook_event_name=name, **extra), env, host_hint="dsh")


def main(repo, state, sessions, days, facts=False, stuck=()):
    today = datetime.datetime.now().replace(hour=10, minute=0, second=0, microsecond=0)
    for i in range(sessions):
        back = (sessions - 1 - i) * days // max(1, sessions - 1) if sessions > 1 else 0     # oldest first, spread over `days`
        when = today - datetime.timedelta(days=back) + datetime.timedelta(minutes=37 * i)
        if i in stuck:
            fold(repo, state, i, when.timestamp(), calls=stuck_calls(), per_call=STUCK_USAGE, facts=facts)
        else:
            fold(repo, state, i, when.timestamp(), facts=facts)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("repo")
    ap.add_argument("state")
    ap.add_argument("--sessions", type=int, default=1)
    ap.add_argument("--days", type=int, default=0)
    ap.add_argument("--facts", action="store_true")
    ap.add_argument("--stuck", default="", help="comma-separated session indexes whose turn is a loop")
    a = ap.parse_args()
    main(a.repo, a.state, a.sessions, a.days, a.facts, {int(x) for x in a.stuck.split(",") if x})
