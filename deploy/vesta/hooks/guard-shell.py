#!/usr/bin/env python3
"""Vesta shell guard — a Claude Code style PreToolUse hook for the harness's bash tool.

Reads the hook payload on stdin, looks at the command the model wants to run, and
denies it (exit 2, reason on stderr) when it matches a pattern that would wreck the
box or is never the agent's call to make. Everything else is allowed (exit 0).
Extend DENY below; each entry is (regex, reason). `vesta-guard-canary` is a harmless
test pattern: `echo vesta-guard-canary` must be denied.
"""
import json
import re
import sys

DENY = [
    (r"\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+(--[a-z-]+\s+)*(/|/\*|~|~/|~/\*|\$HOME|\$HOME/|\$HOME/\*|/home|/home/hugo|/home/hugo/|/srv|/srv/ai|/srv/ai/)(\s|$)",
     "recursive delete of the root, the home directory or /srv: not the agent's call — ask the user to run it"),
    (r"\bmkfs(\.[a-z0-9]+)?\b", "formatting a filesystem is never the agent's call"),
    (r"\bdd\b[^|;&]*\bof=/dev/(sd|nvme|vd|hd|mmcblk|md)", "writing raw blocks to a disk device is never the agent's call"),
    (r"(^|[;&|]\s*)(sudo\s+)?(shutdown|reboot|poweroff|halt)\b", "power actions are the user's: say that a reboot is needed instead"),
    (r":\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:", "fork bomb"),
    (r"\bchmod\s+(-R|--recursive)\s+[0-7]*7[0-7]*\s+/(\s|$)", "recursive permission change on /"),
    (r">\s*/dev/(sd|nvme|vd|hd|mmcblk)", "redirecting output onto a disk device"),
    (r"\bdocker\s+(system\s+prune|volume\s+prune|volume\s+rm)\b", "docker prune/volume removal deletes data: ask the user"),
    (r"\bgit\s+push\b[^|;&]*(--force|-f\b|\+[a-zA-Z])", "force-push: ask the user"),
    (r"\bsystemctl\s+(--user\s+)?(disable|mask)\b", "disabling or masking a unit: ask the user"),
    (r"vesta-guard-canary", "canary pattern (guard self-test)"),
]


def command_of(payload: dict) -> str:
    tool_input = payload.get("tool_input") or {}
    if isinstance(tool_input, dict):
        for key in ("command", "cmd", "script", "input"):
            value = tool_input.get(key)
            if isinstance(value, str) and value.strip():
                return value
        return json.dumps(tool_input)
    return str(tool_input)


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        return 0  # unreadable payload: never block on our own bug
    if payload.get("tool_name") not in (None, "bash", "Bash", "shell"):
        return 0
    command = command_of(payload)
    for pattern, reason in DENY:
        if re.search(pattern, command, re.IGNORECASE | re.MULTILINE):
            sys.stderr.write(f"vesta shell guard: denied — {reason}. Command: {command[:200]}\n")
            return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
