"""The plugin's model calls on DSH (docs/dsh/adr/0004): the core's runner talks to the DSH plugin's
loopback endpoint, which a fake here stands in for. The wire format and every failure mode are
pinned; the plugin side is tested in plugin/dsh/test, and both together in sidecall.e2e.test.mjs."""
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from tokeneconomizer.plugin import accounting, dsh_sidecall, hosts, judge, sidecall
from tokeneconomizer.plugin.context import LiveContext
from tokeneconomizer.plugin.paths import state_root

USAGE = {"input_tokens": 120, "cache_read_input_tokens": 3000, "cache_creation_input_tokens": 0,
         "output_tokens": 40}


class Fake:
    """A loopback server that answers as the DSH plugin does."""

    def __init__(self, tmp_path):
        self.requests, self.reply = [], (200, {"text": "ok", "usage": USAGE,
                                               "model": "claude-haiku-5-5"})
        self.delay = 0.0
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                outer.requests.append({"path": self.path, "auth": self.headers.get("Authorization"),
                                       "type": self.headers.get("Content-Type"),
                                       "host": self.headers.get("Host"),
                                       "body": json.loads(self.rfile.read(n).decode())})
                time.sleep(outer.delay)
                status, doc = outer.reply
                data = json.dumps(doc).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                try:
                    self.wfile.write(data)
                except OSError:
                    pass

        self.httpd = HTTPServer(("127.0.0.1", 0), H)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.file = str(tmp_path / "sidecall.1.endpoint.json")
        self.token = "t0k3n"
        self.write()

    def write(self, **over):
        with open(self.file, "w") as fh:
            json.dump(dict({"port": self.port, "token": self.token, "pid": os.getpid()}, **over), fh)

    @property
    def env(self):
        return {dsh_sidecall.ENV_FILE: self.file}

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture()
def fake(tmp_path):
    f = Fake(tmp_path)
    yield f
    f.stop()


@pytest.fixture(autouse=True)
def state(tmp_path, monkeypatch):
    monkeypatch.setenv("TOKENECONOMIZER_HOME", str(tmp_path / "state"))
    monkeypatch.delenv(dsh_sidecall.ENV_FILE, raising=False)
    return str(tmp_path / "state")


def errors(root):
    p = os.path.join(root, "errors.log")
    return open(p).read() if os.path.exists(p) else ""


# ---- a call that works ----------------------------------------------------------------------
def test_a_call_returns_the_text_and_prices_its_usage_like_a_session_is(fake, state):
    text, eff = dsh_sidecall.call("say ok", env=fake.env)
    assert text == "ok"
    expected, how = accounting.effective(dict(USAGE, model="claude-haiku-5-5"))
    assert how == "model" and eff == expected and eff > 0
    (req,) = fake.requests
    assert (req["path"], req["auth"], req["type"]) == ("/v1/complete", "Bearer t0k3n", "application/json")
    assert req["body"] == {"prompt": "say ok", "model": None}              # the session's own route
    assert errors(state) == ""


def test_paid_model_is_passed_on_to_name_the_route(fake):
    dsh_sidecall.call("q", model="anthropic/claude-haiku-5-5", env=fake.env)
    assert fake.requests[0]["body"]["model"] == "anthropic/claude-haiku-5-5"


def test_the_session_of_the_hook_is_sent_so_the_plugin_picks_its_route(fake, monkeypatch):
    dsh_sidecall.call("q", env=dict(fake.env, TE_DSH_SESSION="session-A"))
    assert fake.requests[0]["body"] == {"prompt": "q", "model": None, "session": "session-A"}
    monkeypatch.setenv(dsh_sidecall.ENV_FILE, fake.file)                 # the process's own environment
    monkeypatch.setenv("TE_DSH_SESSION", "session-B")
    dsh_sidecall.Runner(paid_model="p/m")("q")
    assert fake.requests[1]["body"] == {"prompt": "q", "model": "p/m", "session": "session-B"}
    dsh_sidecall.call("q", env=dict(fake.env, TE_DSH_SESSION=""))        # empty is absent
    assert "session" not in fake.requests[2]["body"]


def test_a_reply_without_usage_has_text_and_no_effective_tokens(fake):
    fake.reply = (200, {"text": "ok", "model": "m"})
    assert dsh_sidecall.call("q", env=fake.env) == ("ok", None)
    fake.reply = (200, {"text": "ok", "usage": {"input_tokens": "many"}})
    assert dsh_sidecall.call("q", env=fake.env) == ("ok", None)


def test_a_model_the_price_table_does_not_know_is_still_charged(fake):
    fake.reply = (200, {"text": "ok", "usage": USAGE, "model": "some-new-model-1"})
    text, eff = dsh_sidecall.call("q", env=fake.env)
    assert text == "ok" and eff and eff > 0                              # the fallback weights, as for a session


def test_the_text_is_stripped(fake):
    fake.reply = (200, {"text": "  {\"stuck\": true}\n", "usage": USAGE})
    assert dsh_sidecall.call("q", env=fake.env)[0] == '{"stuck": true}'


# ---- no endpoint: normal outside DSH, silent ----------------------------------------------
@pytest.mark.parametrize("make", [
    lambda f: {},                                                         # not under DSH at all
    lambda f: {dsh_sidecall.ENV_FILE: f.file + ".missing"},
])
def test_without_an_endpoint_there_is_no_answer_and_no_noise(fake, state, make):
    assert dsh_sidecall.call("q", env=make(fake)) == ("", None)
    assert fake.requests == [] and errors(state) == ""


@pytest.mark.parametrize("doc", ["{ nope", "[]", "{}", '{"port": "80", "token": "x"}',
                                 '{"port": 0, "token": "x"}', '{"port": 70000, "token": "x"}',
                                 '{"port": true, "token": "x"}', '{"port": 1234, "token": ""}',
                                 '{"port": 1234, "token": 5}'])
def test_a_malformed_endpoint_file_is_no_endpoint(fake, state, doc):
    open(fake.file, "w").write(doc)
    assert dsh_sidecall.call("q", env=fake.env) == ("", None)
    assert fake.requests == [] and errors(state) == ""


def test_the_call_only_ever_goes_to_loopback(fake):
    fake.write(host="evil.example", url="http://evil.example/")          # extra fields are ignored
    dsh_sidecall.call("q", env=fake.env)
    assert dsh_sidecall.endpoint(fake.env)[0] == f"http://127.0.0.1:{fake.port}/v1/complete"
    assert fake.requests and fake.requests[0]["host"].startswith("127.0.0.1")


# ---- calls that fail: no answer, one line in errors.log, never an exception ---------------
def test_a_plugin_that_is_gone_is_no_answer_with_a_log_line(fake, state):
    fake.stop()
    assert dsh_sidecall.call("q", env=fake.env) == ("", None)
    assert "sidecall dsh: no reply" in errors(state)
    assert sidecall.paused("dsh", state) is None                          # gone is not signed out


@pytest.mark.parametrize("status,doc", [
    (500, {"error": {"code": "MODEL", "message": "boom"}}),
    (413, {"error": {"code": "TOO_LARGE", "message": "too big"}}),
    (429, {"error": {"code": "BUSY", "message": "busy"}}),
    (409, {"error": {"code": "NO_ROUTE", "message": "no model route yet"}}),   # a call before the session's route is known
    (401, {"error": {"code": "TE_AUTH", "message": "bad token"}}),          # the plugin's own door, not the provider
    (200, {"text": 5}),
    (200, {"error": {"code": "X", "message": "m"}, "text": "ignored"}),
    (200, ["not", "an", "object"]),
])
def test_an_error_reply_is_no_answer_and_does_not_pause(fake, state, status, doc):
    fake.reply = (status, doc)
    assert dsh_sidecall.call("q", env=fake.env) == ("", None)
    assert "sidecall dsh: no reply" in errors(state)
    assert sidecall.paused("dsh", state) is None


def test_a_provider_that_refuses_the_account_pauses_the_hosts_side_calls(fake, state):
    fake.reply = (502, {"error": {"code": "AUTH", "status": 401, "message": "invalid api key"}})
    assert dsh_sidecall.call("q", env=fake.env) == ("", None)
    pause = sidecall.paused("dsh", state)
    assert pause and "not signed in" in pause["reason"]
    assert sidecall.call_name("dsh") == "DSH's model service"             # what the notice names


@pytest.mark.parametrize("message", [
    "the user is not signed in", "Please run /login", "To authenticate, visit the console",
    "you are not logged in"])
def test_only_the_providers_refusal_pauses_never_a_message_that_says_so(fake, state, message):
    """The contract: pause for code AUTH (the provider's 401/403) and nothing else; what a message
    says does not matter (a model's own error text can say anything)."""
    for status, code in ((502, "MODEL"), (401, "TE_AUTH"), (504, "TIMEOUT"), (503, "NO_LLM"), (409, "NO_ROUTE")):
        fake.reply = (status, {"error": {"code": code, "message": message}})
        assert dsh_sidecall.call("q", env=fake.env) == ("", None)
        assert sidecall.paused("dsh", state) is None, code
    log = errors(state)
    assert log.count("sidecall dsh: no reply") == 5 and message in log      # each left its one line, text intact
    fake.reply = (502, {"error": {"code": "AUTH", "status": 403, "message": message}})
    assert dsh_sidecall.call("q", env=fake.env) == ("", None)
    assert sidecall.paused("dsh", state)                                    # AUTH, and only AUTH, pauses
    assert sidecall.resume("dsh", state)
    fake.reply = (502, {"error": {"code": "AUTH", "message": "no status given"}})
    dsh_sidecall.call("q", env=fake.env)
    assert sidecall.paused("dsh", state)


@pytest.mark.parametrize("prompt", [object(), b"bytes", {"a": {1, 2}}])
def test_a_prompt_that_cannot_be_serialised_is_no_answer_with_one_log_line(fake, state, prompt):
    assert dsh_sidecall.call(prompt, env=fake.env) == ("", None)           # not a TypeError
    assert fake.requests == []
    assert errors(state).count("sidecall dsh: no reply") == 1
    assert sidecall.paused("dsh", state) is None


def test_an_empty_answer_is_no_answer_but_still_costs_what_its_usage_says(fake, state):
    fake.reply = (200, {"text": "   ", "usage": USAGE, "model": "claude-haiku-5-5"})
    text, eff = dsh_sidecall.call("q", env=fake.env)
    assert text == "" and eff == accounting.effective(dict(USAGE, model="claude-haiku-5-5"))[0]
    assert "no text" in errors(state)


def test_a_call_that_never_reached_a_model_is_estimated_at_nothing(fake):
    r = dsh_sidecall.Runner(env={})                                       # not under DSH
    assert r("a long prompt " * 50) == ("", None)
    assert r.estimate_effective("a long prompt " * 50, "") == 0.0
    assert r.estimate_effective("prompt", "an answer with no usage") > 0   # a call that answered is


def test_no_route_yet_is_no_answer_that_pauses_nothing_and_charges_nothing(fake, state):
    fake.reply = (409, {"error": {"code": "NO_ROUTE", "message": "no model route known yet"}})
    runner = dsh_sidecall.Runner(env=fake.env)
    assert runner("p") == ("", None)
    assert len(fake.requests) == 1                                        # it did reach the plugin
    assert errors(state).count("sidecall dsh: no reply") == 1             # one line, no more
    assert sidecall.paused("dsh", state) is None                          # the host's side calls go on
    assert runner.estimate_effective("p", "") == 0.0                      # so a mechanism charges nothing for it
    from tokeneconomizer import pricing
    assert pricing.runner_effective_or_approx(runner, "p", "", None) == 0.0


def test_a_call_that_takes_too_long_is_no_answer(fake, state):
    fake.delay = 1.0
    t0 = time.time()
    assert dsh_sidecall.call("q", timeout=0.2, env=fake.env) == ("", None)
    assert time.time() - t0 < 0.9
    assert sidecall.paused("dsh", state) is None


def test_the_token_is_never_written_to_the_log(fake, state):
    fake.reply = (500, {"error": {"code": "MODEL", "message": "boom"}})
    dsh_sidecall.call("a prompt with SECRET text", env=fake.env)
    log = errors(state)
    assert fake.token not in log and "SECRET" not in log


# ---- the core's own users of the runner ---------------------------------------------------
@pytest.mark.real_sidecalls
def test_runner_for_dsh_is_this_call_with_paid_model(fake, monkeypatch):
    monkeypatch.setenv(dsh_sidecall.ENV_FILE, fake.file)
    cfg = type("C", (), {"paid_model": "openai/gpt-6-mini"})()
    assert sidecall.runner_for("dsh", cfg)("hello", "agent")[0] == "ok"      # callers pass a model label too
    assert fake.requests[0]["body"] == {"prompt": "hello", "model": "openai/gpt-6-mini"}
    cfg.paid_model = ""
    sidecall.runner_for("dsh", cfg)("again")
    assert fake.requests[1]["body"]["model"] is None


@pytest.mark.real_sidecalls
def test_the_judge_job_runs_on_it_and_charges_the_ledger(fake, tmp_path, monkeypatch):
    monkeypatch.setenv(dsh_sidecall.ENV_FILE, fake.file)
    repo = tmp_path / "repo"
    (repo / ".git" / "info").mkdir(parents=True)
    (repo / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
    (repo / ".git" / "config").write_text('[remote "origin"]\n\turl = https://github.com/acme/widget.git\n')
    env = {"TOKENECONOMIZER_HOME": os.environ["TOKENECONOMIZER_HOME"], "GIT_CEILING_DIRECTORIES": str(tmp_path),
           dsh_sidecall.ENV_FILE: fake.file}
    ctx = LiveContext.build(hosts.HOSTS["dsh"](), str(repo), env, settle=False)
    stuck = '{"stuck": true, "confidence": 0.9, "reason": "same failing test"}'
    fake.reply = (200, {"text": stuck, "usage": USAGE, "model": "claude-haiku-5-5"})
    aj = judge.AsyncJudge(ctx, "s1", 0.5)
    guard = type("G", (), {"turn_key": "t", "segment": 0, "judge_calls": 0})()
    job = aj.start(guard, "bash pytest -q -> FAILED x4")
    found, verdict = aj.poll(type("G", (), {"judge_pending": {"id": job}})())
    assert found and verdict["stuck"] is True and verdict["confidence"] == 0.9
    prompts = [r["body"]["prompt"] for r in fake.requests]
    assert any("bash pytest -q -> FAILED x4" in p for p in prompts)       # the judge's digest reached the model
    rec = [r for r in ctx.store.read_lines("ledger.jsonl") if r.get("kind") == "overhead"]
    assert rec and rec[0]["overhead"]["spiral_judge_tokens"] == accounting.effective(
        dict(USAGE, model="claude-haiku-5-5"))[0]
    assert rec[0]["host"] == "dsh"


@pytest.mark.real_sidecalls
def test_without_the_plugin_a_judge_job_asks_nothing_and_still_publishes_a_verdict(tmp_path):
    repo = tmp_path / "repo"
    (repo / ".git" / "info").mkdir(parents=True)
    (repo / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
    (repo / ".git" / "config").write_text('[remote "origin"]\n\turl = https://github.com/acme/widget.git\n')
    env = {"TOKENECONOMIZER_HOME": os.environ["TOKENECONOMIZER_HOME"], "GIT_CEILING_DIRECTORIES": str(tmp_path)}
    ctx = LiveContext.build(hosts.HOSTS["dsh"](), str(repo), env, settle=False)
    aj = judge.AsyncJudge(ctx, "s1", 0.5)
    guard = type("G", (), {"turn_key": "t", "segment": 0, "judge_calls": 0})()
    job = aj.start(guard, "digest")
    found, verdict = aj.poll(type("G", (), {"judge_pending": {"id": job}})())
    assert found and (verdict or {}).get("stuck") is None
    assert not [r for r in ctx.store.read_lines("ledger.jsonl") if r.get("kind") == "overhead"]
