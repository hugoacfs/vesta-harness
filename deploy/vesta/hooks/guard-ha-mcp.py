#!/usr/bin/env python3
"""Vesta Home Assistant guard — Claude Code style PreToolUse hook for the mounted HA MCP tools.

The bridge hands the full bridged tool name (mcp__home-assistant__<Tool>) plus
tool_input on stdin. The hook asks for human approval (hookSpecificOutput
permissionDecision "ask") when a call crosses one of the T9 thresholds:

  * locking / unlocking  — HassTurnOn/HassTurnOff targeting the lock domain, or a
                           lock/door-named entity (device_class has no "lock" member
                           in HA 2026.7.4, so name/area matching is the backstop)
  * heating on/off       — HassTurnOn/HassTurnOff on climate / water_heater / heater
                           domains, or a heater-named entity
  * irreversible         — HassBroadcast (TTS through the home's speakers),
                           HassCancelAllTimers (every pending timer)

Everything else (lights, media, remote, lists, queries) passes: exit 0, no output.

The lock/heater rules are category-based on purpose: the running HA instance has
NO lock/climate entities yet (verified 2026-09-13, 126 entities) — the rules arm
themselves the day such entities appear. Extend ASK below as the tool list grows
(HA may ship climate tools in a later release).

House style (mirrors guard-shell.py): exit 2 + stderr would deny; here we never
deny — worst case is an extra approval prompt. Fail OPEN on our own bugs:
an unreadable payload must never wedge the agent.
"""
import json
import re
import sys

PREFIX = "mcp__home-assistant__"

LOCK_RE = re.compile(r"\b(lock|door|gate|garage)\b", re.I)
HEAT_RE = re.compile(
    r"\b(climate|heater|boiler|radiator|thermostat|hvac|water[\s_-]?heater|heat)\b", re.I)
LOCK_DOMAINS = {"lock"}
HEAT_DOMAINS = {"climate", "water_heater", "heater"}


def _as_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v) for v in value if v is not None]
    return [str(value)]


def check(tool, inp):
    """Return the ask-reason for this call, or None to let it pass."""
    domains = {d.lower() for d in _as_list(inp.get("domain"))}
    text = " / ".join(str(inp.get(k)) for k in ("name", "area", "floor") if inp.get(k))
    if tool in ("HassTurnOn", "HassTurnOff"):
        if domains & LOCK_DOMAINS or LOCK_RE.search(text):
            act = "locking" if tool == "HassTurnOn" else "unlocking"
            return (f"{act} a door/gate (Home Assistant) — confirm before the "
                    f"physical lock is actuated ({text or 'domain: lock'})")
        if domains & HEAT_DOMAINS or HEAT_RE.search(text):
            act = "turning heating ON" if tool == "HassTurnOn" else "turning heating OFF"
            return f"{act} (Home Assistant) — confirm before heating changes ({text or 'domain: climate'})"
    if tool == "HassBroadcast":
        return "broadcasting a spoken message through the home's speakers — irreversible once spoken"
    if tool == "HassCancelAllTimers":
        return "cancelling ALL pending timers in the home"
    return None


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except (json.JSONDecodeError, ValueError):
        return 0
    name = payload.get("tool_name")
    if not isinstance(name, str) or not name.startswith(PREFIX):
        return 0
    # HA 2026.9 prefixes LLM tools with their domain (intent__HassTurnOn);
    # take the last __ segment so both forms keep matching.
    reason = check(name[len(PREFIX):].rsplit("__", 1)[-1], payload.get("tool_input") or {})
    if reason is None:
        return 0
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "ask",
            "permissionDecisionReason": f"vesta HA guard: {reason} — Hugo, confirm?",
        }
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
