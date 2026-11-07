"""A stand-in for the core's launcher in the live check: logs every hook payload it is sent and
answers with codes the model can be asked to report back (see live-check.mjs).

Two side-call modes (PostToolUse; in runner mode also Stop and SessionEnd), both appending JSON lines to TE_LIVE_SIDE:
  TE_LIVE_SIDE alone      a raw POST to the plugin's endpoint (live-check.mjs);
  TE_LIVE_RUNNER=1        the core's real `sidecall.runner_for("dsh", cfg)` for each paid-model variant
                          in TE_LIVE_PAID (a JSON list, "" = no paid_model), with the endpoint's raw
                          reply captured (live-sidecall.mjs); each hook process claims at most ONE
                          variant (marker `<TE_LIVE_SIDE>.claim.<index>`). TE_LIVE_REPO is the checkout root."""
import io
import json
import os
import sys
import urllib.error
import urllib.request

payload = json.loads(sys.stdin.read() or "{}")
with open(os.environ["TE_LIVE_LOG"], "a", encoding="utf-8") as fh:
    fh.write(json.dumps({"argv": sys.argv[1:], "payload": payload}) + "\n")
ev = payload.get("hook_event_name")


def side_call():
    """What the core's judge does: one prompt to the plugin's endpoint, on the session's route."""
    out = {"endpoint_env": bool(os.environ.get("TE_DSH_SIDECALL_FILE"))}
    try:
        with open(os.environ["TE_DSH_SIDECALL_FILE"], encoding="utf-8") as fh:
            ep = json.load(fh)
        req = urllib.request.Request(
            f"http://127.0.0.1:{ep['port']}/v1/complete", method="POST",
            data=json.dumps({"prompt": "Reply with the single word: pong", "maxTokens": 64}).encode(),
            headers={"Authorization": f"Bearer {ep['token']}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as resp:
            out["reply"] = json.loads(resp.read().decode())
    except Exception as e:                                  # a failed call is a finding, not a crash
        body = getattr(e, "read", lambda: b"")()
        out["error"] = f"{type(e).__name__}: {e} {body[:300]!r}"
    with open(os.environ["TE_LIVE_SIDE"], "a", encoding="utf-8") as fh:
        fh.write(json.dumps(out) + "\n")


class _Body:
    """A stand-in for the response `urlopen` returned, once its body has been read for us."""

    def __init__(self, data):
        self._data = data

    def read(self, *_):
        return self._data

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class _Cfg:
    def __init__(self, paid_model):
        self.paid_model = paid_model


def _claim(suffix, kind="claim"):
    """Atomically take one marker file next to TE_LIVE_SIDE; False when another process has it."""
    try:
        fd = os.open(os.environ["TE_LIVE_SIDE"] + "." + kind + "." + suffix, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return False
    os.close(fd)
    return True


def _setup_row(error):
    if _claim("setup"):                                     # one setup row, however many hooks fail
        with open(os.environ["TE_LIVE_SIDE"], "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"variant": None, "text": "", "effective": None, "reply": None,
                                 "error": f"setup: {error}"}) + "\n")


def _run_one(sidecall, dsh_sidecall, variant, prompt):
    """One call through the core's real runner, the endpoint's raw reply kept beside what it returns:
    `({text, effective, reply[, error]}, runner)`. A failed call is a finding, not a crash."""
    row = {"text": "", "effective": None, "reply": None}
    captured = []
    real = dsh_sidecall.urllib.request.urlopen              # the one `dsh_sidecall.call` uses

    def spy(*a, **kw):
        try:
            with real(*a, **kw) as resp:
                data = resp.read()
        except urllib.error.HTTPError as e:               # keep the endpoint's error body readable
            data = e.read()
            captured.append(data)
            raise urllib.error.HTTPError(e.url, e.code, e.msg, e.hdrs, io.BytesIO(data))
        captured.append(data)
        return _Body(data)

    runner = None
    dsh_sidecall.urllib.request.urlopen = spy
    try:
        runner = sidecall.runner_for("dsh", _Cfg(variant))
        row["text"], row["effective"] = runner(prompt)
    except BaseException as e:                            # a failed call is a finding, not a crash
        row["error"] = f"{type(e).__name__}: {e}"
    finally:
        dsh_sidecall.urllib.request.urlopen = real
    if captured:
        try:
            row["reply"] = json.loads(captured[-1].decode("utf-8"))
        except Exception:
            row["error"] = (row.get("error", "") + f" unparsable reply {captured[-1][:200]!r}").strip()
    if row["reply"] is None and "error" not in row:
        row["error"] = "no reply captured from the endpoint"
    return row, runner


def runner_calls():
    """The core's runner for ONE variant; the endpoint's raw reply kept beside what it returns.
    A hook process claims at most one unclaimed variant of TE_LIVE_PAID (the DSH hook limit is 20 s,
    so a slow model must not hold several calls in one process); when all are claimed it does nothing."""
    try:
        variants = json.loads(os.environ.get("TE_LIVE_PAID") or '[""]')
        index = next((i for i in range(len(variants)) if _claim(str(i))), None)
        if index is None:
            return
        variants = [variants[index]]
        sys.path.insert(0, os.environ["TE_LIVE_REPO"])
        from tokeneconomizer.plugin import sidecall
        from tokeneconomizer.plugin import dsh_sidecall
    except Exception as e:
        _setup_row(f"{type(e).__name__}: {e}")
        return
    for variant in variants:
        row, _runner = _run_one(sidecall, dsh_sidecall, variant, "Reply with the single word: pong")
        row = dict({"variant": variant}, **row)
        with open(os.environ["TE_LIVE_SIDE"], "a", encoding="utf-8") as fh:   # at once: a hook has 20 s
            fh.write(json.dumps(row) + "\n")


ROUTE_HOOKS = ("SessionStart", "UserPromptSubmit", "PostToolUse")


def route_call(hook):
    """TE_LIVE_ROUTE: the real runner on the session's own route, once per hook name per run; the row
    says what came back and what a mechanism would charge for it (`pricing.runner_effective_or_approx`).
    `endpoint_file` is the TE_DSH_SIDECALL_FILE this hook process was given (None when it had none), so a
    script running several dsh processes at once can tell whose endpoint each row went to."""
    prompt = "Reply with the single word: pong"
    row = {"phase": hook, "text": "", "effective": None, "charge": 0, "reply": None,
           "endpoint_file": os.environ.get("TE_DSH_SIDECALL_FILE")}
    if not _claim(hook, "route"):
        return
    try:
        sys.path.insert(0, os.environ["TE_LIVE_REPO"])
        from tokeneconomizer import pricing
        from tokeneconomizer.plugin import dsh_sidecall, sidecall
        got, runner = _run_one(sidecall, dsh_sidecall, "", prompt)
        row.update(got)
        if runner is not None:
            row["charge"] = pricing.runner_effective_or_approx(runner, prompt, row["text"], row["effective"])
    except BaseException as e:                            # a failed call is a finding, not a crash
        row["error"] = f"setup: {type(e).__name__}: {e}"
    with open(os.environ["TE_LIVE_SIDE"], "a", encoding="utf-8") as fh:       # at once: a hook has 20 s
        fh.write(json.dumps(row) + "\n")


if ev in ROUTE_HOOKS and os.environ.get("TE_LIVE_ROUTE") == "1" and os.environ.get("TE_LIVE_SIDE"):
    try:
        route_call(ev)
    except BaseException as e:                            # never raise out of the hook
        print(f"stub_core route: {type(e).__name__}: {e}", file=sys.stderr)
elif ev in ("PostToolUse", "Stop", "SessionEnd") and os.environ.get("TE_LIVE_RUNNER") == "1" and os.environ.get("TE_LIVE_SIDE"):
    try:
        runner_calls()
    except BaseException as e:                            # never raise out of the hook
        print(f"stub_core runner: {type(e).__name__}: {e}", file=sys.stderr)
elif ev == "PostToolUse" and os.environ.get("TE_LIVE_SIDE"):
    side_call()
text = {"SessionStart": "TE-LIVE-FACTS-7f3a",
        "PostToolUse": "TokenEconomizer note about the tool call you just made: the verification "
                       "code for this note is TE-LIVE-REDIRECT-91bc."}.get(ev)
out = {"hookSpecificOutput": {"hookEventName": ev, "additionalContext": text}} if text else {}
print(json.dumps(out))
