"""The DSH host (docs/dsh/adr/0001, 0002): a Pi-format spool of a DSH session read through the
shared trace seam, a hook lifecycle that folds into the ledger, and no call into another agent."""
import json
import os
import subprocess
import sys

import pytest

from tokeneconomizer.plugin import denylist, hosts, sidecall
from tokeneconomizer.plugin.hook import run
from tokeneconomizer.plugin.host_dsh import Dsh
from tokeneconomizer.plugin.paths import repo_identity, repo_state_dir
from tokeneconomizer.plugin.store import Store

MODEL = "claude-haiku-5-5"      # a DSH model id; every claude-* id is priced on the Claude curve
USAGE = {"input": 4, "output": 105, "cacheRead": 2326, "cacheWrite": 13774}


def spool(path, cwd, sid="dsh-1", calls=None):
    """What the DSH plugin writes: a Pi-format session tree, one prompt and a few tool calls
    (name, arguments, result text, isError); each assistant message carries DSH's usage."""
    calls = calls if calls is not None else [
        ("bash", {"command": "pytest -q"}, "bash: pytest: command not found", True),
        ("bash", {"command": "python -m pytest -q"}, "1 passed", False),
        ("read", {"path": "a.py"}, "x = 1", False)]
    rows, parent = [{"type": "session", "version": 3, "id": sid, "cwd": cwd}], None

    def add(message):
        nonlocal parent
        eid = f"e{len(rows):03d}"
        rows.append({"type": "message", "id": eid, "parentId": parent, "message": message})
        parent = eid

    add({"role": "user", "content": [{"type": "text", "text": "fix the failing test"}]})
    for i, (name, args, text, err) in enumerate(calls):
        add({"role": "assistant", "model": MODEL, "usage": USAGE,
             "content": [{"type": "toolCall", "id": f"c{i}", "name": name, "arguments": args}]})
        add({"role": "toolResult", "toolCallId": f"c{i}", "isError": err,
             "content": [{"type": "text", "text": text}]})
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(json.dumps(r) for r in rows) + "\n")
    return path, calls


@pytest.fixture()
def dsh_env(tmp_path):
    repo = tmp_path / "repo"
    (repo / ".git" / "info").mkdir(parents=True)
    (repo / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
    (repo / ".git" / "config").write_text(
        '[remote "origin"]\n\turl = https://github.com/acme/widget.git\n')
    env = {"TOKENECONOMIZER_HOME": str(tmp_path / "state"), "TE_FOLD_SYNC": "1",
           "PATH": os.environ.get("PATH", ""), "GIT_CEILING_DIRECTORIES": str(tmp_path)}
    store = Store(repo_state_dir(repo_identity(str(repo), env), "dsh", env))
    return str(repo), env, store


def test_dsh_is_a_registered_pi_shaped_host():
    assert hosts.HOSTS["dsh"] is Dsh and issubclass(Dsh, hosts.Pi)
    assert hosts.detect({}, hint="dsh").name == "dsh"
    assert "dsh" in hosts.HOSTS and "pi" in hosts.HOSTS      # a separate store from Pi's


def test_importing_only_hosts_registers_dsh():
    """`hook.run` imports `hosts` alone; this module's own import of `host_dsh` would hide a
    missing registration, so it is checked in a process that imports nothing else."""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = subprocess.run(
        [sys.executable, "-c",
         "from tokeneconomizer.plugin import hosts; print(hosts.HOSTS['dsh'].name)"],
        cwd=root, capture_output=True, text=True, env=dict(os.environ, PYTHONPATH=root))
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "dsh"
    out = subprocess.run(
        [sys.executable, "-c",
         "from tokeneconomizer.plugin import host_dsh, hosts; print(hosts.HOSTS['dsh'].name)"],
        cwd=root, capture_output=True, text=True, env=dict(os.environ, PYTHONPATH=root))
    assert out.returncode == 0 and out.stdout.strip() == "dsh", out.stderr   # either order


def test_dsh_is_headless_only_when_the_plugin_says_so():
    h = Dsh()
    assert h.headless({"TE_DSH_MODE": "headless"})
    assert not h.headless({"TE_DSH_MODE": "interactive"}) and not h.headless({})
    assert not h.headless({"TE_PI_MODE": "print"})           # Pi's variable means nothing here


def test_the_spool_reads_through_the_trace_seam(tmp_path):
    path, calls = spool(str(tmp_path / "s.jsonl"), "/w/repo")
    h = Dsh()
    assert h.prompt_count(path) == 1
    u = h.session_usage(path)
    assert (u["input_tokens"], u["cache_read_input_tokens"], u["cache_creation_input_tokens"],
            u["output_tokens"], u["requests"], u["model"]) == (12, 6978, 41322, 315, 3, MODEL)
    out = h.mechanism_trace(path, str(tmp_path))
    traj = hosts.trace.load_trajectory(out)
    assert [(c[0], c[3]) for c in traj] == [("bash", False), ("bash", True), ("read", True)]
    # the guard keys on lower-case names, which DSH already uses
    assert [hosts.trace.call_cwds(out)] == [["/w/repo"] * 3]


@pytest.mark.real_sidecalls     # the suite's stand-in for `claude_call` would hide a fall-through
def test_side_calls_never_go_through_another_agent(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("a process was started")
    monkeypatch.setattr(subprocess, "run", boom)
    monkeypatch.setattr(subprocess, "Popen", boom)
    runner = sidecall.runner_for("dsh", type("C", (), {"paid_model": ""})())
    assert runner("anything") == ("", None)


def test_a_dsh_session_folds_into_the_ledger(tmp_path, dsh_env):
    repo, env, store = dsh_env
    log, calls = spool(str(tmp_path / "dsh-1.jsonl"), repo)
    base = {"session_id": "dsh-1", "cwd": repo, "transcript_path": log}
    run(dict(base, hook_event_name="SessionStart", source="startup"), env, host_hint="dsh")
    run(dict(base, hook_event_name="UserPromptSubmit", prompt_id="p1",
             prompt="fix the failing test"), env, host_hint="dsh")
    for i, (name, args, text, err) in enumerate(calls):
        run(dict(base, hook_event_name="PostToolUse", prompt_id="p1", tool_use_id=f"c{i}",
                 tool_name=name, tool_input=args,
                 tool_response={"content": text, "isError": err, "exit_code": 1 if err else 0}),
            env, host_hint="dsh")
    run(dict(base, hook_event_name="Stop", prompt_id="p1"), env, host_hint="dsh")
    run(dict(base, hook_event_name="SessionEnd", reason="other"), env, host_hint="dsh")

    sess = store.read("sessions/dsh-1.json")
    assert sess["turn"] is None and len(sess["turns"]) == 1 and sess["turns"][0]["tool_calls"] == 3
    (record,) = [r for r in store.read_lines("ledger.jsonl") if r.get("kind") == "session"]
    assert (record["requests"], record["model"]) == (3, MODEL)
    assert record["output_tokens"] == 315 and record["priced_by"] == "model"
    assert record["effective_tokens"] > 0
    assert not os.path.exists(os.path.join(repo, ".claude"))   # nothing written for another agent
