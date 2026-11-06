"""A stand-in for the core's launcher in the live check: logs every hook payload it is sent and
answers with codes the model can be asked to report back (see live-check.mjs)."""
import json
import os
import sys

payload = json.loads(sys.stdin.read() or "{}")
with open(os.environ["TE_LIVE_LOG"], "a", encoding="utf-8") as fh:
    fh.write(json.dumps({"argv": sys.argv[1:], "payload": payload}) + "\n")
ev = payload.get("hook_event_name")
text = {"SessionStart": "TE-LIVE-FACTS-7f3a",
        "PostToolUse": "TokenEconomizer note about the tool call you just made: the verification "
                       "code for this note is TE-LIVE-REDIRECT-91bc."}.get(ev)
out = {"hookSpecificOutput": {"hookEventName": ev, "additionalContext": text}} if text else {}
print(json.dumps(out))
