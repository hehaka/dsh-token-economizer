"""The DSH bundle (scripts/build_dsh_plugin.py) is self-contained: the plugin built into a flat
root finds the core without the checkout and folds a session through it."""
import json
import os
import shutil
import subprocess
import sys

import pytest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "scripts"))
import build_dsh_plugin  # noqa: E402


def test_the_bundle_is_a_flat_package_root_with_the_core_inside(tmp_path):
    out = build_dsh_plugin.build(str(tmp_path / "dsh"))
    pkg = json.load(open(os.path.join(out, "package.json"), encoding="utf-8"))
    assert pkg["name"] == "dsh-token-economizer" and pkg["main"] == "index.mjs"
    for rel in ("index.mjs", "src/plugin.mjs", "cordis.patch.yml", "scripts/te_bootstrap.py",
                "lib/tokeneconomizer/plugin/host_dsh.py", "LICENSE"):
        assert os.path.isfile(os.path.join(out, rel)), rel
    assert not os.path.exists(os.path.join(out, "test"))
    for name in pkg["dsh"].get("bundle", {}).values():
        assert os.path.isfile(os.path.join(out, name)), name


def test_the_bundle_runs_without_the_checkout(tmp_path):
    out = build_dsh_plugin.build(str(tmp_path / "dsh"))
    payload = json.dumps({"hook_event_name": "SessionStart", "session_id": "b1",
                          "cwd": str(tmp_path)})
    env = {"PATH": os.environ.get("PATH", ""), "HOME": str(tmp_path),
           "TOKENECONOMIZER_HOME": str(tmp_path / "state")}   # no PYTHONPATH, no TE_CORE_PATH
    r = subprocess.run([sys.executable, os.path.join(out, "scripts", "te_bootstrap.py"),
                        "hook", "--host", "dsh"], input=payload, capture_output=True, text=True,
                       env=env, cwd=str(tmp_path))
    assert r.returncode == 0, r.stderr
    assert isinstance(json.loads(r.stdout.strip().splitlines()[-1]), dict)
    # the copy, not the checkout, answered: it recorded under its own state directory
    assert os.path.isdir(str(tmp_path / "state"))


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_the_built_plugin_loads_in_node(tmp_path):
    out = build_dsh_plugin.build(str(tmp_path / "dsh"))
    r = subprocess.run(["node", "-e",
                        "import('./index.mjs').then(m=>console.log(m.name, typeof m.apply))"],
                       cwd=out, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert r.stdout.split() == ["token-economizer", "function"]
