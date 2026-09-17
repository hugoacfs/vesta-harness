#!/bin/bash
# T13 verification on staging: capture after idle turns, recall before a prompt, dedupe, incognito exclusion, /memory, cleanup.
# The memory store is shared with production, so every test fact is marked t13test and deleted at the end.
set -u
S=https://vesta.tail22b555.ts.net/harness-staging
J=/tmp/jar-staging.txt
H=/home/hugo/.vesta-harness-staging
CWD=/home/hugo/workspace/dsh-chat
uuid() { python3 -c 'import uuid;print(uuid.uuid4())'; }
rpc() { curl -s -b "$J" -H 'content-type: application/json' -X POST "$S/api/$1" -d "{\"type\":\"client-request\",\"rpcId\":\"$(uuid)\",\"method\":\"$1\",\"payload\":{\"args\":$2}}"; }
create() { rpc session/create "{\"request\":{\"cwd\":\"$CWD\",\"agentPreset\":\"$1\"}}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["value"]["sessionId"])'; }
say() { # sid text → waits for that turn to end
  local before; before=$(turns "$1")
  rpc session/prompt "{\"request\":{\"requestId\":\"t13-$(uuid)\",\"sessionId\":\"$1\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":$(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$2")}]}}" >/dev/null
  for i in $(seq 1 60); do [ "$(turns "$1")" -gt "$before" ] && return 0; sleep 3; done; echo "  (turn did not end in time)"
}
turns() { ssh vesta "f=\$(ls $H/sessions/*/$1/session.v3.jsonl.zstd 2>/dev/null | head -1); if [ -n \"\$f\" ]; then zstd -dc -- \"\$f\" | grep -c '\"turn/end\"'; else echo 0; fi" | tail -1 | tr -dc '0-9'; }
logfor() { ssh vesta "grep '\"session\":\"$1\"' $H/memory-notes.log.jsonl 2>/dev/null" | python3 -c 'import sys,json;[print("   ", (lambda d: f"{d.get(chr(97)+chr(99)+chr(116)+chr(105)+chr(111)+chr(110))} {d.get(chr(110)+chr(97)+chr(109)+chr(101),chr(45))} conf={d.get(chr(99)+chr(111)+chr(110)+chr(102)+chr(105)+chr(100)+chr(101)+chr(110)+chr(99)+chr(101),chr(45))} {d.get(chr(100)+chr(101)+chr(116)+chr(97)+chr(105)+chr(108),chr(32))}")(json.loads(l))) for l in sys.stdin if l.strip()]'; }
recall_of() { ssh vesta "f=\$(ls $H/sessions/*/$1/session.v3.jsonl.zstd | head -1); zstd -dc -- \"\$f\" | python3 -c \"
import sys,json
ev=[json.loads(l) for l in sys.stdin if l.strip()]
sysmsg=' '.join(json.dumps(e['data']) for e in ev if e['type']=='system/message')
i=sysmsg.find('Memory notes that may apply')
print('recall section present:', i!=-1)
if i!=-1: print('  ', sysmsg[i:i+500].replace(chr(92)+'n',' '))
am=[e for e in ev if e['type']=='assistant/message']
text=''
for e in am:
    for c in e['data']['message'].get('content',[]):
        if c.get('type')=='text' and c['text'].strip(): text=c['text'].strip()
print('answer:', text[-200:].replace(chr(10),' '))
\""; }
echo "== A. Ops session, two durable statements + two fillers, then idle capture"
A=$(create vesta-ops); echo "session $A"; echo "$A" >> /tmp/t12-sessions.txt
say "$A" "Note for the future: when you make a backup copy of one of my config files, name it with the suffix .bak-t13test instead of .orig. That is my preference from now on. Just acknowledge in one line."
say "$A" "Also for your memory: my test-lab printer is called Bramble and it lives in the study. It is a t13 test fact, but treat it as real. One line back."
say "$A" "Thanks. What is 2 + 2? One word."
say "$A" "And the capital of France? One word."
echo "  waiting for the idle capture (idleSeconds 30 + the model call)…"; sleep 75
echo "  log entries for A:"; logfor "$A"
echo "  store search (t13test / bramble):"; ssh vesta 'curl -s -m 10 -X POST http://127.0.0.1:7332/mcp -H "content-type: application/json" -H "accept: application/json, text/event-stream" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"probe\",\"version\":\"0\"}}}" -D /tmp/mh.txt -o /dev/null; sid=$(grep -i "mcp-session-id" /tmp/mh.txt | awk "{print \$2}" | tr -d "\r"); for q in "backup copy suffix bak-t13test" "printer Bramble study"; do curl -s -m 10 -X POST http://127.0.0.1:7332/mcp -H "content-type: application/json" -H "accept: application/json, text/event-stream" ${sid:+-H "mcp-session-id: $sid"} -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"memory_search\",\"arguments\":{\"query\":\"$q\",\"limit\":2}}}" | sed "s/^data: //" | grep "^{" | tail -1 | python3 -c "import sys,json;d=json.load(sys.stdin);t=d.get(\"result\",{}).get(\"content\",[{}])[0].get(\"text\",\"\");print(\"    \", t[:300].replace(chr(10),\" \"))"; done; rm -f /tmp/mh.txt'
echo; echo "== B. New Ops session: recall of the preference before the prompt"
B=$(create vesta-ops); echo "session $B"; echo "$B" >> /tmp/t12-sessions.txt
say "$B" "Quick check from memory: when you make a backup copy of one of my config files, what suffix should it get? One line, no tools."
recall_of "$B"
echo; echo "== C. Same statements again in a third session: expect updates, not duplicates"
C=$(create vesta-ops); echo "session $C"; echo "$C" >> /tmp/t12-sessions.txt
say "$C" "Reminder of my preference: backup copies of my config files get the suffix .bak-t13test, never .orig. One line back."
say "$C" "And my test-lab printer Bramble is in the study, remember. One line."
say "$C" "What is 3 + 3? One word."
say "$C" "Colour of the sky on a clear day? One word."
echo "  waiting for the idle capture…"; sleep 75
echo "  log entries for C:"; logfor "$C"
echo; echo "== D. Incognito session with a fact: no capture"
D=$(create vesta-incognito); echo "session $D"; echo "$D" >> /tmp/t12-sessions.txt
say "$D" "My secret hobby is t13test origami; remember it. One line."
say "$D" "What is 5 + 5? One word."
say "$D" "What is 6 + 6? One word."
say "$D" "What is 7 + 7? One word."
sleep 60; echo "  log entries for D (expect none):"; logfor "$D"
echo; echo "== E. /memory status in B, then cleanup of the test notes"
rpc commands/execute "{\"agentId\":\"$B\",\"line\":\"/memory\",\"submittedAttachments\":[]}" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("/memory →", str(d.get("result",{}).get("value",{}).get("result",{}).get("text"))[:400])'
ssh vesta 'init() { curl -s -m 10 -X POST http://127.0.0.1:7332/mcp -H "content-type: application/json" -H "accept: application/json, text/event-stream" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"probe\",\"version\":\"0\"}}}" -D /tmp/mh.txt -o /dev/null; grep -i "mcp-session-id" /tmp/mh.txt | awk "{print \$2}" | tr -d "\r"; }; sid=$(init); call() { curl -s -m 15 -X POST http://127.0.0.1:7332/mcp -H "content-type: application/json" -H "accept: application/json, text/event-stream" ${sid:+-H "mcp-session-id: $sid"} -d "$1" | sed "s/^data: //" | grep "^{" | tail -1; }; names=$(call "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"memory_list\",\"arguments\":{}}}" | python3 -c "
import sys,json
d=json.load(sys.stdin); t=d.get(\"result\",{}).get(\"content\",[{}])[0].get(\"text\",\"{}\")
try: notes=json.loads(t).get(\"notes\",[])
except Exception: notes=[]
for n in notes:
    blob=(n.get(\"name\",\"\")+\" \"+n.get(\"description\",\"\")).lower()
    if \"t13\" in blob or \"bramble\" in blob: print(n[\"name\"])
"); echo "  test notes in the store: ${names:-none}"; for n in $names; do call "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"memory_delete\",\"arguments\":{\"name\":\"$n\"}}}" | grep -o "\"deleted\": *true" | sed "s/^/  $n /"; done; rm -f /tmp/mh.txt'
echo "== done"
