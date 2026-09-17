#!/bin/bash
# T12 v2 benchmark on staging: multi-step, output-heavy tasks in a given preset. Usage: t12v2-bench.sh <preset> <label>
# Reports steps, seconds, time to first token of step 1, input tokens, tool-result characters that entered context, run_code use.
set -u
PRESET=${1:-vesta-build}; LABEL=${2:-$PRESET}
S=https://vesta.tail22b555.ts.net/harness-staging
J=/tmp/jar-staging.txt
H=/home/hugo/.vesta-harness-staging
CWD=/home/hugo/code/vesta-harness-staging
uuid() { python3 -c 'import uuid;print(uuid.uuid4())'; }
rpc() { curl -s -b "$J" -H 'content-type: application/json' -X POST "$S/api/$1" -d "{\"type\":\"client-request\",\"rpcId\":\"$(uuid)\",\"method\":\"$1\",\"payload\":{\"args\":$2}}"; }
create() { rpc session/create "{\"request\":{\"cwd\":\"$CWD\",\"agentPreset\":\"$PRESET\"}}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["value"]["sessionId"])'; }
prompt() { rpc session/prompt "{\"request\":{\"requestId\":\"t12v2-$(uuid)\",\"sessionId\":\"$1\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":$(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$2")}]}}" >/dev/null; }
measure() {
  ssh vesta "H=$H; for i in \$(seq 1 180); do f=\$(ls \$H/sessions/*/$1/session.v3.jsonl.zstd 2>/dev/null | head -1); [ -n \"\$f\" ] && zstd -dc -- \"\$f\" | grep -q '\"turn/end\"' && break; sleep 4; done; zstd -dc -- \"\$f\" | python3 -c \"
import sys,json
ev=[json.loads(l) for l in sys.stdin if l.strip()]
ts=[e for e in ev if e['type']=='turn/start']; te=[e for e in ev if e['type']=='turn/end']
ss=[e for e in ev if e['type']=='step/start']
am=[e for e in ev if e['type']=='assistant/message']
tok=[e['data'].get('usage',{}).get('inputTokens') for e in am if e['data'].get('usage')]
out=[e['data'].get('usage',{}).get('outputTokens') for e in am if e['data'].get('usage')]
calls=[e['data']['name'] for e in ev if e['type']=='tool/call']
res=[e for e in ev if e['type']=='tool/result']
chars=sum(len(c.get('text','')) for e in res for c in (e['data']['message']['content'][0].get('content') or []))
errs=len([e for e in res if e['data']['message']['content'][0].get('isError')])
ttft=None
if ss and am:
    recs=am[0]['data'].get('stream') or []
    t0=[r.get('time0') for r in recs if r.get('type') in ('text-chunks','reasoning-chunks','tool-call-chunks') and r.get('time0')]
    if t0: ttft=round((min(t0)-ss[0]['time'])/1000,1)
secs=round((te[-1]['time']-ts[0]['time'])/1000) if ts and te else None
reason=te[-1]['data']['reason']['kind'] if te else 'no-end'
hdr=[e for e in ev if e['type']=='request/header']
tools=len(set(t.get('name') for e in hdr for t in ((e['data'].get('header') or {}).get('tools') or [])))
text=''
for e in am:
    for c in e['data']['message'].get('content',[]):
        if c.get('type')=='text' and c['text'].strip(): text=c['text'].strip()
print(json.dumps({'steps':len(ss),'seconds':secs,'ttft':ttft,'firstInput':tok[0] if tok else None,'sumInput':sum(t for t in tok if t),'sumOutput':sum(t for t in out if t),'tools':tools,'calls':len(calls),'run_code':calls.count('run_code'),'resultChars':chars,'toolErrors':errs,'end':reason,'tail':text[-200:].replace(chr(10),' ')}))
\""
}
run_task() { local name=$1 text=$2; sid=$(create); prompt "$sid" "$text"; echo "$name $(measure $sid)"; echo "$sid" >> /tmp/t12-sessions.txt; }
echo "== T12 v2 bench: $LABEL / $PRESET ($(date +%H:%M))"
run_task warm "Reply with the single word OK and nothing else."
run_task logs "Collect the last 300 lines of 'journalctl --user -u vesta-harness-staging --no-pager', the last 200 lines of 'docker logs ai-memory-mcp' and the last 200 lines of 'docker logs reverse-proxy'. Report, in at most 15 lines, the distinct warning or error messages per source with their counts and the time of the most recent one. Do not modify anything."
run_task exports "For every directory under packages/vesta of this repository (each is a package), list the names exported from its src/index.ts (lines starting with 'export'), and print a table: package, number of exports, the export names. At most 30 lines. Do not modify anything."
run_task outline "Produce a 12-line outline of deploy/vesta/README.md: each '## ' section title with its starting line number and the number of lines in the section. Do not modify anything."
run_task presets "For each agent.cordis.yml under deploy/vesta/agent-presets/*/, count its rows (lines matching '^- id:') and say whether it contains uncommented tool-terminal, tool-lsp and tool-presentation rows. Print one table row per preset. Do not modify anything."
run_task status "Report in at most 10 lines: the state of the user units vesta-harness and vesta-harness-staging (systemctl --user is-active), whether the docker containers ai-memory-mcp, ai-telegram-mcp and ai-qwen38-27b-vllm are running, the HTTP status codes of http://127.0.0.1:3081/ and http://127.0.0.1:3082/, and the free space on / and /srv/ai. Do not modify anything."
echo "== done $LABEL ($(date +%H:%M))"
