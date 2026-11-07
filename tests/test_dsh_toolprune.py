"""Tool pruning on DSH (docs/dsh/adr/0004). The core decides which tools to drop and writes the
deny list into the repository's `.dsh/token-economizer.local.json`; the DSH plugin reads that file
at agent creation and applies it with `restrict`. Only an MCP server's tools may be proposed."""
import json
import os

import pytest

from tokeneconomizer.plugin import adapter, denylist, dsh_catalog
from tokeneconomizer.plugin.hook import run
from tokeneconomizer.plugin.paths import repo_identity, repo_state_dir
from tokeneconomizer.plugin.store import Store

from test_dsh_host import spool

CATALOG = ["bash", "read", "edit", "tool_call", "tool_search", "mcp", "github_search",
           "mcp__crm__search", "mcp__crm__update", "mcp__docs__lookup"]


@pytest.fixture()
def repo_env(tmp_path):
    repo = tmp_path / "repo"
    (repo / ".git" / "info").mkdir(parents=True)
    (repo / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
    (repo / ".git" / "config").write_text(
        '[remote "origin"]\n\turl = https://github.com/acme/widget.git\n')
    env = {"TOKENECONOMIZER_HOME": str(tmp_path / "state"), "TE_FOLD_SYNC": "1",
           "PATH": os.environ.get("PATH", ""), "GIT_CEILING_DIRECTORIES": str(tmp_path),
           "TE_TOOLPRUNE_EVIDENCE": "1", "TE_TOOLPRUNE_MIN_SESSIONS": "1",
           "TE_TOOLPRUNE_SESSIONS": "2", "TE_TOOLPRUNE_QUIET_MINUTES": "0"}
    store = Store(repo_state_dir(repo_identity(str(repo), env), "dsh", env))
    return str(repo), env, store


def _live(repo, env, tmp_path, n, calls):
    """One finished DSH session that called `calls` (name, args, result, isError)."""
    sid = f"dsh-{n}"
    log, calls = spool(str(tmp_path / f"{sid}.jsonl"), repo, sid=sid, calls=calls)
    base = {"session_id": sid, "cwd": repo, "transcript_path": log}
    run(dict(base, hook_event_name="SessionStart", source="startup"), env, host_hint="dsh")
    run(dict(base, hook_event_name="UserPromptSubmit", prompt_id="p1", prompt="work"), env,
        host_hint="dsh")
    for i, (name, args, text, err) in enumerate(calls):
        run(dict(base, hook_event_name="PostToolUse", prompt_id="p1", tool_use_id=f"c{i}",
                 tool_name=name, tool_input=args,
                 tool_response={"content": text, "isError": err}), env, host_hint="dsh")
    run(dict(base, hook_event_name="Stop", prompt_id="p1"), env, host_hint="dsh")
    run(dict(base, hook_event_name="SessionEnd", reason="other"), env, host_hint="dsh")


# ---- the deny list is a settings file the DSH plugin reads --------------------------------
def test_dsh_has_a_deny_list_of_tools_in_a_dsh_dir_file():
    assert denylist.supports("dsh")
    assert denylist.unit("dsh") == "tool" and denylist.unit("dsh", plural=True) == "tools"
    assert denylist.settings_path("/r", "dsh") == os.path.join("/r", ".dsh", "token-economizer.local.json")
    assert denylist.supports("pi") is False               # the other Pi-shaped host is unchanged


def test_apply_writes_a_namespaced_list_and_keeps_what_the_person_wrote(repo_env):
    repo, env, store = repo_env
    path = denylist.settings_path(repo, "dsh")
    os.makedirs(os.path.dirname(path))
    with open(path, "w") as fh:
        json.dump({"note": "mine", "tokeneconomizer": {"deny": ["mcp__mine__tool"], "x": 1}}, fh)
    added = denylist.apply(repo, ["mcp__crm__update", "mcp__mine__tool"], store, host="dsh")
    assert added == ["mcp__crm__update"]                    # the person's own entry is not re-added
    doc = json.load(open(path))
    assert doc["note"] == "mine" and doc["tokeneconomizer"]["x"] == 1
    assert doc["tokeneconomizer"]["deny"] == ["mcp__mine__tool", "mcp__crm__update"]
    assert denylist.applied_for(store, repo, "dsh") == ["mcp__crm__update"]
    assert not os.path.exists(os.path.join(repo, ".git", "info", "exclude"))    # a file the person made is theirs
    removed = denylist.restore(repo, store, host="dsh")
    assert removed == ["mcp__crm__update"]                  # only what the plugin added
    assert json.load(open(path))["tokeneconomizer"]["deny"] == ["mcp__mine__tool"]
    assert denylist.applied_for(store, repo, "dsh") == []


def test_a_file_the_plugin_creates_is_kept_out_of_git(repo_env):
    repo, env, store = repo_env
    denylist.apply(repo, ["mcp__crm__update"], store, host="dsh")
    assert "/.dsh/token-economizer.local.json" in open(os.path.join(repo, ".git", "info", "exclude")).read()


def test_restoring_everything_leaves_no_empty_namespace(repo_env):
    repo, env, store = repo_env
    denylist.apply(repo, ["mcp__crm__update"], store, host="dsh")
    denylist.restore(repo, store, host="dsh")
    assert json.load(open(denylist.settings_path(repo, "dsh"))) == {}


def test_a_symlinked_dsh_dir_is_refused(repo_env, tmp_path):
    repo, env, store = repo_env
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    os.symlink(elsewhere, os.path.join(repo, ".dsh"))
    with pytest.raises(RuntimeError, match="symlink"):
        denylist.apply(repo, ["mcp__crm__update"], store, host="dsh")
    assert os.listdir(elsewhere) == []


def test_the_other_hosts_files_are_unchanged(repo_env):
    repo, env, store = repo_env
    denylist.apply(repo, ["WebFetchX"], store, host="claude")
    assert json.load(open(os.path.join(repo, ".claude", "settings.local.json"))) == {
        "permissions": {"deny": ["WebFetchX"]}}
    denylist.apply(repo, ["srv"], store, host="copilot")
    assert json.load(open(denylist.settings_path(repo, "copilot"))) == {"disabledMcpServers": ["srv"]}


# ---- only MCP tools can be proposed ---------------------------------------------------------
def _protected(host, protect=()):
    class H:
        name = host
    return adapter.LiveAdapter(H(), "/r", protect=protect).protected_tools()


@pytest.mark.parametrize("name", ["bash", "read", "edit", "write", "grep", "glob", "skill", "present",
                                  "tool_call", "tool_search", "tool_describe", "mcp", "github_search",
                                  "m", "mc", "mcp_", "mcp_x", "mcpx", "Zed", "_x", "x"])
def test_every_name_but_an_mcp_servers_tool_is_protected_on_dsh(name):
    assert name in _protected("dsh")


@pytest.mark.parametrize("name", ["mcp__crm__search", "mcp__a__b", "mcp__x__y", "mcp__headroom__x"])
def test_an_mcp_servers_tools_are_not_protected_on_dsh(name):
    assert name not in _protected("dsh")


def test_the_person_can_still_protect_an_mcp_tool_on_dsh():
    p = _protected("dsh", protect=("mcp__crm__*",))
    assert "mcp__crm__search" in p and "mcp__docs__lookup" not in p


def test_other_hosts_protection_is_unchanged():
    for host in ("claude", "pi", "copilot"):
        assert "github_search" not in _protected(host)         # the DSH patterns apply to DSH only
        assert "mcp__crm__search" not in _protected(host)
    assert "Bash" in _protected("claude") and "bash" in _protected("dsh")


# ---- evidence -> proposal -> deny list ----------------------------------------------------
def _catalog(env, tools):
    path = adapter.catalog_path(env["TOKENECONOMIZER_HOME"], "dsh")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump({"tools": tools}, open(path, "w"))


def test_a_never_used_mcp_tool_is_proposed_and_written_nothing_else_is(repo_env, tmp_path):
    repo, env, store = repo_env
    _catalog(env, CATALOG)                                   # what the plugin records at agent start
    used = [("bash", {"command": "ls"}, "ok", False), ("mcp__crm__search", {"q": "x"}, "ok", False)]
    for n in (1, 2, 3):
        _live(repo, env, tmp_path, n, used)
    unt = store.read("untool.json")
    assert unt["catalog_source"] == "probe+observed"
    assert sorted(unt["catalog_tools"]) == sorted(CATALOG)
    never = {"mcp__crm__update", "mcp__docs__lookup"}
    written = set(denylist.applied_for(store, repo, "dsh"))
    assert written == never                                   # `auto`, no quiet time configured
    for kept in ("bash", "read", "edit", "tool_call", "tool_search", "mcp", "github_search",
                 "mcp__crm__search"):
        assert kept not in written
    doc = json.load(open(denylist.settings_path(repo, "dsh")))
    assert set(doc["tokeneconomizer"]["deny"]) == never


def test_without_the_catalog_only_what_was_used_is_known(repo_env, tmp_path):
    repo, env, store = repo_env                               # no catalog.json: nothing unused to find
    for n in (1, 2, 3):
        _live(repo, env, tmp_path, n, [("bash", {"command": "ls"}, "ok", False)])
    assert (store.read("untool.json") or {}).get("proposal") == []
    assert denylist.applied_for(store, repo, "dsh") == []


def test_propose_mode_writes_nothing_until_asked(repo_env, tmp_path):
    repo, env, store = repo_env
    env = dict(env, TE_TOOLPRUNE="propose")
    _catalog(env, CATALOG)
    for n in (1, 2, 3):
        _live(repo, env, tmp_path, n, [("bash", {"command": "ls"}, "ok", False)])
    assert set(store.read("untool.json")["proposal"]) == {"mcp__crm__search", "mcp__crm__update",
                                                          "mcp__docs__lookup"}
    assert not os.path.exists(denylist.settings_path(repo, "dsh"))


def test_a_tool_given_back_is_not_proposed_again(repo_env, tmp_path):
    repo, env, store = repo_env
    _catalog(env, CATALOG)
    calls = [("bash", {"command": "ls"}, "ok", False)]
    for n in (1, 2, 3):
        _live(repo, env, tmp_path, n, calls)
    assert "mcp__docs__lookup" in denylist.applied_for(store, repo, "dsh")
    removed = denylist.restore(repo, store, ["mcp__docs__lookup"], host="dsh")
    denylist.set_kept(store, repo, "dsh", add=removed)
    for n in (4, 5):
        _live(repo, env, tmp_path, n, calls)
    assert "mcp__docs__lookup" not in denylist.applied_for(store, repo, "dsh")
    assert "mcp__docs__lookup" not in json.load(open(denylist.settings_path(repo, "dsh"))).get(
        "tokeneconomizer", {}).get("deny", [])


def test_shadow_mode_never_writes_the_file(repo_env, tmp_path):
    repo, env, store = repo_env
    env = dict(env, TE_SHADOW="1")
    _catalog(env, CATALOG)
    for n in (1, 2, 3):
        _live(repo, env, tmp_path, n, [("bash", {"command": "ls"}, "ok", False)])
    assert not os.path.exists(denylist.settings_path(repo, "dsh"))


# ---- G3: the host-wide catalog is the LAST session's tool list, of ANY repository ---------------
import hashlib  # noqa: E402


def _own_catalog(env, repo_root, tools):
    """What the plugin writes next to the host-wide file: `catalogs/<sha1(repo root)[:16]>.json`."""
    key = hashlib.sha1(repo_root.encode("utf-8")).hexdigest()[:16]
    path = os.path.join(env["TOKENECONOMIZER_HOME"], "hosts", "dsh", "catalogs", key + ".json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump({"tools": tools, "host": "dsh"}, open(path, "w"))
    return path


def test_a_repos_own_catalog_is_not_polluted_by_another_repos_tools(repo_env, tmp_path):
    repo, env, store = repo_env
    root = repo_identity(repo, env).root
    # Repo A's session was the last to start: the host-wide file holds A's mcp tools.
    _catalog(env, CATALOG)
    # This repository's own sessions never had the crm tools.
    _own_catalog(env, root, ["bash", "read", "edit", "tool_call", "tool_search", "mcp__docs__lookup"])
    for n in (1, 2, 3):
        _live(repo, env, tmp_path, n, [("bash", {"command": "ls"}, "ok", False)])
    unt = store.read("untool.json")
    assert "mcp__crm__search" not in unt["catalog_tools"] and "mcp__crm__update" not in unt["catalog_tools"]
    assert set(denylist.applied_for(store, repo, "dsh")) == {"mcp__docs__lookup"}


def test_the_host_wide_catalog_is_still_the_fallback_without_an_own_file(repo_env, tmp_path):
    repo, env, store = repo_env
    _catalog(env, CATALOG)
    other = os.path.join(str(tmp_path), "elsewhere")                      # another repository's file
    _own_catalog(env, other, ["bash", "mcp__other__tool"])
    for n in (1, 2, 3):
        _live(repo, env, tmp_path, n, [("bash", {"command": "ls"}, "ok", False)])
    assert set(denylist.applied_for(store, repo, "dsh")) == {"mcp__crm__search", "mcp__crm__update",
                                                             "mcp__docs__lookup"}


def test_load_catalog_prefers_the_repos_file_and_keeps_its_old_signature(tmp_path):
    home = str(tmp_path)
    path = adapter.catalog_path(home, "dsh")
    os.makedirs(os.path.dirname(path))
    json.dump({"tools": ["g1", "g2"]}, open(path, "w"))
    assert adapter.load_catalog(home, "dsh") == {"g1": "", "g2": ""}              # the old two-argument call
    assert adapter.load_catalog(home, "dsh", "/r/a") == {"g1": "", "g2": ""}      # no file of its own
    own = dsh_catalog.repo_catalog_path(home, "dsh", "/r/a")
    assert own == os.path.join(home, "hosts", "dsh", "catalogs", hashlib.sha1(b"/r/a").hexdigest()[:16] + ".json")
    assert os.path.basename(own) == "124e753dd7ff7c84.json"                       # the plugin's tools.test.mjs pins the same
    os.makedirs(os.path.dirname(own))
    json.dump({"tools": ["a1"]}, open(own, "w"))
    assert adapter.load_catalog(home, "dsh", "/r/a") == {"a1": ""}
    assert adapter.load_catalog(home, "dsh", "/r/b") == {"g1": "", "g2": ""}      # another repo: the fallback
    assert adapter.load_catalog(home, "dsh") == {"g1": "", "g2": ""}
    open(own, "w").write("{ broken")                          # a damaged own file: nothing known, never another repo's tools
    assert adapter.load_catalog(home, "dsh", "/r/a") == {}
    assert adapter.load_catalog(str(tmp_path / "none"), "dsh", "/r/a") == {}


# ---- G5: a hand-edited settings file of the wrong shape is refused, never changed ---------------
BAD_SHAPES = [
    pytest.param({"tokeneconomizer": "x"}, id="te-str"),
    pytest.param({"tokeneconomizer": ["a"]}, id="te-list"),
    pytest.param({"tokeneconomizer": None}, id="te-null"),
    pytest.param({"tokeneconomizer": {"deny": "mcp__a__b"}}, id="deny-str"),
    pytest.param({"tokeneconomizer": {"deny": {"a": 1}}}, id="deny-dict"),
    pytest.param({"tokeneconomizer": {"deny": None}}, id="deny-null"),
    pytest.param({"tokeneconomizer": {"deny": 7}}, id="deny-number"),
]


def _raw(path, doc):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        fh.write(json.dumps(doc, indent=1) + "\n")           # the person's own formatting
    return open(path, "rb").read()


@pytest.mark.parametrize("doc", BAD_SHAPES)
def test_apply_refuses_a_misshapen_deny_list_and_leaves_the_file_alone(repo_env, doc):
    repo, env, store = repo_env
    path = denylist.settings_path(repo, "dsh")
    before = _raw(path, doc)
    with pytest.raises(RuntimeError, match="refusing to edit"):
        denylist.apply(repo, ["mcp__crm__update"], store, host="dsh")
    assert open(path, "rb").read() == before
    assert denylist.applied_for(store, repo, "dsh") == []     # nothing was recorded as the plugin's


@pytest.mark.parametrize("doc", BAD_SHAPES)
def test_restore_refuses_a_misshapen_deny_list_and_leaves_the_file_alone(repo_env, doc):
    repo, env, store = repo_env
    denylist.apply(repo, ["mcp__crm__update"], store, host="dsh")      # the plugin's own entry ...
    path = denylist.settings_path(repo, "dsh")
    before = _raw(path, doc)                                           # ... then the person edits the file by hand
    with pytest.raises(RuntimeError, match="refusing to edit"):
        denylist.restore(repo, store, host="dsh")
    assert open(path, "rb").read() == before                           # not a list of characters, not emptied
    assert denylist.applied_for(store, repo, "dsh") == ["mcp__crm__update"]   # and the record is kept


def test_a_misshapen_file_stops_the_pending_write_without_a_crash(repo_env, tmp_path):
    repo, env, store = repo_env
    path = denylist.settings_path(repo, "dsh")
    before = _raw(path, {"tokeneconomizer": {"deny": "mcp__a__b"}})
    _catalog(env, CATALOG)
    for n in (1, 2, 3):
        _live(repo, env, tmp_path, n, [("bash", {"command": "ls"}, "ok", False)])   # the fold must survive it
    assert open(path, "rb").read() == before
    assert denylist.applied_for(store, repo, "dsh") == []
