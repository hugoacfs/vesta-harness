#!/bin/bash
# s-verify.sh — Pipeline S on staging (2026-09-25): a staging session sees no Telegram tool and no
# Home Assistant tool, its memory tools reach the staging memory server (loopback 7339), and a recall
# through memory_search works. Runs from the Mac (ssh vesta for the session log and the container
# log); the session it creates is deleted at the end through the fork's delete route.
set -u
S=https://vesta.tail22b555.ts.net/harness-staging
J=/tmp/jar-staging.txt
H=/home/hugo/.vesta-harness-staging
CWD=/home/hugo/workspace/dsh-chat
D="$(cd "$(dirname "$0")" && pwd)"
bash "$D/jar.sh" >/dev/null || { echo "no staging jar"; exit 1; }
uuid() { python3 -c 'import uuid;print(uuid.uuid4())'; }
rpc() { curl -s -b "$J" -H 'content-type: application/json' -X POST "$S/api/$1" -d "{\"type\":\"client-request\",\"rpcId\":\"$(uuid)\",\"method\":\"$1\",\"payload\":{\"args\":$2}}"; }
sid=$(rpc session/create "{\"request\":{\"cwd\":\"$CWD\",\"agentPreset\":\"vesta-ops\"}}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["value"]["sessionId"])')
echo "session $sid (vesta-ops on staging)"
before=$(ssh vesta "docker logs ai-memory-mcp-staging 2>&1 | grep -c 'POST /mcp'")
rpc session/prompt "{\"request\":{\"requestId\":\"s-$(uuid)\",\"sessionId\":\"$sid\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"Use memory_search once to look for notes about a printer, then answer in one short line what you found (or that nothing turned up). No other tools.\"}]}}" >/dev/null
ssh vesta "H=$H; f=''; for i in \$(seq 1 40); do f=\$(ls \$H/sessions/*/$sid/session.v3.jsonl.zstd 2>/dev/null | head -1); [ -n \"\$f\" ] && zstd -dc -- \"\$f\" | grep -q '\"turn/end\"' && break; sleep 3; done; [ -n \"\$f\" ] || { echo 'no session log'; exit 1; }; zstd -dc -- \"\$f\" | python3 -c \"
import sys,json
ev=[json.loads(l) for l in sys.stdin if l.strip()]
tools=set()
for e in ev:
    if e['type']=='request/header':
        for t in ((e.get('data',{}).get('header') or {}).get('tools') or []):
            n=t.get('name') if isinstance(t,dict) else None
            if n: tools.add(n)
tel=sorted(t for t in tools if 'telegram' in t); ha=sorted(t for t in tools if 'home-assistant' in t or 'home_assistant' in t); mem=sorted(t for t in tools if 'memory' in t)
print('tools', len(tools), '| telegram:', tel or 'none', '| home-assistant:', ha or 'none', '| memory:', mem)
calls=[(c.get('type'), c.get('name')) for e in ev if e['type']=='assistant/message' for c in e['data']['message'].get('content',[]) if c.get('type')!='text']
print('non-text content blocks:', calls[:8])
text=''
for e in ev:
    if e['type']=='assistant/message':
        for c in e['data']['message'].get('content',[]):
            if c.get('type')=='text' and c['text'].strip(): text=c['text'].strip()
print('answer:', text[-220:].replace(chr(10),' '))
\""
after=$(ssh vesta "docker logs ai-memory-mcp-staging 2>&1 | grep -c 'POST /mcp'")
echo "staging memory server requests during the turn: $((after - before))"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$J" -H 'content-type: application/json' -X POST "$S/api/vesta/sessions/delete" -d "{\"sessionId\":\"$sid\"}")
echo "deleted the test session: HTTP $code (exported to ~/backups/sessions-deleted-staging first)"
