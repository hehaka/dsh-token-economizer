"""The data behind the visual panels: `te panel [--json]`.

One JSON document holds what a panel draws -- `te status --json` unchanged, plus the series of
finished sessions from the ledger -- so a panel runs one command per refresh. The series carries
what was recorded, nothing estimated: each session's effective tokens split into the parts the
price table weights (they add up to `effective` exactly), the plugin's own overhead, the cache hit
rate, redirects, and whether facts were injected. It makes no claim about what any of it saved;
the ledger has no run without the plugin to compare with.

Without `--json` it prints the same series as a short table for a terminal.
"""
import contextlib
import io
import json
import time

from .. import pricing
from . import accounting

SCHEMA = 1
MAX_SESSIONS = 120          # newest sessions in the payload; `earlier` counts the rest
SPARK = "▁▂▃▄▅▆▇█"
PARTS = ("input", "cache_read", "cache_write", "output")


def _num(x):
    return x if isinstance(x, (int, float)) and not isinstance(x, bool) else None


def _parts(rec):
    """Effective tokens by part, on the same weights as `pricing.effective_tokens`; a row without
    a token breakdown (or a model the table cannot price) is one `total` part."""
    eff = _num(rec.get("effective_tokens"))
    if eff is None:
        return None
    if pricing.has_breakdown(rec):
        try:
            w = pricing.weights_for(rec)
        except ValueError:
            return {"total": eff}
        raw = {"input": rec.get("input_tokens"), "cache_read": rec.get("cache_read_input_tokens"),
               "cache_write": rec.get("cache_creation_input_tokens"), "output": rec.get("output_tokens")}
        return {k: round((_num(raw[k]) or 0) * w[k], 1) for k in PARTS}
    return {"total": eff}


def _overhead(rec):
    """The plugin's own token spend recorded on a row; a malformed field is no spend, not a crash."""
    oh = rec.get("overhead")
    return accounting.overhead_total(oh) if isinstance(oh, dict) else 0


def _hit_rate(rec):
    """Share of the prompt tokens that were read from the cache, or None without a breakdown."""
    if not pricing.has_breakdown(rec):
        return None
    read = _num(rec.get("cache_read_input_tokens")) or 0
    total = (_num(rec.get("input_tokens")) or 0) + read + (_num(rec.get("cache_creation_input_tokens")) or 0)
    return round(read / total, 4) if total > 0 else None


def series(records, limit=MAX_SESSIONS):
    """The plugin's own finished sessions, oldest first, newest `limit` of them. Sessions imported
    from an agent's earlier history ran without the plugin and are counted, not drawn."""
    own = [r for r in records if r.get("kind") == "session" and not r.get("imported")]
    imported = sum(1 for r in records if r.get("kind") == "session" and r.get("imported"))
    own.sort(key=lambda r: _num(r.get("started")) or _num(r.get("ended")) or 0)
    shown = own[-limit:] if limit else own
    out = []
    for r in shown:
        started, ended = _num(r.get("started")), _num(r.get("ended"))
        out.append({
            "id": str(r.get("session_id") or ""), "started": started, "ended": ended,
            "model": r.get("model") or None, "effective": _num(r.get("effective_tokens")),
            "parts": _parts(r), "overhead": _overhead(r),
            "cache_hit": _hit_rate(r), "requests": int(_num(r.get("requests")) or 0),
            "turns": int(_num(r.get("turns")) or 0), "nudges": int(_num(r.get("nudges")) or 0),
            "aborts": int(_num(r.get("aborts")) or 0), "injected": bool(r.get("injected_chars")),
            "shadow": bool(r.get("shadow"))})
    return {"sessions": out, "earlier": len(own) - len(shown), "imported": imported,
            "unattributed_overhead": sum(_overhead(r) for r in records if r.get("kind") == "overhead")}


def _status(args):
    """`te status --json` as data: the command's own output, parsed, so the two cannot disagree."""
    from . import cli
    sub = type(args)(**{**vars(args), "json": True, "explain": False})
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        cli.cmd_status(sub)
    return json.loads(buf.getvalue())


def payload(args):
    from . import cli
    ctx = cli._ctx(args)
    return {"schema": SCHEMA, "status": _status(args),
            "series": {**series(ctx.store.read_lines("ledger.jsonl")), "generated": time.time()}}


def spark(values):
    """A one-line chart; None and negative values are gaps."""
    vals = [v for v in values if v is not None and v >= 0]
    if not vals:
        return ""
    top = max(vals) or 1
    return "".join(" " if v is None or v < 0 else SPARK[min(len(SPARK) - 1, int(v / top * (len(SPARK) - 1) + 0.5))]
                   for v in values)


def cmd_panel(args):
    data = payload(args)
    if getattr(args, "json", False):
        print(json.dumps(data, separators=(",", ":"), default=str))
        return 0
    s = data["series"]["sessions"]
    print(f"TokenEconomizer -- {data['status']['repo']}: {len(s)} finished session(s)"
          + (f" (+{data['series']['earlier']} earlier)" if data["series"]["earlier"] else ""))
    if not s:
        print("  nothing folded yet: numbers appear after a session ends")
        return 0
    print(f"  effective tokens  {spark([r['effective'] for r in s][-40:])}")
    print(f"  cache hit rate    {spark([r['cache_hit'] for r in s][-40:])}")
    print(f"  {'started':16} {'effective':>10} {'overhead':>9} {'cache':>6} {'nudges':>6}  model")
    for r in s[-10:]:
        when = time.strftime("%Y-%m-%d %H:%M", time.localtime(r["started"])) if r["started"] else "-"
        hit = f"{r['cache_hit']:.0%}" if r["cache_hit"] is not None else "-"
        eff = accounting.fmt_tokens(r["effective"]) if r["effective"] is not None else "-"
        print(f"  {when:16} {eff:>10} {accounting.fmt_tokens(r['overhead']):>9} {hit:>6} "
              f"{r['nudges']:>6}  {r['model'] or '-'}{'  (facts injected)' if r['injected'] else ''}")
    return 0
