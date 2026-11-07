"""A stand-in for the core's launcher in the live check: logs every hook payload it is sent and
answers with codes the model can be asked to report back (see live-check.mjs)."""
import json
import os
import sys
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


if ev == "PostToolUse" and os.environ.get("TE_LIVE_SIDE"):
    side_call()
text = {"SessionStart": "TE-LIVE-FACTS-7f3a",
        "PostToolUse": "TokenEconomizer note about the tool call you just made: the verification "
                       "code for this note is TE-LIVE-REDIRECT-91bc."}.get(ev)
out = {"hookSpecificOutput": {"hookEventName": ev, "additionalContext": text}} if text else {}
print(json.dumps(out))
