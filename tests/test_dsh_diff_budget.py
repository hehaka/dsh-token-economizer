"""The fork's additive rule: new files are free, edits to upstream files are counted."""
import importlib.util
import os
import subprocess

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location(
    "dsh_diff_budget", os.path.join(HERE, "..", "scripts", "dsh_diff_budget.py"))
budget = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(budget)


def git(cwd, *args):
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=cwd,
                   check=True, capture_output=True, text=True)


def write(cwd, name, text):
    path = os.path.join(cwd, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


@pytest.fixture()
def repo(tmp_path):
    cwd = str(tmp_path)
    git(cwd, "init", "-q", "-b", "main")
    write(cwd, "hosts.py", "a\nb\nc\n")
    git(cwd, "add", "-A")
    git(cwd, "commit", "-q", "-m", "base")
    git(cwd, "branch", "upstream")
    git(cwd, "switch", "-q", "-c", "dsh")
    return cwd


def commit(cwd, msg="change"):
    git(cwd, "add", "-A")
    git(cwd, "commit", "-q", "-m", msg)


def test_new_files_are_free(repo):
    write(repo, "plugin/dsh/index.mjs", "x\n" * 500)
    commit(repo)
    assert budget.measure("upstream", cwd=repo) == []


def test_edits_to_upstream_files_count_added_and_removed(repo):
    write(repo, "hosts.py", "a\nB\nc\nd\n")
    commit(repo)
    assert budget.measure("upstream", cwd=repo) == [("hosts.py", 2, 1)]


def test_upstream_moving_ahead_does_not_count(repo):
    git(repo, "switch", "-q", "upstream")
    write(repo, "hosts.py", "a\nb\nc\n" + "u\n" * 200)
    commit(repo, "upstream moves")
    git(repo, "switch", "-q", "dsh")
    write(repo, "extra.py", "new\n")
    commit(repo)
    assert budget.measure("upstream", cwd=repo) == []


def test_main_exit_status_follows_the_budget(repo, monkeypatch):
    write(repo, "hosts.py", "a\nb\nc\n" + "n\n" * 10)
    commit(repo)
    monkeypatch.chdir(repo)
    assert budget.main(["--base", "upstream", "--budget", "10"]) == 0
    assert budget.main(["--base", "upstream", "--budget", "9"]) == 1
    assert budget.main(["--base", "no-such-ref"]) == 2
