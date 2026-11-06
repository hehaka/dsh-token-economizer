"""DeepSeek Harness (DSH), through the plugin in `plugin/dsh/` (docs/dsh/adr/0002).

DSH's own session log is a Zstandard-compressed event stream no hook script can read, and its
hook bridges (`dsh-hooks-claude-code`) send an empty `transcript_path` and no SessionEnd. So the
DSH plugin does what the Pi extension does, in DSH's own plugin API: it speaks this dispatcher's
Claude-shaped hook protocol on DSH's behalf, and keeps a small spool of the session in Pi's
session-tree format (a header line, then one `message` entry per prompt, assistant message with
its usage, and tool result). The trace seam already reads that format
(`trace.pi_session_to_claude`, `pi_prompt_count`, `pi_session_usage`), so the whole mechanism
side, the ledger included, works on a DSH session with no reader of DSH's log.

What the plugin sends, besides the Claude hook payload:

  * `prompt_id`, which it numbers itself (DSH does not stamp a turn identity on hooks);
  * `tool_response = {content, isError, exit_code}`;
  * `transcript_path`: the spool file, a Pi-format session tree;
  * `TE_DSH_MODE=headless` on the hook's environment for a run nobody watches.

Only the host's name differs from Pi's. State is kept per agent, so what a repository's DSH
sessions teach is separate from what its Pi sessions do.
"""
from . import hosts
from .hosts import Pi


class Dsh(Pi):
    name = "dsh"

    def headless(self, env, transcript=None):
        return str(env.get("TE_DSH_MODE", "")).strip() == "headless"


# Registered here, imported by `hosts` at its end, so either module can be imported first.
hosts.HOSTS["dsh"] = Dsh
