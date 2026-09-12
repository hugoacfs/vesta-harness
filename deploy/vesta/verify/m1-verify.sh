#!/usr/bin/env bash
# M1 check on staging: one session per mode; permission tier, reasoning level and tool set per preset.
set -u
BASE=https://vesta.tail22b555.ts.net/harness-staging; JAR=/tmp/jar-staging.txt
rpc() { curl -sS -b "$JAR" -H 'content-type: application/json' -X POST "$BASE/api/$1/$2" --data "{\"type\":\"client-request\",\"rpcId\":\"m-$RANDOM\",\"method\":\"$1/$2\",\"payload\":{\"args\":{\"$3\":$4}}}"; }
running() { rpc session list _request '{}' | python3 -c "import json,sys; d=json.load(sys.stdin); v=d.get('result',{}).get('value') or {}; print(next((i['running'] for i in v.get('items',[]) if i['sessionId']=='$1'), '?'))" 2>/dev/null; }
waitidle() { for i in $(seq 1 25); do perl -e 'select(undef,undef,undef,6)'; [ "$(running "$1")" = "False" ] && return; done; echo "   (still running after 150s)"; }
for preset in vesta-ops vesta-build vesta-research vesta-companion; do
  SID=$(rpc session create request "{\"cwd\":\"/home/hugo/workspace/dsh-chat\",\"agentPreset\":\"$preset\"}" | python3 -c 'import json,sys; d=json.load(sys.stdin); r=d["result"]; print(r["value"]["sessionId"] if r.get("ok") else "ERR "+str(r.get("error",{}).get("message"))[:200])')
  echo "== $preset → $SID"; case "$SID" in session-*) ;; *) continue;; esac
  perl -e 'select(undef,undef,undef,3)'
  rpc session prompt request "{\"requestId\":\"m-$RANDOM\",\"sessionId\":\"$SID\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"Reply with the single word ready.\"}]}" >/dev/null; waitidle "$SID"
  zstd -dc -- ~/.vesta-harness-staging/sessions/--home-hugo-workspace-dsh-chat--/$SID/session.v3.jsonl.zstd | python3 -c '
import json,sys,re
perm=[]; reason=None; tools=set(); preset=None
for line in sys.stdin:
    e=json.loads(line); t=e.get("type","")
    if t=="permission/preset": perm.append(json.dumps(e.get("data"))[:80])
    if t=="request/header":
        cfg=e["data"].get("header",{}).get("config",{}); reason=cfg.get("reasoningEffort")
        tools|=set(re.findall(r"\"name\":\s*\"([a-z_]+(?:__[a-z_]+)*)\"", json.dumps(e["data"])))
    if t=="session": preset=e["data"].get("header",{}).get("agentPreset") or e["data"].get("agentPreset")
marks=[x for x in ["subagent","exit_plan_mode","create_goal","todo_write","ask_user_question","session_search","mcp__pdf__pdf_add_text","schedule_create","present","bash"] if x in tools]
print("   preset in header:", preset, "| permission events:", perm, "| reasoning:", reason, "| tools:", len(tools), "| markers:", marks)'
done
