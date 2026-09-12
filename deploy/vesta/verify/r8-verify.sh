#!/bin/bash
# R8 verification against staging: thread model, hidden session, brief section, routine_note, NOTIFY, rotation, chat turn, reset, delete.
set -u
S=https://vesta.tail22b555.ts.net/harness-staging
J=/tmp/jar-staging.txt
H=/home/hugo/.vesta-harness-staging
NAME=${NAME:-r8-smoke}
api() { curl -s -b "$J" -H 'content-type: application/json' "$@"; }
step() { echo; echo "== $*"; }
py() { python3 -c "$@"; }
detail() { api "$S/api/vesta/routines/detail?name=$NAME"; }
wait_runs() { # $1 = expected run count in runs.jsonl
  local want=$1 out
  for i in $(seq 1 90); do
    out=$(detail | py 'import sys,json;d=json.load(sys.stdin);i=d["item"];print(str(i["running"]).lower(),i.get("lastOutcome"),i["runs"],len(d["runs"]))' 2>/dev/null)
    set -- $out
    if [ $# -ge 4 ] && [ "$1" = "false" ] && [ "$4" -ge "$want" ]; then echo "runs recorded: $4 (last $2)"; return 0; fi
    sleep 5
  done
  echo "TIMEOUT waiting for $want runs: $out"; return 1
}
show_last_run() { detail | py 'import sys,json;d=json.load(sys.stdin);r=d["runs"][0];i=d["item"];print("run",r["run"],r["trigger"],r["outcome"],str(r["seconds"])+"s","notified" if r["notified"] else "silent","tokens",r.get("inputTokens"));print("summary:",r["summary"]);print("session:",i.get("sessionId"));print("notes:",repr(d["notes"]))'; }

step "0 list before"
api "$S/api/vesta/routines" | py 'import sys,json;d=json.load(sys.stdin);print("dir",d["dir"],"errors",d["errors"]);[print(" -",i["name"],"|",i["scheduleText"],"|",i["permission"],"|","enabled" if i["enabled"] else "disabled","|",i["problems"]) for i in d["items"]]'

step "1 save $NAME (read-only, reasoning off, notify agent, rotateAfterRuns 3, compactAboveTokens 100)"
cat > /tmp/r8-save.json <<'JSON'
{"name":"NAME_PLACEHOLDER","title":"R8 smoke","workspace":"/home/hugo","permission":"read-only","reasoning":"off","notify":"agent","timeoutMinutes":5,"rotateAfterRuns":3,"compactAboveTokens":100,
 "brief":"Test routine. Read your notes. If they contain a line 'counter: N', call routine_note with action append and text 'counter: M' where M is N+1; if there is no counter yet, append 'counter: 1'. Do nothing else and do not read files. End with the line 'Summary: counter is now M' (the new value). If M is even, add a last line 'NOTIFY: r8 smoke counter M'."}
JSON
sed -i '' "s/NAME_PLACEHOLDER/$NAME/" /tmp/r8-save.json
api -X POST "$S/api/vesta/routines/save" -d @/tmp/r8-save.json | py 'import sys,json;d=json.load(sys.stdin);print("errors" if "errors" in d else "saved", d.get("errors", d.get("item",{}).get("name")))'
ssh vesta "cat $H/routines/$NAME/routine.yaml | head -12"

step "2 run 1 (manual)"
api -X POST "$S/api/vesta/routines/run" -d "{\"name\":\"$NAME\"}"; echo
wait_runs 1 && show_last_run
SID=$(detail | py 'import sys,json;print(json.load(sys.stdin)["item"].get("sessionId",""))')
echo "thread: $SID"

step "3 hidden: archived set has the thread, the Archived panel route does not"
ssh vesta "python3 -c \"import json;d=json.load(open('$H/storages/workspace.json'));print('archived on server:', '$SID' in d['global']['archivedSessionIds'])\""
api "$S/api/vesta/sessions/archived" | py "import sys,json;d=json.load(sys.stdin);print('in Archived panel:', any(i['sessionId']=='$SID' for i in d['items']))"

step "4 session log: brief section, routine_note tool, tier, our request id, turn"
ssh vesta "f=\$(ls $H/sessions/*/$SID/session.v3.jsonl.zstd 2>/dev/null | head -1); zstd -dc -- \"\$f\" > /tmp/r8-log.jsonl; python3 - <<'PY'
import json
ev=[json.loads(l) for l in open('/tmp/r8-log.jsonl') if l.strip()]
types=[e['type'] for e in ev]
sysmsg=[e for e in ev if e['type']=='system/message']
brief=any('Routine: R8 smoke' in json.dumps(e) for e in sysmsg)
hdr=[e for e in ev if e['type']=='request/header']
tools=set()
for e in hdr:
    for t in e.get('data',{}).get('tools',[]) or []:
        tools.add(t.get('name') if isinstance(t,dict) else str(t))
perm=[e['data'] for e in ev if e['type']=='permission/preset']
um=[e for e in ev if e['type']=='user/message']
rpc=[e['data'].get('source',{}).get('rpcId','') for e in um]
titles=[e['data'] for e in ev if e['type']=='session/title']
print('events',len(ev),'| brief section in system/message:',brief,'| routine_note in tools:','routine_note' in tools,'| session_event_search:','session_event_search' in tools)
print('permission/preset:',perm[-1] if perm else None,'| title:',titles[-1] if titles else None)
print('user/message sources:',[ (e['data'].get('source',{}).get('kind'), e['data'].get('source',{}).get('plugin','')) for e in um])
print('our rpcId present:',any(r.startswith('routine-') for r in rpc),'| turns:',types.count('turn/start'),'| compaction/end:',types.count('compaction/end'))
tc=[c for e in ev if e['type']=='assistant/message' for c in e['data']['message'].get('content',[]) if c.get('type')=='tool_call' or c.get('type')=='tool_use']
print('tool calls:',[ (c.get('name') or c.get('tool')) for c in tc])
PY"

step "5 run 2 → NOTIFY (counter 2) and compaction (compactAboveTokens 100)"
api -X POST "$S/api/vesta/routines/run" -d "{\"name\":\"$NAME\"}"; echo
wait_runs 2 && show_last_run
sleep 20
ssh vesta "f=\$(ls $H/sessions/*/$SID/session.v3.jsonl.zstd 2>/dev/null | head -1); zstd -dc -- \"\$f\" | python3 -c \"
import sys,json
ev=[json.loads(l) for l in sys.stdin if l.strip()]
t=[e['type'] for e in ev]
print('compaction/start',t.count('compaction/start'),'compaction/end',t.count('compaction/end'),'command/run',[e['data'].get('name') for e in ev if e['type']=='command/run'],'command/done',[e['data'].get('text','')[:80] for e in ev if e['type']=='command/done'])
\""
detail | py 'import sys,json;d=json.load(sys.stdin);print("lastCompaction:",(d["thread"].get("lastCompaction") or "")[:200])'

step "6 run 3 → rotation after 3 runs"
api -X POST "$S/api/vesta/routines/run" -d "{\"name\":\"$NAME\"}"; echo
wait_runs 3 && show_last_run
detail | py 'import sys,json;d=json.load(sys.stdin);t=d["thread"];print("rotations:",len(t["rotations"]),[ (r["reason"], r["runs"]) for r in t["rotations"]]);print("thread sessionId now:",t.get("sessionId"))'
ssh vesta "ls -la $H/routines/$NAME/archive/ 2>/dev/null; ls -d $H/sessions/*/$SID 2>/dev/null || echo 'old session dir gone'"

step "7 run 4 → fresh thread with handover"
api -X POST "$S/api/vesta/routines/run" -d "{\"name\":\"$NAME\"}"; echo
wait_runs 4 && show_last_run
SID2=$(detail | py 'import sys,json;print(json.load(sys.stdin)["item"].get("sessionId",""))')
echo "new thread: $SID2 (old $SID)"
ssh vesta "f=\$(ls $H/sessions/*/$SID2/session.v3.jsonl.zstd 2>/dev/null | head -1); zstd -dc -- \"\$f\" | python3 -c \"
import sys,json
ev=[json.loads(l) for l in sys.stdin if l.strip()]
um=[e for e in ev if e['type']=='user/message' and e['data'].get('source',{}).get('kind')=='user']
txt=' '.join(c.get('text','') for c in um[0]['data']['content']) if um else ''
print('handover in run message:','history rotation' in txt, '| notes carried:', 'counter: 3' in txt)
\""

step "8 pause / resume"
api -X POST "$S/api/vesta/routines/pause" -d "{\"name\":\"$NAME\",\"paused\":true}"; echo
detail | py 'import sys,json;d=json.load(sys.stdin);i=d["item"];print("paused:",i["paused"],"nextRun:",i.get("nextRun"))'
api -X POST "$S/api/vesta/routines/pause" -d "{\"name\":\"$NAME\",\"paused\":false}"; echo

step "9 chat turn in the thread (passive run, no notify)"
RID=$(py 'import uuid;print(uuid.uuid4())')
curl -s -b "$J" -H 'content-type: application/json' -X POST "$S/api/session/prompt" -d "{\"type\":\"client-request\",\"rpcId\":\"$RID\",\"method\":\"session/prompt\",\"payload\":{\"args\":{\"request\":{\"requestId\":\"chat-$RID\",\"sessionId\":\"$SID2\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"Hugo here, chatting in your thread: call session_event_search on this session for the word counter with surfaces current and shadowed, then answer in one line: how many hits, and what is the counter now? No NOTIFY line.\"}]}}}}" | head -c 200; echo
wait_runs 5 && show_last_run
detail | py 'import sys,json;d=json.load(sys.stdin);r=d["runs"][0];print("chat run trigger:",r["trigger"],"notified:",r["notified"])'

step "10 reset → second rotation"
api -X POST "$S/api/vesta/routines/reset" -d "{\"name\":\"$NAME\"}"; echo
detail | py 'import sys,json;d=json.load(sys.stdin);t=d["thread"];print("rotations:",len(t["rotations"]),"sessionId:",t.get("sessionId"))'

step "11 delete → export"
api -X POST "$S/api/vesta/routines/delete" -d "{\"name\":\"$NAME\"}"; echo
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$J" "$S/api/vesta/routines/detail?name=$NAME"); echo "detail after delete: $code"
ssh vesta "ls -la ~/backups/routines-deleted/ | tail -2; ls $H/routines/; ls -d $H/sessions/*/$SID2 2>/dev/null || echo 'thread dir gone'"
echo; echo "== done"
