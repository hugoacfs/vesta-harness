#!/bin/bash
# image-verify.sh — the harness shows the Qwen lane a picture (2026-09-30). A session reads a test
# page with the built-in read_image tool and answers with a code that exists only in the pixels.
# Runs from the Mac; staging by default, VESTA_TARGET=prod for production. One image only: the
# lane's per-request image count is the ceiling (deploy/vesta/README.md, "Image reading"). The
# session it creates is deleted at the end through the fork's delete route.
set -u
D="$(cd "$(dirname "$0")" && pwd)"
if [ "${VESTA_TARGET:-staging}" = prod ]; then
  S=https://vesta.tail22b555.ts.net/harness; J=/tmp/jar-prod.txt; H=/home/hugo/.vesta-harness; JAR=jar-prod.sh
else
  S=https://vesta.tail22b555.ts.net/harness-staging; J=/tmp/jar-staging.txt; H=/home/hugo/.vesta-harness-staging; JAR=jar.sh
fi
CWD=/home/hugo/workspace/dsh-chat
IMG=/home/hugo/workspace/inbox/vision-test/page.png
SRC=/srv/ai/compose/qwen38-27b-vllm/research/vision-20260930/t_page.png
bash "$D/$JAR" >/dev/null || { echo "no cookie jar for ${VESTA_TARGET:-staging}"; exit 1; }
ssh vesta "mkdir -p $(dirname $IMG) && { [ -s $IMG ] || cp $SRC $IMG; } && [ -s $IMG ]" || { echo "test picture missing on vesta ($SRC)"; exit 1; }
uuid() { python3 -c 'import uuid;print(uuid.uuid4())'; }
rpc() { curl -s -b "$J" -H 'content-type: application/json' -X POST "$S/api/$1" -d "{\"type\":\"client-request\",\"rpcId\":\"$(uuid)\",\"method\":\"$1\",\"payload\":{\"args\":$2}}"; }
sid=$(rpc session/create "{\"request\":{\"cwd\":\"$CWD\",\"agentPreset\":\"vesta-ops\"}}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["value"]["sessionId"])')
echo "session $sid (vesta-ops on ${VESTA_TARGET:-staging})"
rpc session/prompt "{\"request\":{\"requestId\":\"img-$(uuid)\",\"sessionId\":\"$sid\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"Call read_image on $IMG once. Then answer with only the reference code written on that page. No other tools.\"}]}}" >/dev/null
ssh vesta "H=$H; f=''; for i in \$(seq 1 60); do f=\$(ls \$H/sessions/*/$sid/session.v3.jsonl.zstd 2>/dev/null | head -1); [ -n \"\$f\" ] && zstd -dc -- \"\$f\" | grep -q '\"turn/end\"' && break; sleep 3; done; [ -n \"\$f\" ] || { echo 'no session log'; exit 1; }; zstd -dc -- \"\$f\" | python3 -c \"
import sys,json
raw=[l for l in sys.stdin if l.strip()]
ev=[json.loads(l) for l in raw]
calls=[c.get('name') for e in ev if e['type']=='assistant/message' for c in e['data']['message'].get('content',[]) if c.get('type')!='text' and c.get('name')]
print('tool calls:', calls[:6])
print('image blocks in the log:', sum(l.count('\\\"type\\\":\\\"image\\\"') for l in raw))
errs=[e['type'] for e in ev if 'error' in e['type']]
print('error events:', errs[:4] or 'none')
text=''
for e in ev:
    if e['type']=='assistant/message':
        for c in e['data']['message'].get('content',[]):
            if c.get('type')=='text' and c['text'].strip(): text=c['text'].strip()
print('answer:', text[-160:].replace(chr(10),' '))
print('RESULT:', 'PASS' if 'QF-7731-ELM' in text and 'read_image' in calls else 'FAIL', '(expected QF-7731-ELM through read_image)')
\""
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$J" -H 'content-type: application/json' -X POST "$S/api/vesta/sessions/delete" -d "{\"sessionId\":\"$sid\"}")
echo "deleted the test session: HTTP $code"
