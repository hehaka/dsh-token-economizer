#!/usr/bin/env python3
"""Fold one finished DSH-shaped session into a TokenEconomizer state directory through the real hook
lifecycle (SessionStart -> prompt -> tool calls -> Stop -> SessionEnd), so a panel check has numbers
to show. Standard library only. Usage: seed_session.py <repo_dir> <state_dir> <repo_root_of_repo>."""
import json
import os
import sys
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), *[".."] * 5))
sys.path.insert(0, ROOT)
from tokeneconomizer.plugin.hook import run  # noqa: E402

MODEL, USAGE = "claude-haiku-5-5", {"input": 4, "output": 105, "cacheRead": 2326, "cacheWrite": 13774}
CALLS = [("bash", {"command": "pytest -q"}, "bash: pytest: command not found", True),
         ("bash", {"command": "python -m pytest -q"}, "1 passed", False),
         ("read", {"path": "a.py"}, "x = 1", False)]


def main(repo, state):
    rows, parent = [{"type": "session", "version": 3, "id": "seed-1", "cwd": repo}], None

    def add(message):
        nonlocal parent
        eid = f"e{len(rows):03d}"
        rows.append({"type": "message", "id": eid, "parentId": parent, "message": message})
        parent = eid

    add({"role": "user", "content": [{"type": "text", "text": "fix the failing test"}]})
    for i, (name, args, text, err) in enumerate(CALLS):
        add({"role": "assistant", "model": MODEL, "usage": USAGE,
             "content": [{"type": "toolCall", "id": f"c{i}", "name": name, "arguments": args}]})
        add({"role": "toolResult", "toolCallId": f"c{i}", "isError": err, "content": [{"type": "text", "text": text}]})
    log = os.path.join(tempfile.mkdtemp(prefix="te-seed-"), "seed-1.jsonl")
    with open(log, "w", encoding="utf-8") as fh:
        fh.write("\n".join(json.dumps(r) for r in rows) + "\n")
    env = dict(os.environ, TOKENECONOMIZER_HOME=state, TE_FOLD_SYNC="1")
    base = {"session_id": "seed-1", "cwd": repo, "transcript_path": log}
    events = [("SessionStart", {"source": "startup"}), ("UserPromptSubmit", {"prompt_id": "p1", "prompt": "fix"})]
    events += [("PostToolUse", {"prompt_id": "p1", "tool_use_id": f"c{i}", "tool_name": n, "tool_input": a,
                                "tool_response": {"content": t, "isError": e, "exit_code": 1 if e else 0}})
               for i, (n, a, t, e) in enumerate(CALLS)]
    events += [("Stop", {"prompt_id": "p1"}), ("SessionEnd", {"reason": "other"})]
    for name, extra in events:
        run(dict(base, hook_event_name=name, **extra), env, host_hint="dsh")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
