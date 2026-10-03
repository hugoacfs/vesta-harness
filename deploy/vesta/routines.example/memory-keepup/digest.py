#!/usr/bin/env python3
"""Print a condensed, redacted digest of the harness conversations since a time, for the memory keep-up routine.

Reads <home>/sessions/*/session-*/session.v3.jsonl.zstd (read-only) and prints, per session with activity
after --since, oldest first: a header (session id, mode, workspace, time span), then Hugo's messages and
Vesta's replies in order, each cut to a length, with one short line per tool call (name only). Injected
memory recall, system text, tool output, routine threads, Batch and Incognito sessions are left out.
Secret-shaped strings are replaced with [REDACTED]. Writes nothing.
usage: digest.py --home ~/.vesta-harness --since "2026-10-02 02:00" [--max-chars 60000] [--msg-chars 1500]
"""
import argparse
import datetime
import json
import pathlib
import re
import subprocess

SKIP_PRESETS = {"vesta-routine", "vesta-batch", "vesta-incognito"}
SECRET = re.compile(
    r"(sk-ant-[A-Za-z0-9_\-]{10,}|sk-(?:proj-)?[A-Za-z0-9_\-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"
    r"|hf_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9\-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_\-]{30,}|tskey-[A-Za-z0-9\-]{10,}"
    r"|eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{4,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"
    r"|\b\d{8,10}:[A-Za-z0-9_\-]{30,}\b)"
    r"|(?i:(?:password|passphrase|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*)(\S{6,})"
)


def redact(text: str) -> str:
    return SECRET.sub(lambda m: "[REDACTED]" if m.group(1) else m.group(0).replace(m.group(2), "[REDACTED]"), text)


def text_of(content) -> str:
    if not isinstance(content, list):
        return ""
    return "\n".join(part.get("text", "") for part in content if isinstance(part, dict) and part.get("type") == "text")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--home", required=True)
    ap.add_argument("--since", required=True, help="local time, YYYY-MM-DD HH:MM")
    ap.add_argument("--max-chars", type=int, default=60000)
    ap.add_argument("--msg-chars", type=int, default=1500)
    a = ap.parse_args()
    since = datetime.datetime.strptime(a.since, "%Y-%m-%d %H:%M").timestamp() * 1000
    sessions = []
    for log in pathlib.Path(a.home, "sessions").glob("*/session-*/session.v3.jsonl.zstd"):
        if log.stat().st_mtime * 1000 < since:
            continue
        raw = subprocess.run(["zstd", "-dc", "--", str(log)], capture_output=True, text=True).stdout
        events = [json.loads(line) for line in raw.splitlines() if line.strip()]
        header = events[0] if events and events[0].get("type") == "session" else {}
        if header.get("delegationDepth", 0) > 0:
            continue                    # subagent sessions: their work shows in the parent session
        preset = next((e["data"].get("agentPreset") for e in reversed(events) if e.get("type") == "agent-preset/selected"), header.get("agentPreset"))
        if preset in SKIP_PRESETS:
            continue
        lines, first, last = [], None, None
        for e in events:
            t = e.get("time") or 0
            if t < since:
                continue
            kind, data = e.get("type"), e.get("data") or {}
            if kind == "user/message" and (data.get("source") or {}).get("kind") == "user":
                body = text_of(data.get("content")).strip()
                if body:
                    lines.append("**Hugo:** " + body[:a.msg_chars].replace("\n", "\n    "))
            elif kind == "assistant/message":
                body = text_of((data.get("message") or {}).get("content")).strip()
                if body:
                    lines.append("**Vesta:** " + body[:a.msg_chars].replace("\n", "\n    "))
            elif kind == "tool/call":
                lines.append(f"[tool {data.get('name', '?')}]")
            else:
                continue
            first = first or t
            last = t
        if any(l.startswith("**Hugo:**") for l in lines):
            sessions.append((first, last, log.parent.name, preset or "?", header.get("cwd") or log.parent.parent.name, lines))
    out, used = [], 0
    for first, last, sid, preset, ws, lines in sorted(sessions):
        span = f"{datetime.datetime.fromtimestamp(first / 1000):%Y-%m-%d %H:%M}–{datetime.datetime.fromtimestamp(last / 1000):%H:%M}"
        block = redact("\n".join([f"## {sid} ({preset}, {ws}, {span})", *lines, ""]))
        if used + len(block) > a.max_chars:
            out.append(f"(digest cut at {a.max_chars} characters: {len(sessions) - len(out)} more sessions not shown; run again with a later --since to see them)")
            break
        out.append(block)
        used += len(block)
    print(f"# Conversations since {a.since}: {len(sessions)} sessions\n")
    print("\n".join(out) if out else "(no conversations since then)")


if __name__ == "__main__":
    main()
