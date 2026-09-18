#!/bin/bash
# Sync check: a vesta-batch session runs one run_code program under the new ptc-runtime (sandboxed Node process).
set -u
S=https://vesta.tail22b555.ts.net/harness-staging
J=/tmp/jar-staging.txt
H=/home/hugo/.vesta-harness-staging
uuid() { python3 -c 'import uuid;print(uuid.uuid4())'; }
rpc() { curl -s -b "$J" -H 'content-type: application/json' -X POST "$S/api/$1" -d "{\"type\":\"client-request\",\"rpcId\":\"$(uuid)\",\"method\":\"$1\",\"payload\":{\"args\":$2}}"; }
create() { rpc session/create "{\"request\":{\"cwd\":\"$2\",\"agentPreset\":\"$1\"}}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["value"]["sessionId"])'; }
prompt() { rpc session/prompt "{\"request\":{\"requestId\":\"bc-$(uuid)\",\"sessionId\":\"$1\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":$(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$2")}]}}" > /dev/null; }
inspect() {
  ssh vesta "H=$H; for i in \$(seq 1 75); do f=\$(ls \$H/sessions/*/$1/session.v3.jsonl.zstd 2>/dev/null | head -1); [ -n \"\$f\" ] && zstd -dc -- \"\$f\" | grep -q '\"turn/end\"' && break; sleep 4; done; zstd -dc -- \"\$f\" | python3 -c \"
import sys,json
ev=[json.loads(l) for l in sys.stdin if l.strip()]
hdr=[e for e in ev if e['type']=='request/header']
tools=[t.get('name') for e in hdr for t in ((e['data'].get('header') or {}).get('tools') or [])]
calls=[(e['data']['name'], e['data'].get('callId')) for e in ev if e['type']=='tool/call']
results={e['data']['message']['content'][0].get('toolCallId'): e['data']['message']['content'][0] for e in ev if e['type']=='tool/result'}
rc=[(cid, results.get(cid,{}).get('isError'), (results.get(cid,{}).get('content') or [{}])[0].get('text','')[:200].replace(chr(10),' ')) for n,cid in calls if n=='run_code']
perm=[e['data']['preset'] for e in ev if e['type']=='permission/preset']
model=[e['data'] for e in ev if e['type']=='model/selection']
am=[e for e in ev if e['type']=='assistant/message']
last=''.join(c.get('text','') for c in (am[-1]['data']['message']['content'] if am else []) if isinstance(c,dict))
te=[e['data'] for e in ev if e['type']=='turn/end']
print('header tools:', sorted(set(tools)), '| tier:', perm[-1] if perm else None, '| reasoning:', (model[-1].get('reasoningEffort') if model else None))
print('run_code calls:', len(rc), [(err, txt) for _,err,txt in rc])
print('turn end:', te[-1].get('status') if te else None, '| last assistant text:', last[:300].replace(chr(10),' '))
\""
}
echo "== Batch session under ptc-runtime-node"
sid=$(create vesta-batch /home/hugo/code/vesta-harness-staging); echo "session $sid"
prompt "$sid" "Using one run_code program, list the five largest files under packages/vesta of this repository with their sizes, then stop. Do not modify anything."
inspect "$sid"; echo "$sid" >> /tmp/sync-sessions.txt
echo "== Batch session: a program that writes and removes a scratch file in the workspace (sandbox path)"
sid=$(create vesta-batch /home/hugo/code/vesta-harness-staging); echo "session $sid"
prompt "$sid" "Using one run_code program: create a file named sync-scratch.txt in the workspace root containing the word ok, read it back, then delete it, and report each step's outcome. Then stop."
inspect "$sid"; echo "$sid" >> /tmp/sync-sessions.txt
echo "== done"
