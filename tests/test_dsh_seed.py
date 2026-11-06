"""The panel's browser check feeds a ledger through the real hook lifecycle (client/test/browser/
seed_session.py). This pins what that scenario produces -- facts injected from some session on, one
looping turn that the guard redirects -- so the browser check can never pass on data that has neither."""
import importlib.util
import os
import time

import pytest

from tokeneconomizer.plugin import hosts, panel
from tokeneconomizer.plugin.context import LiveContext

SEED = os.path.join(os.path.dirname(__file__), "..", "plugin", "dsh", "client", "test", "browser", "seed_session.py")


@pytest.fixture(scope="module")
def ledger(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("seed")
    repo, state = tmp / "repo", tmp / "state"
    repo.mkdir()
    spec = importlib.util.spec_from_file_location("seed_session", SEED)
    seed = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(seed)
    old = os.environ.get("TOKENECONOMIZER_HOME")
    seed.main(str(repo), str(state), 9, 4, facts=True, stuck={6})
    env = {"TOKENECONOMIZER_HOME": str(state), "GIT_CEILING_DIRECTORIES": str(tmp)}
    ctx = LiveContext.build(hosts.HOSTS["dsh"](), str(repo), env, settle=False)
    rows = panel.series(ctx.store.read_lines("ledger.jsonl"))["sessions"]
    assert os.environ.get("TOKENECONOMIZER_HOME") == old       # the seed does not leak its state dir
    return rows


def test_every_session_is_folded_oldest_first_across_several_days(ledger):
    assert [r["id"] for r in ledger] == [f"seed-{i}" for i in range(9)]
    days = {time.strftime("%Y-%m-%d", time.localtime(r["started"])) for r in ledger}
    assert len(days) == 5
    assert all(r["effective"] and sum(r["parts"].values()) == pytest.approx(r["effective"], abs=0.5) for r in ledger)


def test_facts_are_injected_only_once_they_have_been_learned(ledger):
    flags = [r["injected"] for r in ledger]
    assert not flags[0] and flags[-1], flags                    # nothing to inject at first, facts at the end
    assert flags == sorted(flags), "once a fact is learned it stays injected"
    assert 1 <= sum(flags) < len(flags)


def test_the_looping_turn_is_redirected_and_the_others_are_not(ledger):
    loop = ledger[6]
    assert loop["requests"] == 40 and loop["nudges"] >= 1 and loop["aborts"] >= 1
    assert all(r["nudges"] == 0 and r["aborts"] == 0 for i, r in enumerate(ledger) if i != 6)


def test_the_cache_hit_rate_rises_as_the_prompt_cache_warms(ledger):
    hits = [r["cache_hit"] for r in ledger[:6]]
    assert all(h is not None for h in hits) and hits == sorted(hits)
