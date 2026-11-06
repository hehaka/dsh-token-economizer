#!/usr/bin/env python3
"""Fold finished DSH-shaped sessions into a TokenEconomizer state directory through the real hook
lifecycle (SessionStart -> prompt -> tool calls -> Stop -> SessionEnd), so a panel check has numbers
and history to draw. Standard library only; the clock is driven so sessions fall on different days.

    seed_session.py <repo_dir> <state_dir> [--sessions N] [--days D]
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


def fold(repo, state, i, started):
    sid = f"seed-{i}"
    rows, parent = [{"type": "session", "version": 3, "id": sid, "cwd": repo}], None

    def add(message):
        nonlocal parent
        eid = f"e{len(rows):03d}"
        rows.append({"type": "message", "id": eid, "parentId": parent, "message": message})
        parent = eid

    add({"role": "user", "content": [{"type": "text", "text": "fix the failing test"}]})
    for k, (name, args, text, err) in enumerate(CALLS):
        add({"role": "assistant", "model": MODEL, "usage": usage(i),
             "content": [{"type": "toolCall", "id": f"c{k}", "name": name, "arguments": args}]})
        add({"role": "toolResult", "toolCallId": f"c{k}", "isError": err, "content": [{"type": "text", "text": text}]})
    log = os.path.join(tempfile.mkdtemp(prefix="te-seed-"), f"{sid}.jsonl")
    with open(log, "w", encoding="utf-8") as fh:
        fh.write("\n".join(json.dumps(r) for r in rows) + "\n")
    env = dict(os.environ, TOKENECONOMIZER_HOME=state, TE_FOLD_SYNC="1")
    base = {"session_id": sid, "cwd": repo, "transcript_path": log}
    events = [("SessionStart", {"source": "startup"}), ("UserPromptSubmit", {"prompt_id": "p1", "prompt": "fix"})]
    events += [("PostToolUse", {"prompt_id": "p1", "tool_use_id": f"c{k}", "tool_name": n, "tool_input": a,
                                "tool_response": {"content": t, "isError": e, "exit_code": 1 if e else 0}})
               for k, (n, a, t, e) in enumerate(CALLS)]
    events += [("Stop", {"prompt_id": "p1"}), ("SessionEnd", {"reason": "other"})]
    clock = [started]

    def tick():
        clock[0] += 0.5
        return clock[0]
    with mock.patch("time.time", tick):
        for name, extra in events:
            run(dict(base, hook_event_name=name, **extra), env, host_hint="dsh")


def main(repo, state, sessions, days):
    today = datetime.datetime.now().replace(hour=10, minute=0, second=0, microsecond=0)
    for i in range(sessions):
        back = (sessions - 1 - i) * days // max(1, sessions - 1) if sessions > 1 else 0     # oldest first, spread over `days`
        when = today - datetime.timedelta(days=back) + datetime.timedelta(minutes=37 * i)
        fold(repo, state, i, when.timestamp())


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("repo")
    ap.add_argument("state")
    ap.add_argument("--sessions", type=int, default=1)
    ap.add_argument("--days", type=int, default=0)
    a = ap.parse_args()
    main(a.repo, a.state, a.sessions, a.days)
