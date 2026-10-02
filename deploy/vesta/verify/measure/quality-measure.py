#!/usr/bin/env python3
"""Quality-round measurements over harness session logs (read-only). Usage: quality-measure.py <sessions-dir> [days]"""
import sys, json, glob, os, time, collections, statistics, subprocess, re
root = sys.argv[1]; days = float(sys.argv[2]) if len(sys.argv) > 2 else 14
cutoff = time.time() - days * 86400
effort = collections.Counter(); effort_by_preset = collections.Counter()
web_calls = collections.Counter(); web_errors = 0
splice_kinds = collections.Counter(); splice_chars = collections.Counter()
memory_tool_results = []
user_msg_prefix = collections.Counter()
sysprompt_sizes = []; tools_sizes = []; tool_counts = []
turn_steps = []
files = [f for f in glob.glob(os.path.join(root, "*", "*", "session.v3.jsonl.zstd")) if os.path.getmtime(f) >= cutoff]
for f in files:
    try:
        raw = subprocess.run(["zstd", "-dc", "--", f], capture_output=True, check=True).stdout.decode("utf-8", "replace")
    except Exception:
        continue
    preset = None; pending = {}; steps_in_turn = 0
    for line in raw.splitlines():
        if not line.strip(): continue
        try: e = json.loads(line)
        except Exception: continue
        t = e.get("type", ""); d = e.get("data") or {}
        if preset is None and '"agentPreset"' in line:
            i = line.find('"agentPreset":"'); preset = line[i + 15:line.find('"', i + 15)]
        if t == "request/header":
            h = d.get("header") or {}
            cfg = h.get("config") or {}
            if d.get("reason") == "initial":
                effort[str(cfg.get("reasoningEffort"))] += 1
                effort_by_preset[(preset or "(none)", str(cfg.get("reasoningEffort")))] += 1
                tools = h.get("tools") or []
                tools_sizes.append(len(json.dumps(tools))); tool_counts.append(len(tools))
        elif t == "system/message":
            m = d.get("message") or {}
            c = m.get("content"); parts = c if isinstance(c, list) else [c]
            sysprompt_sizes.append(sum(len(p.get("text", "")) if isinstance(p, dict) else len(str(p)) for p in parts))
        elif t == "tool/call":
            name = d.get("name") or (d.get("call") or {}).get("name") or ""
            cid = d.get("id") or (d.get("call") or {}).get("id")
            if name in ("web_search", "web_fetch"): web_calls[name] += 1; pending[cid] = name
            if name.startswith("mcp__memory__"): pending[cid] = name
        elif t == "tool/result":
            cid = d.get("id") or d.get("callId") or (d.get("result") or {}).get("id")
            name = pending.pop(cid, None)
            s = json.dumps(d)
            if name in ("web_search", "web_fetch") and ("error" in s.lower()[:400]): web_errors += 1
            if name and name.startswith("mcp__memory__"): memory_tool_results.append((name, len(s)))
        elif t == "agent/inbox/spliced":
            ins = d.get("inserted") or []
            for item in ins:
                s = json.dumps(item)
                txt = ""
                if isinstance(item, dict):
                    txt = item.get("text") or json.dumps(item.get("content") or item.get("message") or "")[:200]
                kind = re.sub(r"[0-9]+", "N", str(txt)[:28]).strip()
                splice_kinds[kind] += 1; splice_chars[kind] += len(s)
        elif t == "user/message":
            m = d.get("message") or d
            c = m.get("content") if isinstance(m, dict) else None
            txt = ""
            if isinstance(c, list):
                for p in c:
                    if isinstance(p, dict) and p.get("type") == "text": txt = p.get("text", ""); break
            elif isinstance(c, str): txt = c
            user_msg_prefix[re.sub(r"[0-9]+", "N", txt[:22])] += 1
        elif t == "step/start": steps_in_turn += 1
        elif t == "turn/end":
            turn_steps.append(steps_in_turn); steps_in_turn = 0
print(f"{len(files)} sessions, last {days:g} days")
print("effort at session start:", dict(effort))
print("effort by preset:", {f"{p}:{r}": n for (p, r), n in effort_by_preset.items()})
if sysprompt_sizes: print(f"system prompt chars: median {statistics.median(sysprompt_sizes):.0f}, min {min(sysprompt_sizes)}, max {max(sysprompt_sizes)} (n={len(sysprompt_sizes)})")
if tools_sizes: print(f"tool catalogue: median {statistics.median(tools_sizes):.0f} chars over {statistics.median(tool_counts):.0f} tools (min {min(tool_counts)}, max {max(tool_counts)})")
print("built-in web tool calls:", dict(web_calls), "errors:", web_errors)
mt = collections.defaultdict(list)
for n, s in memory_tool_results: mt[n].append(s)
print("memory tool results (chars median):", {n: f"{len(v)}x {statistics.median(v):.0f}" for n, v in mt.items()})
print("inbox splices (kind: count, chars):", [(k, c, splice_chars[k]) for k, c in splice_kinds.most_common(8)])
if turn_steps: print(f"steps per turn: median {statistics.median(turn_steps):.0f}, p90 {sorted(turn_steps)[int(len(turn_steps)*0.9)]}, max {max(turn_steps)} (n={len(turn_steps)})")
print("user message prefixes:", user_msg_prefix.most_common(6))
