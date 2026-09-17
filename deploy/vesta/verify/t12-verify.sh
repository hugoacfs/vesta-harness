#!/bin/bash
# T12 verification on staging: Build sees run_code + the SDK section; a read-only session's run_code is refused by the tier guard.
set -u
S=https://vesta.tail22b555.ts.net/harness-staging
J=/tmp/jar-staging.txt
H=/home/hugo/.vesta-harness-staging
uuid() { python3 -c 'import uuid;print(uuid.uuid4())'; }
rpc() { curl -s -b "$J" -H 'content-type: application/json' -X POST "$S/api/$1" -d "{\"type\":\"client-request\",\"rpcId\":\"$(uuid)\",\"method\":\"$1\",\"payload\":{\"args\":$2}}"; }
create() { rpc session/create "{\"request\":{\"cwd\":\"$2\",\"agentPreset\":\"$1\"}}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["value"]["sessionId"])'; }
prompt() { rpc session/prompt "{\"request\":{\"requestId\":\"t12v-$(uuid)\",\"sessionId\":\"$1\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":$(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$2")}]}}" >/dev/null; }
inspect() { # sid → header facts + run_code outcomes
  ssh vesta "H=$H; for i in \$(seq 1 60); do f=\$(ls \$H/sessions/*/$1/session.v3.jsonl.zstd 2>/dev/null | head -1); [ -n \"\$f\" ] && zstd -dc -- \"\$f\" | grep -q '\"turn/end\"' && break; sleep 4; done; zstd -dc -- \"\$f\" | python3 -c \"
import sys,json
ev=[json.loads(l) for l in sys.stdin if l.strip()]
hdr=[e for e in ev if e['type']=='request/header']
tools=[t.get('name') for e in hdr for t in ((e['data'].get('header') or {}).get('tools') or [])]
sysmsg=' '.join(json.dumps(e['data']) for e in ev if e['type']=='system/message')
calls=[(e['data']['name'], e['data'].get('callId')) for e in ev if e['type']=='tool/call']
results={e['data']['message']['content'][0].get('toolCallId'): e['data']['message']['content'][0] for e in ev if e['type']=='tool/result'}
rc=[(cid, results.get(cid,{}).get('isError'), (results.get(cid,{}).get('content') or [{}])[0].get('text','')[:140]) for n,cid in calls if n=='run_code']
am=[e for e in ev if e['type']=='assistant/message']
tok=[e['data'].get('usage',{}).get('inputTokens') for e in am if e['data'].get('usage')]
perm=[e['data']['preset'] for e in ev if e['type']=='permission/preset']
print('tools:', len(set(tools)), '| run_code in header:', 'run_code' in tools, '| lsp:', 'lsp' in tools, '| SDK section:', 'Writing code for run_code' in sysmsg, '| ptc-only rule:', 'only tool you can call directly' in sysmsg)
print('tier:', perm[-1] if perm else None, '| first input tokens:', tok[0] if tok else None, '| run_code calls:', [(err, txt) for _,err,txt in rc])
\""
}
echo "== 1. Build session: header carries run_code + SDK; a task that invites a program"
sid=$(create vesta-build /home/hugo/code/vesta-harness-staging); echo "session $sid"
prompt "$sid" "Using one run_code program, list the five largest files under packages/vesta of this repository with their sizes, then stop. Do not modify anything."
inspect "$sid"; echo "$sid" >> /tmp/t12-sessions.txt
echo; echo "== 2. Research session (read-only): run_code must be refused by the tier guard"
sid=$(create vesta-research /home/hugo/workspace/dsh-chat); echo "session $sid"
prompt "$sid" "Call the run_code tool with the code: return 1 + 1 — and report exactly what the tool answered, then stop. If run_code is not among your tools, say so."
inspect "$sid"; echo "$sid" >> /tmp/t12-sessions.txt
echo; echo "== 3. Build session switched to research by /mode: run_code refused after the switch"
sid=$(create vesta-build /home/hugo/code/vesta-harness-staging); echo "session $sid"
rpc commands/execute "{\"agentId\":\"$sid\",\"line\":\"/mode research\",\"submittedAttachments\":[]}" | head -c 120; echo
prompt "$sid" "Call the run_code tool with the code: return 2 + 2 — and report exactly what the tool answered, then stop."
inspect "$sid"; echo "$sid" >> /tmp/t12-sessions.txt
echo "== done"
