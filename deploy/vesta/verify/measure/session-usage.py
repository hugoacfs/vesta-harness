#!/usr/bin/env python3
"""Aggregate token usage per preset across harness session logs (read-only). Usage: session-usage.py <sessions-dir> [days]"""
import sys, json, glob, os, time, collections, statistics, subprocess
root = sys.argv[1]; days = float(sys.argv[2]) if len(sys.argv) > 2 else 14
cutoff = time.time() - days * 86400
per = collections.defaultdict(lambda: {"sessions": 0, "first": [], "max": [], "input": 0, "output": 0, "steps": 0, "compactions": 0, "turns": 0, "tools": collections.Counter()})
other_types = collections.Counter()
mem_sizes = []
files = [f for f in glob.glob(os.path.join(root, "*", "*", "session.v3.jsonl.zstd")) if os.path.getmtime(f) >= cutoff]
for f in files:
    try:
        raw = subprocess.run(["zstd", "-dc", "--", f], capture_output=True, check=True).stdout.decode("utf-8", "replace")
    except Exception:
        continue
    preset = None; first = None; mx = 0; inp = 0; out = 0; steps = 0; comp = 0; turns = 0; tools = collections.Counter()
    for line in raw.splitlines():
        if not line.strip(): continue
        try: e = json.loads(line)
        except Exception: continue
        t = e.get("type", ""); d = e.get("data") or {}
        if preset is None and '"agentPreset"' in line:
            i = line.find('"agentPreset":"'); preset = line[i + 15:line.find('"', i + 15)]
        if t == "assistant/message":
            u = d.get("usage") or (d.get("message") or {}).get("usage") or {}
            it = u.get("inputTokens") or 0; ot = u.get("outputTokens") or 0
            if it:
                steps += 1; inp += it; out += ot; mx = max(mx, it)
                if first is None: first = it
        elif t == "tool/call":
            tools[(d.get("name") or (d.get("call") or {}).get("name") or "?")] += 1
        elif t in ("compaction/start", "compaction/prune"): comp += 1
        elif t == "turn/start": turns += 1
        elif "memory" in t or "recall" in t or "skill" in t or "routine" in t or "mode" in t:
            other_types[t] += 1
            if "recall" in t or "memory" in t:
                mem_sizes.append(len(json.dumps(d)))
    p = per[preset or "(none)"]
    p["sessions"] += 1; p["input"] += inp; p["output"] += out; p["steps"] += steps; p["compactions"] += comp; p["turns"] += turns
    if first: p["first"].append(first)
    if mx: p["max"].append(mx)
    p["tools"].update(tools)
print(f"{len(files)} sessions in the last {days:g} days under {root}")
print(f"{'preset':18} {'sess':>4} {'turns':>5} {'steps':>5} {'first-step in (median)':>22} {'max in (median)':>15} {'in tokens':>11} {'out':>8} {'compact':>7}")
for name, p in sorted(per.items(), key=lambda kv: -kv[1]["input"]):
    fm = statistics.median(p["first"]) if p["first"] else 0; mm = statistics.median(p["max"]) if p["max"] else 0
    print(f"{name:18} {p['sessions']:4} {p['turns']:5} {p['steps']:5} {fm:22.0f} {mm:15.0f} {p['input']:11,} {p['output']:8,} {p['compactions']:7}")
tools_all = collections.Counter()
for p in per.values(): tools_all.update(p["tools"])
print("tools:", ", ".join(f"{k} {v}" for k, v in tools_all.most_common(14)))
print("other event types:", dict(other_types.most_common(10)))
if mem_sizes: print(f"memory/recall-ish events: {len(mem_sizes)}, median {statistics.median(mem_sizes):.0f} bytes, max {max(mem_sizes)}")
