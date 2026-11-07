"""Side calls on DeepSeek Harness: the plugin's own model calls (the loop guard's judge and
nudge writer, the micro-skills proposer) go through DSH's model service, not through another
agent's CLI (docs/dsh/adr/0004).

The DSH plugin (`plugin/dsh/src/sidecall.mjs`) answers on a loopback port, authenticated by a
token, and says where in a small endpoint file whose path it puts in `TE_DSH_SIDECALL_FILE` on
every hook's environment (so the detached jobs a hook starts inherit it). A call is one request
with no session history: the prompt in, the model's text and its token usage out. The call runs on
the route the plugin names: the provider and model of the session `TE_DSH_SESSION` names (sent as
`session`; the hook's environment carries it, so several sessions in one DSH process each run on
their own), or `paid_model` (`provider/model`, or just a model of the session's provider). What it cost is priced like any session's usage and
charged to the ledger by the caller, as for every other host.

Nothing here raises: a call that cannot be made (not running under DSH, the plugin gone, a model
that answers nothing) returns `("", None)`, which every caller already treats as "no answer"; the
cause is one line in `errors.log`. A model route that refuses the account (HTTP 401/403 from the
provider, code AUTH) pauses the host's side calls, as another agent's CLI saying it is not signed in
does; no other reply does, whatever its message says.
"""
import json
import os
import urllib.error
import urllib.request

from . import accounting, sidecall

ENV_FILE = "TE_DSH_SIDECALL_FILE"
ENV_SESSION = "TE_DSH_SESSION"          # the session the hook runs for: names the route to use
MAX_REPLY_BYTES = 1_000_000
HOST = "127.0.0.1"


class _Out:
    """What `sidecall._no_reply` reads of a finished call (only for the one reply that pauses)."""

    def __init__(self, message, returncode):
        self.stderr, self.stdout, self.returncode = message, "", returncode


def _note(message, returncode):
    """The one `errors.log` line of a call without an answer, as `sidecall._no_reply` writes it, but
    with no pause: `_no_reply` pauses on what the text says ("not signed in"), and here only the
    provider's refusal (code AUTH) may."""
    import time
    from .paths import state_root
    tail = " ".join(str(message).split())[-300:]
    try:
        root = state_root()
        os.makedirs(root, exist_ok=True)
        with open(os.path.join(root, "errors.log"), "a", encoding="utf-8") as fh:
            fh.write(f"--- {time.strftime('%Y-%m-%dT%H:%M:%S')} sidecall dsh: no reply "
                     f"(exit {returncode}) {tail}\n")
    except OSError:
        pass


def endpoint(env=None):
    """(url, token) the DSH plugin answers on, or None when this process is not under one."""
    path = (env if env is not None else os.environ).get(ENV_FILE)
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
        port, token = doc["port"], doc["token"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if not isinstance(port, int) or isinstance(port, bool) or not 0 < port < 65536:
        return None
    if not isinstance(token, str) or not token:
        return None
    return f"http://{HOST}:{port}/v1/complete", token


def _usage(raw, model):
    """The ledger's usage fields from the plugin's, or None when the call reported none."""
    if not isinstance(raw, dict):
        return None
    keys = ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens",
            "output_tokens")
    if not all(isinstance(raw.get(k, 0), (int, float)) for k in keys) \
            or not isinstance(raw.get("input_tokens"), (int, float)):
        return None
    return dict({k: raw.get(k) or 0 for k in keys}, model=model)


def call(prompt, model="", timeout=sidecall.TIMEOUT_S, env=None):
    """`(text, effective_tokens)` of one model call through the DSH plugin, `("", None)` when
    there is no answer. `model` is `paid_model`: empty for the session's own route."""
    target = endpoint(env)
    if target is None:
        return "", None
    url, token = target
    try:
        payload = {"prompt": prompt, "model": model or None}
        session = (env if env is not None else os.environ).get(ENV_SESSION)
        if session:                                     # names the route: this hook's own session
            payload["session"] = session
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=body, method="POST", headers={
            "Content-Type": "application/json", "Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:      # noqa: S310 (loopback)
            doc = json.loads(resp.read(MAX_REPLY_BYTES + 1)[:MAX_REPLY_BYTES].decode("utf-8"))
    except urllib.error.HTTPError as e:
        doc = _error_body(e)
    except (OSError, ValueError, TypeError) as e:       # unserialisable prompt, refused (the plugin is gone), timed out
        _note(f"{type(e).__name__}: {e}", -1)
        return "", None
    if not isinstance(doc, dict) or doc.get("error") or not isinstance(doc.get("text"), str):
        err = (doc or {}).get("error") if isinstance(doc, dict) else None
        err = err if isinstance(err, dict) else {}
        message = str(err.get("message") or "no text in the reply")[:300]
        if err.get("code") == "AUTH":                   # the provider refused the account: the one reply that pauses
            sidecall._no_reply("dsh", _Out(f"not signed in: {message}", err.get("status") or -1))
        else:                                           # what a message says never pauses (a model's text can say anything)
            _note(message, err.get("status") or -1)
        return "", None
    usage = _usage(doc.get("usage"), str(doc.get("model") or model or "dsh"))
    eff = accounting.effective(usage)[0] if usage else None
    text = doc["text"].strip()
    if not text:
        _note("the model answered with no text", 0)
    return text, eff                    # an empty answer still cost what its usage says


def _error_body(e):
    try:
        doc = json.loads(e.read(MAX_REPLY_BYTES).decode("utf-8"))
        return doc if isinstance(doc, dict) else {"error": {"message": f"HTTP {e.code}"}}
    except (OSError, ValueError):
        return {"error": {"message": f"HTTP {e.code}", "status": e.code}}


class Runner:
    """`runner(prompt, model) -> (text, effective_tokens)`, as the mechanisms call it, for this host.

    `estimate_effective` is what a mechanism charges when a call gave no usage. Left to its default
    it would charge a prompt that never reached a model (the plugin gone, say): here only a call
    that answered is estimated."""

    def __init__(self, paid_model="", env=None):
        self.paid_model, self.env = paid_model or "", env

    def __call__(self, prompt, _model="agent"):
        return call(prompt, model=self.paid_model, env=self.env)

    @staticmethod
    def estimate_effective(prompt, raw):
        from ..pricing import approx_tokens
        return approx_tokens(prompt) + 5 * approx_tokens(raw) if raw else 0.0
