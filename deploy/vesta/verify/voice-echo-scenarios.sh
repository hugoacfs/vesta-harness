#!/bin/bash
# Voice echo scenarios on staging (2026-09-20): a synthetic speakerphone caller against the staging worker.
# usage: voice-echo-scenarios.sh <label> <scenarios...>   scenarios: s1 s1b s2n s2 s3 s5 s4 s6 s7 s7b s8 s8l s9 s9e
#   s1  echo, no question (the greeting only), settle 25 s      -> expect no transcript, no turn
#   s1b echo + one question, settle 20 s                         -> one final, one turn, the reply's echo dropped or never transcribed
#   s2n no echo, long reply, a second question 3 s into it        -> the reply is interrupted, the second question answered
#   s2  the same with echo
#   s3  no echo, the drawn-out-word probe (vesta-voice-pause-probe) -> one final with the whole sentence
#   s5  echo; the caller answers with the agent's own words       -> "The blue one." reaches the harness
#   s4  loud echo (0.8) with a 450 ms delay, one question           -> one turn
#   s6  no echo; a question whose tools run long enough for a "still working" clip mid-reply
#                                                                  -> the answer after the tools is spoken (tts finished, state back to listening)
#   s7  no echo; a hesitation mid-sentence, then a long continuation -> one final with the whole sentence, no pause-cap
#   s7b no echo; two sentences in one breath (a full stop, no VAD gap) -> one final, no pause-cap
#   s8  no echo; a sentence, then a 40 s shell sleep, then the answer -> the "still working" clip plays mid-reply and the
#                                                                  answer after the tool is still spoken (the throttle deadlock of 2026-09-20)
#   s8l no echo; a 130 s shell sleep -> the recognition socket survives the closed listener gate (keepalive), no reconnect
#   s9  no echo; a short "Stop." 3 s into a long reply -> interruption on audio alone: the reply stops well under a second after the caller starts
#   s9e echo; the same -> the echo path is locked, so the word gate stays: the reply stops once the word is recognized
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
    if any(k in m for k in ("kyutai stt: final","dropped self-echo","flushing vad","harness turn done","bridge bound","echo guard:","tts: utterance","interrupt","false interruption","resum","connection lost","server closed","agent state:","user state:","user transcript")): lines.append((e.get("timestamp") or "")[11:23]+" "+m[:160])
print("   counts:", dict(c))
for x in lines[:60]: print("  ", x)
if len(lines)>60: print("   ... +%d more lines" % (len(lines)-40))'; }
docker cp deploy/vesta/bin/vesta-call-check $C:/tmp/call-check.py
docker cp /srv/ai/compose/livekit-voice/probes/say.py $C:/tmp/say.py
docker cp deploy/vesta/bin/vesta-voice-pause-probe.py $C:/tmp/mkpause.py
# The caller speaks with a second voice: with her own voice as the caller, the guard locked onto the
# caller's words (the same synthesizer, the same phonemes) and the self-echo judge had no way to tell
# the two apart (2026-09-23). The embedding comes from the tts-voices snapshot (copied into the
# server's voice folder; the server reads it on demand). WAVs are re-rendered when the voice changes.
CALLER_VOICE=${CALLER_VOICE:-expresso/ex04-ex02_enunciated_001_channel1_496s.wav}
# The drawn-out-word probes keep her own voice: the stretched syllable in the second voice has gaps the VAD
# reads as silence, which is not what the probe tests (the 09-19 and 09-20 baselines were rendered in hers).
PROBE_VOICE=${PROBE_VOICE:-expresso/ex03-ex01_calm_001_channel1_1143s.wav}
docker exec $C sh -c "[ \"\$(cat /tmp/.caller-voice 2>/dev/null)\" = \"$CALLER_VOICE\" ] || { rm -f /tmp/*.wav; echo \"$CALLER_VOICE\" > /tmp/.caller-voice; }"
say() { docker exec $C test -f "$2" || docker exec -e TTS_VOICE="$CALLER_VOICE" $C python /tmp/say.py "$1" "$2"; }   # one check per WAV
say "What time is it right now?" /tmp/q_time.wav
say "Actually, never mind that. Tell me a short joke instead." /tmp/q_joke.wav
say "Tell me about the history of London in five or six sentences." /tmp/q_london.wav
say "Please ask me whether I prefer the red one or the blue one, then wait for my answer." /tmp/q_ask.wav
say "The blue one." /tmp/a_blue.wav
say "Stop." /tmp/a_stop.wav
say "Run the shell command sleep one hundred and thirty and wait for it to finish. When it has finished, tell me what day of the week it is today." /tmp/q_sleep130.wav
say "Fetch the front pages of the BBC, the Guardian, the Financial Times, the Times and the Telegraph, and tell me the top headline on each." /tmp/q_fetch5.wav
say "First tell me in one sentence what you are about to do. Then run the shell command sleep forty and wait for it to finish. When it has finished, tell me what day of the week it is today." /tmp/q_sleep40.wav
say "I wouldn't like to pay more than two hundred and seventy pounds a month. And it should be petrol, an estate or a small SUV, with low mileage, and I don't mind whether it is manual or automatic." /tmp/two_sentences.wav
docker exec $C test -f /tmp/pause.wav || { docker exec -e TTS_VOICE="$PROBE_VOICE" $C python /tmp/say.py "I wouldn't like to pay more than" /tmp/half1.wav "two hundred and seventy pounds a month." /tmp/half2.wav; docker exec $C python /tmp/mkpause.py /tmp/half1.wav /tmp/half2.wav /tmp/pause.wav 4.5; }
docker exec $C test -f /tmp/pause_long.wav || { docker exec -e TTS_VOICE="$PROBE_VOICE" $C python /tmp/say.py "two hundred and seventy pounds a month, and it should be petrol, an estate or a small SUV, with low mileage, and I don't mind whether it is manual or automatic." /tmp/half2long.wav; docker exec $C python /tmp/mkpause.py /tmp/half1.wav /tmp/half2long.wav /tmp/pause_long.wav 4.5 0.3; }
run() { # name env... -- caller args
  local name=$1; shift; local envs=(); while [ "$1" != "--" ]; do envs+=(-e "$1"); shift; done; shift
  local SID; SID=$(newsession); echo "$SID" >> /tmp/voice-test-sessions.txt
  local T0; T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "== $LABEL/$name  session $SID"
  timeout ${RUN_TIMEOUT:-420} docker exec -e AGENT_NAME=vesta-staging -e ROOM_PREFIX=dshs- "${envs[@]}" $C python -u /tmp/call-check.py "$SID" "$@" 2>&1 | grep -v -E 'token=|AUDIO_CAPTURE|panicked|panic|RUST_BACKTRACE|non-unwinding|^\s*$' | tail -14
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
  s6)  run s6-tool-turn-filler-mid-reply ECHO_GAIN=0 -- /tmp/q_fetch5.wav 300 15 ;;
  s7)  run s7-hesitation-long-continuation ECHO_GAIN=0 -- /tmp/pause_long.wav 60 8 ;;
  s7b) run s7b-two-sentences-one-breath ECHO_GAIN=0 -- /tmp/two_sentences.wav 60 8 ;;
  s8)  run s8-sentence-sleep-tool-answer ECHO_GAIN=0 -- /tmp/q_sleep40.wav 240 20 ;;
  s8l) run s8l-long-sleep-keepalive ECHO_GAIN=0 -- /tmp/q_sleep130.wav 330 15 ;;
  s9)  run s9-short-stop-barge-in ECHO_GAIN=0 BARGE_AFTER_S=3 -- /tmp/q_london.wav,/tmp/a_stop.wav 60 10 ;;
  s9e) run s9e-short-stop-barge-in-echo ECHO_GAIN=0.5 ECHO_DELAY_MS=220 BARGE_AFTER_S=3 -- /tmp/q_london.wav,/tmp/a_stop.wav 60 10 ;;
esac; done
