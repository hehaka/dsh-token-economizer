"""`te panel`: the data a visual panel reads. Status unchanged, plus the recorded session series,
with no estimate of what anything saved."""
import json

import pytest

from tokeneconomizer import pricing
from tokeneconomizer.plugin import cli, hosts, panel
from tokeneconomizer.plugin.context import LiveContext


def rec(sid="s", started=1000.0, eff=None, model="claude-haiku-5-5", **kw):
    r = {"kind": "session", "session_id": sid, "started": started,
         "ended": started + 60 if isinstance(started, (int, float)) else None,
         "model": model, "input_tokens": 10, "cache_read_input_tokens": 900,
         "cache_creation_input_tokens": 90, "output_tokens": 100, "requests": 3, "turns": 1,
         "nudges": 0, "aborts": 0, "overhead": {}, "injected_chars": 0}
    r.update(kw)
    r["effective_tokens"] = pricing.effective_tokens(r) if eff is None else eff
    return r


def test_parts_add_up_to_the_effective_tokens_on_the_same_weights():
    row = rec()
    s = panel.series([row])["sessions"][0]
    assert set(s["parts"]) == {"input", "cache_read", "cache_write", "output"}
    assert sum(s["parts"].values()) == pytest.approx(row["effective_tokens"], abs=0.5)
    w = pricing.weights_for(row)
    assert s["parts"]["cache_read"] == pytest.approx(900 * w["cache_read"])
    assert s["cache_hit"] == pytest.approx(900 / 1000, abs=1e-4)


def test_sessions_are_oldest_first_and_only_the_newest_are_kept():
    rows = [rec(f"s{i}", started=1000.0 + i * 10) for i in (3, 1, 2, 0, 4)]
    got = panel.series(rows, limit=3)
    assert [s["id"] for s in got["sessions"]] == ["s2", "s3", "s4"]
    assert got["earlier"] == 2


def test_imported_history_is_counted_not_drawn_and_other_kinds_are_ignored():
    rows = [rec("a"), rec("b", imported=True), {"kind": "overhead", "overhead": {"optimizer_tokens": 7}},
            {"kind": "other"}]
    got = panel.series(rows)
    assert [s["id"] for s in got["sessions"]] == ["a"]
    assert got["imported"] == 1 and got["unattributed_overhead"] == 7


def test_a_row_without_a_breakdown_is_one_total_and_has_no_hit_rate():
    row = {"kind": "session", "session_id": "old", "started": 5.0, "effective_tokens": 1234.0, "tokens_total": 1234}
    s = panel.series([row])["sessions"][0]
    assert s["parts"] == {"total": 1234.0} and s["cache_hit"] is None and s["effective"] == 1234.0


def test_a_model_the_table_cannot_price_does_not_break_the_series():
    row = rec(model="mystery-model-9", eff=4321.0)
    s = panel.series([row])["sessions"][0]
    assert s["parts"] == {"total": 4321.0} and s["effective"] == 4321.0


def test_unpriced_and_malformed_rows_come_through_as_gaps_not_errors():
    rows = [{"kind": "session", "session_id": "x"},
            rec("y", requests="many", nudges=None, overhead="oops", started="soon")]
    got = panel.series(rows)["sessions"]
    assert len(got) == 2
    assert got[0]["effective"] is None and got[0]["parts"] is None and got[0]["started"] is None
    assert got[1]["requests"] == 0 and got[1]["nudges"] == 0 and got[1]["overhead"] == 0


def test_overhead_and_injection_and_redirects_are_carried_per_session():
    row = rec(overhead={"spiral_judge_tokens": 12.5, "optimizer_tokens": 2}, injected_chars=300, nudges=2, aborts=1)
    s = panel.series([row])["sessions"][0]
    assert s["overhead"] == 14.5 and s["injected"] is True and s["nudges"] == 2 and s["aborts"] == 1


def test_the_series_claims_nothing_about_savings():
    text = json.dumps(panel.series([rec()])).lower()
    assert not any(w in text for w in ("saving", "saved", "baseline", "estimate"))


def test_sparkline_scales_to_the_tallest_value_and_leaves_gaps():
    assert panel.spark([]) == "" and panel.spark([None]) == ""
    assert panel.spark([0, 5, 10]) == "▁▅█"
    assert panel.spark([1, None, 2])[1] == " "


@pytest.fixture
def run(tmp_path, monkeypatch, capsys):
    repo = tmp_path / "repo"
    repo.mkdir()
    env = {"TOKENECONOMIZER_HOME": str(tmp_path / "state"), "GIT_CEILING_DIRECTORIES": str(tmp_path)}
    ctx = LiveContext.build(hosts.HOSTS["dsh"](), str(repo), env, settle=False)
    monkeypatch.setenv("TOKENECONOMIZER_HOME", ctx.root)
    monkeypatch.setattr(cli, "_ctx", lambda args: ctx)

    def go(*options, rows=()):
        for r in rows:
            ctx.store.append("ledger.jsonl", r)
        assert cli.main(["--host", "dsh", "--cwd", str(repo), "panel", *options]) == 0
        return capsys.readouterr().out
    return go


def test_json_holds_the_unchanged_status_and_the_series(run):
    data = json.loads(run("--json", rows=[rec("a", 1000.0), rec("b", 2000.0, injected_chars=40)]))
    assert data["schema"] == 1
    assert data["status"]["host"] == "dsh" and data["status"]["ledger"]["sessions"] == 2
    assert [s["id"] for s in data["series"]["sessions"]] == ["a", "b"]
    assert data["series"]["sessions"][1]["injected"] is True
    assert data["series"]["generated"] > 0
    assert data["status"]["ledger"]["effective_tokens"] == pytest.approx(
        sum(s["effective"] for s in data["series"]["sessions"]))


def test_json_is_one_compact_line_so_a_command_row_stays_short(run):
    out = run("--json", rows=[rec("a")])
    assert out.count("\n") == 1 and ", " not in out.split('"series"')[1][:40]


def test_an_empty_ledger_still_gives_a_valid_document_and_a_plain_message(run):
    data = json.loads(run("--json"))
    assert data["series"]["sessions"] == [] and data["status"]["ledger"]["sessions"] == 0
    assert "nothing folded yet" in run()


def test_text_view_lists_recent_sessions_with_a_sparkline(run):
    out = run(rows=[rec(f"s{i}", 1000.0 + i, injected_chars=1 if i == 2 else 0) for i in range(12)])
    assert "12 finished session(s)" in out and "effective tokens" in out and "cache hit rate" in out
    assert out.count("claude-haiku-5-5") == 10 and out.count("(facts injected)") in (0, 1)
