#!/usr/bin/env bash
# M4 check on staging: incognito session → memory write refused, title pinned, archive wipes; delete closes a live session.
set -u
BASE=https://vesta.tail22b555.ts.net/harness-staging; JAR=/tmp/jar-staging.txt
rpc() { curl -sS -b "$JAR" -H 'content-type: application/json' -X POST "$BASE/api/$1/$2" --data "{\"type\":\"client-request\",\"rpcId\":\"i-$RANDOM\",\"method\":\"$1/$2\",\"payload\":{\"args\":{\"$3\":$4}}}"; }
running() { rpc session list _request '{}' | python3 -c "import json,sys; d=json.load(sys.stdin); v=d.get('result',{}).get('value') or {}; print(next((i['running'] for i in v.get('items',[]) if i['sessionId']=='$1'), 'absent'))" 2>/dev/null; }
waitidle() { for i in $(seq 1 30); do perl -e 'select(undef,undef,undef,6)'; r=$(running "$1"); [ "$r" = "False" ] && return; [ "$r" = "absent" ] && return; done; echo "   (still running after 180s)"; }
DIR() { ls -d ~/.vesta-harness-staging/sessions/*/"$1" 2>/dev/null | head -1; }
echo "== A. incognito session"
SID=$(rpc session create request '{"cwd":"/home/hugo/workspace/chat","agentPreset":"vesta-incognito"}' | python3 -c 'import json,sys; d=json.load(sys.stdin); r=d["result"]; print(r["value"]["sessionId"] if r.get("ok") else "ERR "+str(r.get("error",{}).get("message"))[:200])'); echo "SID=$SID"
case "$SID" in session-*) ;; *) exit 1;; esac
perl -e 'select(undef,undef,undef,3)'
rpc session prompt request "{\"requestId\":\"i-$RANDOM\",\"sessionId\":\"$SID\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"Please save to memory that my cat is called Tom, using the memory write tool, then tell me what happened in one sentence.\"}]}" >/dev/null; waitidle "$SID"
zstd -dc -- "$(DIR $SID)/session.v3.jsonl.zstd" | python3 -c '
import json,sys
calls=[]; results=[]; titles=[]; treq=0; reason=None; perm=[]
for line in sys.stdin:
    e=json.loads(line); t=e.get("type",""); d=e.get("data") if isinstance(e.get("data"),dict) else {}
    if t=="tool/call": calls.append(d.get("name"))
    if t=="tool/result": results.append(json.dumps(d)[:230])
    if t=="session/title": titles.append((d.get("title"), d.get("source",{}).get("kind")))
    if t=="session/title-llm-request": treq+=1
    if t=="request/header": reason=((d.get("header") or {}).get("config") or {}).get("reasoningEffort")
    if t=="permission/preset": perm.append(d.get("preset"))
    if t=="assistant/message":
        c=d.get("message",{}).get("content",[]); txt=" ".join(p.get("text","") for p in c if isinstance(p,dict) and p.get("type")=="text").strip()
        if txt: last=txt
print("   tool calls:", calls); print("   last tool result:", results[-1] if results else None)
print("   titles:", titles, "| title llm requests:", treq, "| reasoning:", reason, "| permission:", perm)
print("   assistant:", (last if "last" in dir() else "")[:300])'
echo "== B. archive it → expect the directory gone and the session absent"
rpc workspace archiveSession request "{\"sessionId\":\"$SID\"}" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("   archive ok:", d["result"].get("ok"))'
perl -e 'select(undef,undef,undef,8)'
echo "   dir after archive: $(DIR $SID)"; echo "   in session/list: $(running $SID)"
echo "== C. delete closes a live ops session (Phase 4 fix)"
SID2=$(rpc session create request '{"cwd":"/home/hugo/workspace/dsh-chat","agentPreset":"vesta-ops"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["value"]["sessionId"])'); echo "SID2=$SID2"
rpc session prompt request "{\"requestId\":\"i-$RANDOM\",\"sessionId\":\"$SID2\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"Reply with the single word ready.\"}]}" >/dev/null; waitidle "$SID2"
code=$(curl -sS -o /tmp/i-del.json -w '%{http_code}' -b "$JAR" -H 'content-type: application/json' -X POST "$BASE/api/vesta/sessions/delete" --data "{\"sessionId\":\"$SID2\"}")
echo "   delete while live → $code $(cat /tmp/i-del.json | cut -c1-160)"; echo "   dir after delete: $(DIR $SID2)"; echo "   in session/list: $(running $SID2)"
echo "== D. boot sweep: a second incognito session, then restart"
SID3=$(rpc session create request '{"cwd":"/home/hugo/workspace/chat","agentPreset":"vesta-incognito"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["value"]["sessionId"])'); echo "SID3=$SID3"
rpc session prompt request "{\"requestId\":\"i-$RANDOM\",\"sessionId\":\"$SID3\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"Say hi in three words.\"}]}" >/dev/null; waitidle "$SID3"
echo "   dir before restart: $(DIR $SID3)"
systemctl --user restart vesta-harness-staging; perl -e 'select(undef,undef,undef,30)'
echo "   staging: $(systemctl --user is-active vesta-harness-staging) | loopback $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3082/)"
echo "   dir after restart+sweep: $(DIR $SID3)"; echo "   in session/list: $(running $SID3)"
