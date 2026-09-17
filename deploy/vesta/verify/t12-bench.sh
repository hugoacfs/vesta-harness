#!/bin/bash
# T12 benchmark on staging: Build-mode first-request size and five tasks. Usage: t12-bench.sh <label>
set -u
LABEL=${1:-native}
S=https://vesta.tail22b555.ts.net/harness-staging
J=/tmp/jar-staging.txt
H=/home/hugo/.vesta-harness-staging
CWD=/home/hugo/code/vesta-harness-staging
uuid() { python3 -c 'import uuid;print(uuid.uuid4())'; }
rpc() { curl -s -b "$J" -H 'content-type: application/json' -X POST "$S/api/$1" -d "{\"type\":\"client-request\",\"rpcId\":\"$(uuid)\",\"method\":\"$1\",\"payload\":{\"args\":$2}}"; }
create() { rpc session/create "{\"request\":{\"cwd\":\"$CWD\",\"agentPreset\":\"vesta-build\"}}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["value"]["sessionId"])'; }
prompt() { rpc session/prompt "{\"request\":{\"requestId\":\"t12-$(uuid)\",\"sessionId\":\"$1\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":$(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$2")}]}}" >/dev/null; }
measure() { # sid → one line of stats (waits for turn/end up to 10 min)
  ssh vesta "H=$H; for i in \$(seq 1 150); do f=\$(ls \$H/sessions/*/$1/session.v3.jsonl.zstd 2>/dev/null | head -1); [ -n \"\$f\" ] && zstd -dc -- \"\$f\" | grep -q '\"turn/end\"' && break; sleep 4; done; zstd -dc -- \"\$f\" | python3 -c \"
import sys,json
ev=[json.loads(l) for l in sys.stdin if l.strip()]
ts=[e for e in ev if e['type']=='turn/start']; te=[e for e in ev if e['type']=='turn/end']
steps=len([e for e in ev if e['type']=='step/start'])
am=[e for e in ev if e['type']=='assistant/message']
tok=[e['data'].get('usage',{}).get('inputTokens') for e in am if e['data'].get('usage')]
first=tok[0] if tok else None
calls=[e['data']['name'] for e in ev if e['type']=='tool/call']
errs=len([e for e in ev if e['type']=='tool/result' and e['data']['message']['content'][0].get('isError')])
secs=round((te[-1]['time']-ts[0]['time'])/1000) if ts and te else None
reason=te[-1]['data']['reason']['kind'] if te else 'no-end'
text=''
for e in am:
    for c in e['data']['message'].get('content',[]):
        if c.get('type')=='text' and c['text'].strip(): text=c['text'].strip()
print(json.dumps({'steps':steps,'seconds':secs,'firstInput':first,'sumInput':sum(t for t in tok if t),'calls':len(calls),'run_code':calls.count('run_code'),'toolErrors':errs,'end':reason,'tail':text[-160:].replace(chr(10),' ')}))
\""
}
echo "== T12 bench: $LABEL ($(date +%H:%M))"
sid=$(create); prompt "$sid" "Reply with the single word OK and nothing else."; echo "prefix $(measure $sid)"; echo "$sid" >> /tmp/t12-sessions.txt
run_task() { local name=$1 text=$2; sid=$(create); prompt "$sid" "$text"; echo "$name $(measure $sid)"; echo "$sid" >> /tmp/t12-sessions.txt; }
run_task largest "List the ten largest files under packages/vesta of this repository by size, and for each say in one line what it is. Do not modify anything."
run_task typecheck "Typecheck the package packages/vesta/vesta-routines with 'pnpm exec tsc -b packages/vesta/vesta-routines' from the repository root and report the result in two lines. Do not modify anything."
run_task loc "Count the lines of TypeScript source (src/**/*.ts and *.tsx, excluding lib and node_modules) for every package directory under packages/vesta and print a small table sorted by lines. Do not modify anything."
run_task todos "Find every TODO or FIXME comment under packages/vesta and deploy/vesta (not node_modules, not lib) and list them as file:line and the comment text. If there are none, say so. Do not modify anything."
run_task health "Check three things and report a three-line status: whether the systemd user unit vesta-harness-staging is active, whether a docker container named ai-memory-mcp is running, and the HTTP status code of http://127.0.0.1:3082/ (401 means healthy). Do not modify anything."
echo "== done $LABEL ($(date +%H:%M))"
