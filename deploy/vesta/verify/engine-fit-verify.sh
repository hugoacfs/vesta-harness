#!/bin/bash
# Engine-fit phase verification on staging (E1 core section, E2 tool groups on demand, E3 depth + /think, E4 routine default preset).
set -u
S=https://vesta.tail22b555.ts.net/harness-staging
J=/tmp/jar-staging.txt
H=/home/hugo/.vesta-harness-staging
uuid() { python3 -c 'import uuid;print(uuid.uuid4())'; }
rpc() { curl -s -b "$J" -H 'content-type: application/json' -X POST "$S/api/$1" -d "{\"type\":\"client-request\",\"rpcId\":\"$(uuid)\",\"method\":\"$1\",\"payload\":{\"args\":$2}}"; }
api() { curl -s -b "$J" -H 'content-type: application/json' "$@"; }
create() { rpc session/create "{\"request\":{\"cwd\":\"$2\",\"agentPreset\":\"$1\"}}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["value"]["sessionId"])'; }
prompt() { rpc session/prompt "{\"request\":{\"requestId\":\"ef-$(uuid)\",\"sessionId\":\"$1\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":$(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$2")}]}}" >/dev/null; }
inspect() { # sid → facts from the session log (waits for the turn to end)
  ssh vesta "H=$H; for i in \$(seq 1 60); do f=\$(ls \$H/sessions/*/$1/session.v3.jsonl.zstd 2>/dev/null | head -1); [ -n \"\$f\" ] && zstd -dc -- \"\$f\" | grep -q '\"turn/end\"' && break; sleep 4; done; zstd -dc -- \"\$f\" | python3 -c \"
import sys,json
ev=[json.loads(l) for l in sys.stdin if l.strip()]
hdr=[e for e in ev if e['type']=='request/header']
tools=[sorted(set(t.get('name') for t in ((e['data'].get('header') or {}).get('tools') or []))) for e in hdr]
sysmsg=' '.join(json.dumps(e['data']) for e in ev if e['type']=='system/message')
sel=[e['data'] for e in ev if e['type']=='model/selection']
am=[e for e in ev if e['type']=='assistant/message']
calls=[e['data']['name'] for e in ev if e['type']=='tool/call']
first=tools[0] if tools else []
ha=[n for n in first if n.startswith('mcp__home-assistant__')]; pdf=[n for n in first if n.startswith('mcp__pdf__')]; vis=[n for n in first if n.startswith('mcp__vision__')]
print('step1 tools:', len(first), '| home:', len(ha), '| pdf:', len(pdf), '| vision:', len(vis), '| tools_enable:', 'tools_enable' in first)
last=tools[-1] if tools else []
print('last-step tools:', len(last), '| home:', len([n for n in last if n.startswith('mcp__home-assistant__')]), '| pdf:', len([n for n in last if n.startswith('mcp__pdf__')]))
print('core section:', 'Working rules for every mode' in sysmsg, '| catalog section:', 'Dormant tool groups' in sysmsg, '| enabled note:', 'Tool groups enabled in this session' in sysmsg)
print('reasoning:', [s.get('reasoningEffort') for s in sel], '| preset selected:', [e['data'].get('agentPreset') for e in ev if e['type']=='agent-preset/selected'], '| calls:', calls[:6])
text=''
for e in am:
    for c in e['data']['message'].get('content',[]):
        if c.get('type')=='text' and c['text'].strip(): text=c['text'].strip()
print('tail:', text[-160:].replace(chr(10),' '))
\""
}
CWD=/home/hugo/workspace/dsh-chat
echo "== E1/E2a Ops session, no keyword: groups dormant, core + catalog present"
sid=$(create vesta-ops $CWD); prompt "$sid" "Reply with the single word OK and nothing else."; inspect "$sid"; echo "$sid" >> /tmp/t12-sessions.txt
echo; echo "== E2b Ops session, keyword 'heating' in the first message: home group awake before the turn"
sid=$(create vesta-ops $CWD); prompt "$sid" "Is the heating on in the living room? If you have no way to check, say so in one line and stop."; inspect "$sid"; echo "$sid" >> /tmp/t12-sessions.txt
echo; echo "== E2c Ops session: the model wakes documents itself, then /tools shows it"
sid=$(create vesta-ops $CWD); prompt "$sid" "Call the tools_enable tool with group documents, then report in one line what it answered and how many mcp__pdf__ tools you can see now. Do nothing else."; inspect "$sid"
rpc commands/execute "{\"agentId\":\"$sid\",\"line\":\"/tools\",\"submittedAttachments\":[]}" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("/tools →", d.get("result",{}).get("value",{}).get("result",{}).get("text"))'; echo "$sid" >> /tmp/t12-sessions.txt
echo; echo "== E3a Auto + quick message: routed and medium"
sid=$(create vesta-auto $CWD); prompt "$sid" "How much free space is on / right now? One line."; inspect "$sid"; echo "$sid" >> /tmp/t12-sessions.txt
echo; echo "== E3b Auto + deep message: routed and xhigh"
sid=$(create vesta-auto /home/hugo/code/vesta-harness-staging); prompt "$sid" "Plan how you would add a unit test for describeCron in packages/vesta/vesta-routines/src/cron.ts: list the cases in five lines, do not edit anything."; inspect "$sid"; echo "$sid" >> /tmp/t12-sessions.txt
echo; echo "== E3c /think on the quick session"
rpc commands/execute "{\"agentId\":\"$sid\",\"line\":\"/think medium\",\"submittedAttachments\":[]}" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("/think →", d.get("result",{}).get("value",{}).get("result",{}).get("text"))'
echo; echo "== E4 routines: default preset by tier, Batch refused at read-only"
api -X POST "$S/api/vesta/routines/save" -d '{"name":"ef-batch","title":"EF batch","workspace":"/home/hugo","permission":"workspace-write","brief":"Say OK.","notify":"never","enabled":false}' | python3 -c 'import sys,json;d=json.load(sys.stdin);i=d.get("item",{});print("workspace-write, no preset →", i.get("preset"), "(chosen:", i.get("presetChosen"), ")") if "item" in d else print("errors:", d.get("errors"))'
api -X POST "$S/api/vesta/routines/save" -d '{"name":"ef-ro","title":"EF read-only","workspace":"/home/hugo","permission":"read-only","brief":"Say OK.","notify":"never","enabled":false}' | python3 -c 'import sys,json;d=json.load(sys.stdin);i=d.get("item",{});print("read-only, no preset →", i.get("preset")) if "item" in d else print("errors:", d.get("errors"))'
api -X POST "$S/api/vesta/routines/save" -d '{"name":"ef-bad","title":"EF bad","workspace":"/home/hugo","permission":"read-only","preset":"vesta-batch","brief":"Say OK.","notify":"never","enabled":false}' | python3 -c 'import sys,json;d=json.load(sys.stdin);print("read-only + vesta-batch →", d.get("errors", "ACCEPTED (unexpected)"))'
for n in ef-batch ef-ro; do api -X POST "$S/api/vesta/routines/delete" -d "{\"name\":\"$n\"}" >/dev/null; done
echo "== done"
