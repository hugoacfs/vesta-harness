#!/bin/bash
# Voice echo scenarios on staging (2026-09-20): a synthetic speakerphone caller against the staging worker.
# usage: voice-echo-scenarios.sh <label> <scenarios...>   scenarios: s1 s1b s2n s2 s3 s5 s4
#   s1  echo, no question (the greeting only), settle 25 s      -> expect no transcript, no turn
#   s1b echo + one question, settle 20 s                         -> one final, one turn, the reply's echo dropped or never transcribed
#   s2n no echo, long reply, a second question 3 s into it        -> the reply is interrupted, the second question answered
#   s2  the same with echo
#   s3  no echo, the drawn-out-word probe (vesta-voice-pause-probe) -> one final with the whole sentence
#   s5  echo; the caller answers with the agent's own words       -> "The blue one." reaches the harness
#   s4  loud echo (0.8) with a 450 ms delay, one question           -> one turn
# Runs ON vesta. Sessions it creates are listed in /tmp/voice-test-sessions.txt (delete them with /api/vesta/sessions/delete).
# usage: bash -s <label> <scenarios...>   scenarios: s1 s1b s2 s3
LABEL=${1:-run}; shift
C=livekit-agent-staging
J=/tmp/jar-staging.txt; S=https://vesta.tail22b555.ts.net/harness-staging
cd ~/code/vesta-harness-staging || exit 1
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$J" "$S/api/vesta/routines" 2>/dev/null)
if [ "$code" != "200" ]; then url=$(~/.local/bin/vesta-url staging 2>/dev/null | grep -oE 'https://[^ ]+token=[^ ]+' | head -1); rm -f "$J"; curl -s -o /dev/null -c "$J" "$url"; fi
newsession() { curl -s -b $J -H 'content-type: application/json' -X POST "$S/api/session/create" -d '{"type":"client-request","rpcId":"ve-1","method":"session/create","payload":{"args":{"request":{"cwd":"/home/hugo/workspace/chat","agentPreset":"vesta-voice"}}}}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["value"]["sessionId"])'; }
worklog() { docker logs --since "$1" $C 2>&1 | python3 -c '
import sys,json,collections
c=collections.Counter(); lines=[]
for l in sys.stdin:
    try: e=json.loads(l)
    except Exception: continue
    m=e.get("message","")
    for k in ("kyutai stt: final","dropped self-echo","flushing vad","harness turn done","interrupted by the caller","echo guard:","false interruption"):
        if k in m: c[k]+=1
    if any(k in m for k in ("kyutai stt: final","dropped self-echo","flushing vad","harness turn done","bridge bound","echo guard:","tts: utterance","interrupt","false interruption","resum","agent state:","user state:","user transcript")): lines.append((e.get("timestamp") or "")[11:23]+" "+m[:160])
print("   counts:", dict(c))
for x in lines[:60]: print("  ", x)
if len(lines)>60: print("   ... +%d more lines" % (len(lines)-40))'; }
docker cp deploy/vesta/bin/vesta-call-check $C:/tmp/call-check.py
docker cp /srv/ai/compose/livekit-voice/probes/say.py $C:/tmp/say.py
docker cp deploy/vesta/bin/vesta-voice-pause-probe.py $C:/tmp/mkpause.py
say() { docker exec $C test -f "$2" || docker exec $C python /tmp/say.py "$1" "$2"; }   # one check per WAV
say "What time is it right now?" /tmp/q_time.wav
say "Actually, never mind that. Tell me a short joke instead." /tmp/q_joke.wav
say "Tell me about the history of London in five or six sentences." /tmp/q_london.wav
say "Please ask me whether I prefer the red one or the blue one, then wait for my answer." /tmp/q_ask.wav
say "The blue one." /tmp/a_blue.wav
docker exec $C test -f /tmp/pause.wav || { docker exec $C python /tmp/say.py "I wouldn't like to pay more than" /tmp/half1.wav "two hundred and seventy pounds a month." /tmp/half2.wav; docker exec $C python /tmp/mkpause.py /tmp/half1.wav /tmp/half2.wav /tmp/pause.wav 4.5; }
run() { # name env... -- caller args
  local name=$1; shift; local envs=(); while [ "$1" != "--" ]; do envs+=(-e "$1"); shift; done; shift
  local SID; SID=$(newsession); echo "$SID" >> /tmp/voice-test-sessions.txt
  local T0; T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "== $LABEL/$name  session $SID"
  timeout 240 docker exec -e AGENT_NAME=vesta-staging -e ROOM_PREFIX=dshs- "${envs[@]}" $C python -u /tmp/call-check.py "$SID" "$@" 2>&1 | grep -v -E 'token=|AUDIO_CAPTURE|panicked|panic|RUST_BACKTRACE|non-unwinding|^\s*$' | tail -14
  worklog "$T0"
}
for sc in "$@"; do case $sc in
  s1)  run s1-echo-no-question ECHO_GAIN=0.5 ECHO_DELAY_MS=220 -- - 40 25 ;;
  s1b) run s1b-echo-one-question ECHO_GAIN=0.5 ECHO_DELAY_MS=220 -- /tmp/q_time.wav 45 20 ;;
  s2)  run s2-echo-barge-in ECHO_GAIN=0.5 ECHO_DELAY_MS=220 BARGE_AFTER_S=3 -- /tmp/q_london.wav,/tmp/q_joke.wav 60 10 ;;
  s2n) run s2n-no-echo-barge-in ECHO_GAIN=0 BARGE_AFTER_S=3 -- /tmp/q_london.wav,/tmp/q_joke.wav 60 10 ;;
  s3)  run s3-no-echo-pause-probe ECHO_GAIN=0 -- /tmp/pause.wav 60 8 ;;
  s5)  run s5-answer-repeats-her-words ECHO_GAIN=0.5 ECHO_DELAY_MS=220 -- /tmp/q_ask.wav,/tmp/a_blue.wav 45 10 ;;
  s4)  run s4-loud-echo-long-delay ECHO_GAIN=0.8 ECHO_DELAY_MS=450 -- /tmp/q_time.wav 45 20 ;;
esac; done
