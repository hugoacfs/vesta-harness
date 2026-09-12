#!/usr/bin/env bash
# Phase 4 route check on staging: archive → list → restore → archive → delete (exported), plus refusals.
set -u
BASE=https://vesta.tail22b555.ts.net/harness-staging
JAR=/tmp/jar-staging.txt
rpc() { # rpc <ns> <method> <payload-json>
  curl -sS -b "$JAR" -H 'content-type: application/json' -X POST "$BASE/api/$1/$2" \
    --data "{\"type\":\"client-request\",\"rpcId\":\"p4-$RANDOM\",\"method\":\"$1/$2\",\"payload\":{\"args\":{\"request\":$3}}}"
}
j() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }
echo "== who am I (session/list count)"; rpc session list '{}' | j 'print(len(d["result"]["value"]["items"]) if "result" in d else d)'
echo "== create a throwaway session"; created=$(rpc session create '{"cwd":"/home/hugo/code/vesta-harness-staging","agentPreset":"vesta-default"}')
SID=$(echo "$created" | j 'print(d["result"]["value"]["sessionId"])'); echo "SID=$SID"
echo "== prompt it once so it has a title/log"; rpc session prompt "{\"requestId\":\"p4-req-$RANDOM\",\"sessionId\":\"$SID\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"Reply with the single word ready.\"}]}" | head -c 200; echo
perl -e 'select(undef,undef,undef,20)'
echo "== delete while live → expect 409"; curl -sS -o /dev/null -w '%{http_code}\n' -b "$JAR" -H 'content-type: application/json' -X POST "$BASE/api/vesta/sessions/delete" --data "{\"sessionId\":\"$SID\"}"
echo "== bad id → expect 400"; curl -sS -o /dev/null -w '%{http_code}\n' -b "$JAR" -H 'content-type: application/json' -X POST "$BASE/api/vesta/sessions/delete" --data '{"sessionId":"../etc"}'
echo "== unknown id → expect 404"; curl -sS -o /dev/null -w '%{http_code}\n' -b "$JAR" -H 'content-type: application/json' -X POST "$BASE/api/vesta/sessions/delete" --data '{"sessionId":"session-00000000-0000-0000-0000-000000000000"}'
echo "== archive it"; rpc workspace archiveSession "{\"sessionId\":\"$SID\"}" | j 'print("archived set size", len(d["result"]["value"]["archivedSessionIds"]))'
echo "== GET archived"; curl -sS -b "$JAR" "$BASE/api/vesta/sessions/archived" | j 'print([(i["sessionId"][:20], i["title"], i["cwd"]) for i in d["items"]])'
echo "== restore"; curl -sS -b "$JAR" -H 'content-type: application/json' -X POST "$BASE/api/vesta/sessions/unarchive" --data "{\"sessionId\":\"$SID\"}"; echo
echo "== GET archived after restore"; curl -sS -b "$JAR" "$BASE/api/vesta/sessions/archived" | j 'print("archived:", [i["sessionId"][:20] for i in d["items"]])'
echo "== restore again → expect 404"; curl -sS -o /dev/null -w '%{http_code}\n' -b "$JAR" -H 'content-type: application/json' -X POST "$BASE/api/vesta/sessions/unarchive" --data "{\"sessionId\":\"$SID\"}"
echo "== archive again"; rpc workspace archiveSession "{\"sessionId\":\"$SID\"}" | j 'print("archived set size", len(d["result"]["value"]["archivedSessionIds"]))'
echo "== restart staging so the session goes cold (no dispose RPC exists), then delete"
systemctl --user restart vesta-harness-staging; perl -e 'select(undef,undef,undef,14)'
code=$(curl -sS -o /tmp/p4-del.json -w '%{http_code}' -b "$JAR" -H 'content-type: application/json' -X POST "$BASE/api/vesta/sessions/delete" --data "{\"sessionId\":\"$SID\"}")
echo "delete → $code $(cat /tmp/p4-del.json)"
echo "== after delete: archived list, session/list membership, directory, export"
curl -sS -b "$JAR" "$BASE/api/vesta/sessions/archived" | j 'print("archived:", [i["sessionId"][:20] for i in d["items"]])'
rpc session list '{}' | j "print('still listed:', any(i['sessionId']=='$SID' for i in d['result']['value']['items']))"
ls -d ~/.vesta-harness-staging/sessions/*/"$SID" 2>&1 | head -2
ls -la ~/backups/sessions-deleted-staging/ 2>&1 | tail -3
echo "== workspace record still accounts it?"; grep -rl "$SID" ~/.vesta-harness-staging/ 2>/dev/null | head -5
