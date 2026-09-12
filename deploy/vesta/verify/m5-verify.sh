#!/bin/bash
# M5 verification on staging: a blank vesta-auto session is routed to a mode by its first message.
set -u
S=https://vesta.tail22b555.ts.net/harness-staging
J=/tmp/jar-staging.txt
H=/home/hugo/.vesta-harness-staging
uuid() { python3 -c 'import uuid;print(uuid.uuid4())'; }
now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }
rpc() { # method args-json
  curl -s -b "$J" -H 'content-type: application/json' -X POST "$S/api/$1" \
    -d "{\"type\":\"client-request\",\"rpcId\":\"$(uuid)\",\"method\":\"$1\",\"payload\":{\"args\":$2}}"
}
jsonq() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
create() { rpc session/create "{\"request\":{\"cwd\":\"$1\",\"agentPreset\":\"vesta-auto\"}}" | jsonq 'd["result"]["value"]["sessionId"]'; }
prompt() { rpc session/prompt "{\"request\":{\"requestId\":\"m5-$(uuid)\",\"sessionId\":\"$1\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":$(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$2")}]}}" | head -c 160; echo; }
inspect() { # sid t0ms expected
  ssh vesta "H=$H; for i in \$(seq 1 40); do f=\$(ls \$H/sessions/*/$1/session.v3.jsonl.zstd 2>/dev/null | head -1); [ -n \"\$f\" ] && zstd -dc -- \"\$f\" | grep -q '\"turn/end\"' && break; sleep 4; done; zstd -dc -- \"\$f\" | python3 -c \"
import sys,json
ev=[json.loads(l) for l in sys.stdin if l.strip()]
sel=[e for e in ev if e['type']=='agent-preset/selected']
ts=[e for e in ev if e['type']=='turn/start']
perm=[e['data'] for e in ev if e['type']=='permission/preset']
model=[e['data'] for e in ev if e['type']=='model/selection']
hdr=[e for e in ev if e['type']=='request/header']
tools=set()
for e in hdr:
    for t in ((e.get('data',{}).get('header') or {}).get('tools') or []):
        n = t.get('name') if isinstance(t,dict) else None
        if n: tools.add(n)
chosen = sel[-1]['data'].get('agentPreset') if sel else None
ok = chosen == '$3'
t_sel = sel[-1].get('time') if sel else None
print('routed to', chosen, 'OK' if ok else 'EXPECTED $3', '| selected seq', sel[-1]['seq'] if sel else None, '< first turn/start seq', ts[0]['seq'] if ts else None)
print('tier', perm[-1]['preset'] if perm else None, '| reasoning', (model[-1].get('reasoningEffort') if model else None), '| turns', len(ts))
print('lsp tool present:', 'lsp' in tools, '| tool count', len(tools))
try:
    print('routing took ~', int(t_sel) - $2, 'ms (selected event time - prompt call time)')
except Exception as ex:
    print('routing time: n/a', t_sel)
\""
}
run_case() { # label cwd expected message
  echo; echo "== $1 (cwd $2) → expect $3"
  sid=$(create "$2"); echo "session $sid"
  t0=$(now_ms); prompt "$sid" "$4"; inspect "$sid" "$t0" "$3"
  echo "$sid" >> /tmp/m5-sessions.txt
}
: > /tmp/m5-sessions.txt
run_case build /home/hugo/code/vesta-harness-staging vesta-build "In this repository, add a unit test for describeCron in packages/vesta/vesta-routines/src/cron.ts. Just tell me the plan in three lines, do not edit any file."
run_case ops /home/hugo vesta-ops "How much disk space is free on / right now? One line, no explanation."
run_case research /home/hugo/workspace/dsh-chat vesta-research "In two sentences, what is the difference between Landlock and AppArmor? No tools needed."
run_case companion /home/hugo/workspace/dsh-chat vesta-companion "Hey Vesta, long day. Fancy a quick chat about nothing in particular? Keep it to two lines."
run_case research2 /home/hugo vesta-research "explain how landlock works in the linux kernel, briefly"
run_case companion2 /home/hugo vesta-companion "help me plan a lazy sunday, i want to do as little as possible"
run_case ops2 /home/hugo/workspace/dsh-chat vesta-ops "can you check whether the vesta-harness-staging unit is running? just say yes or no"
echo; echo "== override: /mode research on a blank Auto session, then a prompt → expect vesta-research"
sid=$(create /home/hugo/workspace/dsh-chat); echo "session $sid"
rpc commands/execute "{\"agentId\":\"$sid\",\"line\":\"/mode research\",\"submittedAttachments\":[]}" | head -c 200; echo
t0=$(now_ms); prompt "$sid" "What is 2 + 2? One word."; inspect "$sid" "$t0" vesta-research
echo "$sid" >> /tmp/m5-sessions.txt
echo; echo "== done; sessions:"; cat /tmp/m5-sessions.txt
