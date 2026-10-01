#!/bin/bash
# mac-verify.sh — a staging session on the vesta-mac preset runs a command and reads a file on
# Hugo's Mac through the Mac's reverse tunnel (vesta-mac on). Runs from the Mac; deletes its session.
# Staging by default, VESTA_TARGET=prod for production.
set -u
D="$(cd "$(dirname "$0")" && pwd)"
if [ "${VESTA_TARGET:-staging}" = prod ]; then
  S=https://vesta.tail22b555.ts.net/harness; J=/tmp/jar-prod.txt; H=/home/hugo/.vesta-harness; JAR=jar-prod.sh
else
  S=https://vesta.tail22b555.ts.net/harness-staging; J=/tmp/jar-staging.txt; H=/home/hugo/.vesta-harness-staging; JAR=jar.sh
fi
bash "$D/$JAR" >/dev/null || { echo "no cookie jar for ${VESTA_TARGET:-staging}"; exit 1; }
MARK="mac-verify-$(date +%s)"; echo "$MARK" > "$HOME/.vesta-mac/verify-marker.txt"
uuid() { python3 -c 'import uuid;print(uuid.uuid4())'; }
rpc() { curl -s -b "$J" -H 'content-type: application/json' -X POST "$S/api/$1" -d "{\"type\":\"client-request\",\"rpcId\":\"$(uuid)\",\"method\":\"$1\",\"payload\":{\"args\":$2}}"; }
sid=$(rpc session/create "{\"request\":{\"cwd\":\"/home/hugo/workspace/dsh-chat\",\"agentPreset\":\"vesta-mac\"}}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["value"]["sessionId"])')
echo "session $sid (vesta-mac on ${VESTA_TARGET:-staging})"
rpc session/prompt "{\"request\":{\"requestId\":\"mac-$(uuid)\",\"sessionId\":\"$sid\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"Two steps on the Mac, then one line. 1) Run the shell command: uname -s -m; whoami  with workdir /Users/u2370878. 2) Read the file /Users/u2370878/.vesta-mac/verify-marker.txt. Answer with: <uname output> | <whoami> | <file contents>. Nothing else.\"}]}}" >/dev/null
ssh vesta "H=$H; f=''; for i in \$(seq 1 60); do f=\$(ls \$H/sessions/*/$sid/session.v3.jsonl.zstd 2>/dev/null | head -1); [ -n \"\$f\" ] && zstd -dc -- \"\$f\" | grep -q '\"turn/end\"' && break; sleep 3; done; [ -n \"\$f\" ] || { echo 'no session log'; exit 1; }; zstd -dc -- \"\$f\" | python3 -c \"
import sys,json
ev=[json.loads(l) for l in sys.stdin if l.strip()]
calls=[c.get('name') for e in ev if e['type']=='assistant/message' for c in e['data']['message'].get('content',[]) if c.get('type')!='text' and c.get('name')]
print('tool calls:', calls[:8])
errs=[json.dumps(e.get('data'))[:200] for e in ev if e['type']=='turn/end' and (e.get('data') or {}).get('reason',{}).get('kind')=='error']
print('turn errors:', errs or 'none')
text=''
for e in ev:
    if e['type']=='assistant/message':
        for c in e['data']['message'].get('content',[]):
            if c.get('type')=='text' and c['text'].strip(): text=c['text'].strip()
print('answer:', text[-200:].replace(chr(10),' '))
print('RESULT:', 'PASS' if '$MARK' in text and 'Darwin' in text and 'u2370878' in text else 'FAIL')
\""
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$J" -H 'content-type: application/json' -X POST "$S/api/vesta/sessions/delete" -d "{\"sessionId\":\"$sid\"}")
echo "deleted the test session: HTTP $code"
