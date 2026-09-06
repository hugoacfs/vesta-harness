# Vesta Harness on vesta — ops runbook

Everything here runs as `hugo` on vesta from the source checkout `~/code/vesta-harness` (branch `vesta`), with a **fresh Harness home** `~/.vesta-harness`. Since the cutover (2026-09-05) `https://vesta.tail22b555.ts.net:8790` serves this harness; the rc.7 install (`~/code/dsh`, `~/.dsh`, unit `dsh-web`, stopped and disabled) stays installed as the rollback and still owns the pre-cutover sessions.

## Server documentation

This runbook covers the harness only. The server it runs on (stacks, ports, GPUs, exposure, change history) is documented in the canonical docs repo `~/vesta-docs` on vesta (`github.com/hugoacfs/vesta-docs`, published at `https://vesta.tail22b555.ts.net/docs/`); its `services/vesta-harness.md` and `services/voice.md` are the server-side views of this deployment, and its `AGENTS.md` carries the hard rules (GPU pinning, bindings, secrets). Agents inside harness sessions start from `~/workspace/dsh-chat/AGENTS.md`. Keep both in step: anything here that changes what runs or binds gets a dated entry in that README.

## Layout

| What | Where |
|---|---|
| Source checkout | `~/code/vesta-harness` (origin `hugoacfs/vesta-harness`, upstream `deepseek-ai/deepseek-harness`) |
| Harness home | `~/.vesta-harness` — `profiles/vesta/`, `settings.yaml`, `.credentials.yaml` (chmod 600), `.agent-presets/vesta-orch/` |
| Service | systemd `--user` unit `vesta-harness` → `node apps/cli/lib/bin.js --profile vesta --host 127.0.0.1 --port 3081 --trusted-host vesta.tail22b555.ts.net --no-open` |
| Tailnet URL | `https://vesta.tail22b555.ts.net:8790` (tailscale serve → `127.0.0.1:3081`); nginx `/dsh` redirects there; `:8791` was the side-by-side port before cutover and is off |
| Templates | this directory: `profiles/vesta/*`, `settings.yaml`, `agent-presets/vesta-orch/*`, `vesta-harness.service` |

## Prerequisites (once)

Node ≥ 22.19 and pnpm are installed (`/usr/local/bin`). The Landlock sandbox launcher is a native binary built per architecture; without it only the `danger-full-access` permission preset works (`read-only` / `workspace-write` fail closed).

```bash
sudo apt-get install -y musl-tools
```

## Build

```bash
cd ~/code/vesta-harness
pnpm install --frozen-lockfile
pnpm --filter @deepseek-ai/node-addon-landlock-run-workspace run build:native   # sandbox binary (needs musl-tools)
pnpm run build                                                        # host + client + frontend
```

## Home

```bash
mkdir -p ~/.vesta-harness/profiles ~/.vesta-harness/.agent-presets
cp -r ~/code/vesta-harness/deploy/vesta/profiles/vesta ~/.vesta-harness/profiles/
cp ~/code/vesta-harness/deploy/vesta/settings.yaml ~/.vesta-harness/settings.yaml
cp -r ~/code/vesta-harness/deploy/vesta/agent-presets/vesta-orch ~/.vesta-harness/.agent-presets/
install -m 600 ~/.dsh/.credentials.yaml ~/.vesta-harness/.credentials.yaml   # VESTA_API_KEY; never in git
```

Check the composed tree before booting:

```bash
cd ~/code/vesta-harness && DSH_HOME=~/.vesta-harness node apps/cli/lib/bin.js --profile vesta --dump-config | grep -E 'vesta|mcp-'
```

## Service and tailnet

```bash
install -m 644 ~/code/vesta-harness/deploy/vesta/vesta-harness.service ~/.config/systemd/user/vesta-harness.service
systemctl --user daemon-reload && systemctl --user enable --now vesta-harness
systemctl --user status vesta-harness --no-pager
tailscale serve --bg --https=8790 http://127.0.0.1:3081
```

## First visit from a browser

`dsh web` gates the page behind a per-process launch token: the bare URL answers `401 dsh web authentication required` until the browser has opened the tokenized URL once. That exchange sets a signed, host-bound cookie whose signing secret lives in `$DSH_HOME/.credentials.yaml`, so the cookie survives service restarts; only a new browser or device needs the token again.

```bash
install -m 755 ~/code/vesta-harness/deploy/vesta/bin/vesta-url ~/.local/bin/vesta-url
vesta-url    # prints https://vesta.tail22b555.ts.net:8790/?token=… for the running process
```

## Verify

- `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3081/` → `200`
- `https://vesta.tail22b555.ts.net:8790` shows the Vesta brand (ember orb, "Vesta Harness") and the ember theme.
- A new session answers through Qwen (`default`); `mcp__memory__*` / `mcp__search__*` appear in the tool list; the hero shows `vesta-orch`; `/permission` lists `read-only`, `workspace-write`, `danger-full-access`.

## Voice (Phase A)

The LiveKit stack stays in `/srv/ai/compose/livekit-voice`; its compose file is versioned here as `livekit-voice.docker-compose.yml`, and both voice services build from this checkout: the agent worker `services/livekit-agent` and the SenseVoice STT sidecar `services/livekit-media`. The standalone voice UI (`livekit-webui`, `:8480`) and its frontend are retired behind the compose profile `legacy` (stopped, image kept); `docker compose --profile legacy up -d livekit-webui` plus `tailscale serve --bg --https=8480 http://127.0.0.1:3010` bring the old page back. The Harness needs the LiveKit credentials as references:

```bash
python3 -c "env=dict(l.rstrip('\n').split('=',1) for l in open('/srv/ai/compose/livekit-voice/.env') if '=' in l and not l.startswith('#')); p='/home/hugo/.vesta-harness/.credentials.yaml'; t=open(p).read(); t=t if 'LIVEKIT_API_KEY' in t else t.replace('refs:\n','refs:\n  LIVEKIT_API_KEY: %s\n  LIVEKIT_API_SECRET: %s\n'%(env['LIVEKIT_API_KEY'],env['LIVEKIT_API_SECRET']),1); open(p,'w').write(t)"
```

Roll the stack after a change:

```bash
cp ~/code/vesta-harness/deploy/vesta/livekit-voice.docker-compose.yml /srv/ai/compose/livekit-voice/docker-compose.yml && cd /srv/ai/compose/livekit-voice && docker compose up -d --build livekit-media livekit-agent
```

Voice replies skip Qwen's thinking phase: `settings.yaml` declares `reasoning: xhigh` on the `vesta` provider (typed sessions keep thinking) and, on the `default` model, `reasoningEfforts: {off: null, xhigh: xhigh}` plus `compat.thinkingFormat: qwen-chat-template`; the bridge selects `off` for a Session while its call is bound (pi-ai then sends `chat_template_kwargs.enable_thinking=false`) and restores the previous effort when the call ends. The level name is a label: this format never sends a level, and the served chat template thinks at its own default (`xhigh`; it also accepts `medium` and `low` as `chat_template_kwargs.reasoning_effort`, which the harness does not use).

Checks: `docker logs -f livekit-agent` shows `bridge bound: room=dsh-… session=… permission=…` when a call starts from the Harness; `journalctl --user -u vesta-harness -f` shows `vesta-voice: room bound to session …`; `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3081/vesta/voice/bridge` answers `404`/`426` without an upgrade (the route exists only for WebSocket upgrades). Rollback: remove `DSH_BRIDGE_URL` from the agent service (direct mode for every room) or restore the previous compose file.

Callers and re-joins: the token route mints one participant identity per Session (`user-<uuid>`), because LiveKit's RoomIO links the first caller and from then on only re-links that identity; before this, every mic press minted a random identity and a re-join into a room whose agent was still there got an agent that heard nothing (nine such attempts in one call on 2026-09-06). The agent's `_follow_callers` also links whatever standard participant joins when the linked one is gone (a token from an older build, a second device after the first left). The streaming STT socket sends a frame of silence after 20 s without room audio (moshi-server drops a socket silent for 120 s, and a dead socket used to end recognition for the rest of the call) and reopens after any drop. The call HUD lists the browser's microphones behind the caret next to mute (the choice is kept in localStorage `vesta.voice.micDeviceId` and applied on the next call), shows a five-bar meter of what the room hears, and prints capture errors in the bar; `deploy/vesta/bin/vesta-call-check` run twice within 20 s on the same Session reproduces the re-join case (`linking caller …` in the agent log).

## Streaming voice server (Kyutai moshi-server)

`services/moshi-server` builds Kyutai's Rust `moshi-server` (the server behind Unmute) with both voice models on the 3060 in one container: streaming TTS at `/api/tts_streaming` (text in as it is generated, audio out a few hundred ms later) and streaming STT with semantic end-of-turn at `/api/asr-streaming` (words ~0.5 s behind the audio, the model's own pause prediction ends the turn). Compose: `deploy/vesta/moshi-server.docker-compose.yaml` → `/srv/ai/compose/moshi-server/` (`.env` holds `HUGGING_FACE_HUB_TOKEN`; the Hugging Face cache is shared with the Python TTS sidecar so `tts-1.6b` and the voices are not fetched twice; `stt-1b-en_fr-candle` downloads on first start). The image compiles the crate for `sm_86` (`CUDA_COMPUTE_CAP`, no GPU at build time); the first build takes ~15 minutes.

```bash
mkdir -p /srv/ai/compose/moshi-server/voices/expresso && cp ~/code/vesta-harness/deploy/vesta/moshi-server.docker-compose.yaml /srv/ai/compose/moshi-server/docker-compose.yaml
cp -r ~/code/vesta-harness/services/moshi-server/configs /srv/ai/compose/moshi-server/
snap=$(ls -d /srv/ai/compose/kyutai-tts/cache/hub/models--kyutai--tts-voices/snapshots/* | head -1)
cp "$snap"/expresso/ex03-ex01_calm_001_channel1_1143s.wav*.safetensors /srv/ai/compose/moshi-server/voices/expresso/   # only the voices we use: the full set is 901 embeddings on the GPU
cd /srv/ai/compose/moshi-server && docker compose up -d --build && docker compose logs -f   # until build_info answers on 127.0.0.1:8092
docker cp ~/code/vesta-harness/deploy/vesta/bin/vesta-moshi-check.py livekit-agent:/tmp/moshi-check.py
docker exec livekit-agent python /tmp/moshi-check.py tts "Hello there, this is a streaming test."
docker exec livekit-agent python /tmp/moshi-check.py stt /tmp/q2.wav
```

Measured 2026-09-06 (scripted caller): TTS first audio 0.29–0.48 s after the first word, STT words ~0.6 s behind the audio, greeting 1.7 s after the room binds, plain spoken turn 3.0–3.1 s. The agent picks backends by environment (`deploy/vesta/livekit-voice.docker-compose.yml`, now `moshi` for both): `TTS_BACKEND=moshi|openai`, `STT_BACKEND=moshi|sensevoice`, `KYUTAI_WS_URL` (default `ws://127.0.0.1:8092`; host networking, loopback only), `KYUTAI_PAUSE_HEAD` (0: 0.5 s, 1: 1 s, 2: 2 s pause ends the turn; default 1), `KYUTAI_PAUSE_GRACE_S` (0.9: words trail the audio, so the turn finalizes this long after the pause prediction or the latest word), `KYUTAI_FINAL_AFTER_SILENCE_S` (fallback, 1.2). With `STT_BACKEND=moshi` the agent uses `turn_detection="stt"` (the STT's own end of speech commits the turn) and a 0.25 s endpointing wait. With the moshi STT the SenseVoice sidecar stays up only for the "[tone: …]" notes: each finished utterance is sent there in the background and the note is appended to the next spoken turn if it arrives in time (`TONE_NOTES=0` disables). The Python TTS sidecar (`kyutai-tts`) is stopped while moshi-server runs (the 3060 cannot hold both); to fall back, stop moshi-server, start kyutai-tts, and set `TTS_BACKEND=openai`. SenseVoice stays up for tone notes and as the STT fallback.

Second pass for accuracy (2026-09-06): the streaming model (Kyutai 1B) ends the turn and shows words as they come, and once the utterance is complete the same audio (from 1.5 s before the first streamed word) goes through Whisper on the media sidecar (`POST /v1/audio/refine`: faster-whisper `large-v3-turbo`, `int8_float16`, ~1 GB on the 3060, SenseVoice run alongside for the tone note, which now precedes the transcript instead of racing it) for the text the brain receives. The pass starts when the pause is predicted and re-runs 0.25 s after a burst of late words, so it usually lands inside the 0.9 s grace (`second pass waited 0ms` in the agent log; it adds nothing measurable to the turn). A pass that is empty or wildly different in length from the streamed words is ignored. Knobs: media `REFINE_MODEL` (empty disables), `REFINE_DEVICE`, `REFINE_COMPUTE`, `REFINE_PROMPT` (vocabulary Whisper is biased towards); agent `STT_REFINE=0` to keep the streamed words, `KYUTAI_REFINE_TIMEOUT_S` (1.5), `KYUTAI_REFINE_DEBOUNCE_S` (0.25), `KYUTAI_LEAD_IN_S` (1.5). Check: `curl -F file=@/srv/ai/compose/livekit-voice/probes/p_time.wav http://127.0.0.1:8011/v1/audio/refine` (probe WAVs made with `services/livekit-agent`'s moshi TTS; `/srv/ai/compose/livekit-voice/probes/`). The 3060 then carries ~9.6 GB (moshi-server 7.5, SenseVoice + Whisper 2.1).

Smooth speech (2026-09-06): the halts heard mid-reply were not the voice server (it renders 2.3× real time alone and 2.2× with the listener streaming), so the agent now paces playback and the browser reports its own dropouts. `kyutai.py` holds `TTS_PREROLL_S` (0.35) of audio before the first push, stretches with WSOLA (`audiotsm`, pitch kept; `TTS_STRETCH=resample` restores the old pitch-shifting resample) at `TTS_SPEED` (1.2), slides the speed towards 1.0 when the buffered lead drops under `TTS_LEAD_LOW_S` (0.15; full speed again above `TTS_LEAD_HIGH_S` 0.5), and logs one line per utterance: `kyutai tts: utterance 21.1s played from 25.3s generated, min lead 0.36s, audio starves 0 (0 ms), word gaps over 200ms 0` (a starve is the playout buffer running empty; a word gap is the model pausing). While Vesta speaks and the caller is silent, the listener gate (`KYUTAI_GATE_WHILE_SPEAKING=1`) holds room audio (the last 1.5 s) instead of streaming it, so the listening model takes no GPU steps during a reply; a local Silero VAD reopens the stream the moment the caller starts and the held audio is flushed first (`kyutai stt: listener open (422 frames held)` = a 21 s reply, 50 ms frames; `KYUTAI_GATE_TAIL_S` keeps it open 1 s after the caller stops). In the browser, the call bar's signal glyph shows LiveKit's connection quality and its tooltip the receiver's concealed audio, packets lost and jitter since the call started; `localStorage.setItem('vesta.voice.debug','1')` prints them to the console once a second. A halt that shows up as concealment there is the network's (next lever: `setPlayoutDelay` on the track); one that does not, with starves 0 in the agent log, is in the browser's own playout. Scripted checks: `vesta-call-check` now streams silence between WAVs (a browser microphone never stops), `GREETING_WAIT_S=0 PLAY_AFTER_S=2` talks over the greeting, `BARGE_AFTER_S=4` talks over the first reply; probe `p_long.wav` asks for a five-sentence answer.

Filler lines (2026-09-06): `services/livekit-agent/fillers.py` gives Vesta short things to say in her own voice while she thinks or works, the way ChatGPT voice does. The lines live in `deploy/vesta/fillers.yaml` (copied to `/srv/ai/compose/livekit-voice/fillers.yaml`, mounted read-only) in four groups: `thinking` ("Hmm.", "Let me see." — played when the reply's first words are `FILLER_THINK_AFTER_S` (1.0) late), `working` ("One sec.", "Let me check." — the first tool call of a turn, unless the model has already said something), `still_working` ("Still on it." — every `DSH_PROGRESS_INTERVAL_S` of silent tool work) and `acknowledge` (reserved). Each line is rendered once per voice through the streaming TTS at worker start (behind the prewarm hook, one process at a time under `.render.lock`) into `/srv/ai/compose/livekit-voice/fillers/<voice key>/`, so restarts cost nothing and a new line in the file renders at the next `docker compose restart livekit-agent`; lines longer than `FILLER_MAX_S` (1.8, thinking `FILLER_THINK_MAX_S` 0.9) are never played. A clip plays through the reply's own audio stream ahead of the words still to come (the stream is opened with a blank chunk the moment a turn starts), so it can never overlap the answer and a barge-in cuts it like any speech; `FILLERS=0` restores the fixed `DSH_TOOL_ACK` / `DSH_PROGRESS_PHRASES` text. Agent log: `filler thinking (in reply): 'Hmm.'`, `filler working (in reply): 'One sec.'`, `… clips 2` on the utterance line, and `harness turn done: tools=… spoken='…'` with the first 120 characters of every reply. Bridged scripted turn with the clips: first sound 1.0 s after the question ends, the answer's own words about 2 s after.

Scripted checks reach the harness only with the full session id: `vesta-call-check` now prefixes a bare uuid, because a `dsh-<uuid>` room is refused by the bridge (404) and the agent then answers in direct mode (Qwen straight from LiteLLM, its own prompt and `web_search`) — which looks like a working call, greets with the fixed line, and never reaches the harness. `bridge bound: room=dsh-session-…` in the agent log is the proof a run counted.

## Vesta Voice preset

`deploy/vesta/agent-presets/vesta-voice` is a lean composition for sessions you mostly talk to: shell, files, search, background jobs, web search plus the bundle's MCP servers, without delegation, workflow, ralph, planning, skills, todo, goal or ask-user. Fewer tool schemas and prompt sections mean a smaller request prefix, so the first spoken reply after a quiet spell arrives sooner. Install it like vesta-orch (`cp -r … ~/.vesta-harness/.agent-presets/`; the roster re-scans on every read, no restart) and pick it in the hero's preset selector before the first message; a session's preset is fixed once it has produced anything. `preset.yml` descriptions with a colon must be quoted or the roster shows the bare id.

## Voice commands and approvals (Phase B)

During a call these utterances are handled by the agent worker and never reach the model:

| Say | Effect |
|---|---|
| "stop", "cancel that", "never mind" | cancels the running turn (`interrupt`), keeps queued work |
| "switch to safe mode" / "read-only mode" | `permission/preset` → `read-only` |
| "switch to workspace mode" | → `workspace-write` |
| "switch to full access mode" / "dangerous mode" | → `danger-full-access` |
| "what mode am I in?" | answers from the harness's last `permission` notice (on-screen changes included) |

A permission utterance needs a verb (switch, change, set, go, put, use, give…) and a mode word (mode, permission, access), so "list files in workspace mode" style false positives stay rare. The harness confirms aloud ("Switched to read-only mode.") and the header's permission selector updates.

When the assistant asks you something (`ask_user_question`, or a plan review from plan mode), it reads the question and options aloud and takes the next thing you say as the answer: an option name, "the second one", "approve" for a plan, or free text, which is passed on as a custom answer. Multi-question sets are asked one at a time. The on-screen card works at the same time; whichever answers first wins.

When a tool call needs approval (sandbox escalation in `read-only` / `workspace-write`), the assistant asks aloud ("The bash tool wants workspace write access, to create the notes file. Allow it?") and the on-screen card appears too. Answer with "yes" / "no" (or click); the first answer wins, the card closes on a spoken answer, and the turn continues with the assistant's follow-up spoken unprompted. Without the Landlock binary (see Prerequisites) the non-escalated commands in those modes fail closed, so the model escalates more often; that is expected until `musl-tools` is installed.

When a call binds, the harness submits a short greeting turn (`vesta-voice` config `warmupOnBind`, default on): its spoken reply greets the caller, and running it drives the whole request prefix (system prompt plus tool schemas) through Qwen, so that prefix is warm in the model's prefix cache and the first real spoken turn skips the cold prefill. The agent's own `BRIDGE_GREETING` is therefore left empty (a value would double the greeting); set `warmupOnBind: false` and a `BRIDGE_GREETING` line to greet with a fixed text-to-speech line instead and skip warming.

Conversational feel knobs on `livekit-agent` (env, defaults in brackets): `DSH_TOOL_ACK` ["Let me check."] spoken when the first tool call starts before the model has said anything; `DSH_PROGRESS_INTERVAL_S` [25] and `DSH_PROGRESS_PHRASES` ["Still on it.|Working on it.|Almost there."] for silent tool work; `MIN_ENDPOINTING_S` [0.4], `MAX_ENDPOINTING_S` [3.0], `MIN_INTERRUPTION_S` [0.4] for turn-taking (LiveKit defaults 0.5 / 6.0 / 0.5). The TTS sidecar streams raw PCM while it generates (`response_format: pcm`; log line `first audio chunk after N s`), and a barge-in over unprompted speech now cancels the harness turn too.

Scripted check from the agent container (WAVs made with the TTS sidecar; `settle` catches the unprompted continuation). Session ids carry the `session-` prefix (directory name under `$DSH_HOME/sessions/<workspace>/`), so the room is `dsh-session-<uuid>`; a bare uuid answers `404` at the bridge:

```bash
docker cp ~/code/vesta-harness/deploy/vesta/bin/vesta-call-check livekit-agent:/tmp/call-check.py && docker exec livekit-agent python -u /tmp/call-check.py session-<uuid> /tmp/safe.wav,/tmp/mkfile.wav,/tmp/yes.wav 75 45
```

Make the WAVs with the TTS sidecar, e.g. `curl -s -o /tmp/yes.wav http://127.0.0.1:8010/v1/audio/speech -H 'Content-Type: application/json' -d '{"model":"kyutai/tts-1.6b-en_fr","input":"Yes, go ahead.","voice":"expresso/ex03-ex01_calm_001_channel1_1143s.wav","response_format":"wav"}'` and `docker cp` them into the container. Plugin logger lines do not reach the journal (only the startup URL does); use the agent container's log and the session log for evidence.

## CLI smoke check (no browser)

`profiles/vesta-headless` stacks the same layers without the web server, so a one-shot run proves the model route, credentials, preset, and MCP tools from a shell:

```bash
cd ~/code/vesta-harness && DSH_HOME=~/.vesta-harness node apps/cli/lib/bin.js --profile vesta-headless "Reply with exactly the word pong and nothing else."
```

Ask it to "list the tool names starting with mcp__" to confirm the memory and search servers are mounted.

## Update

```bash
cd ~/code/vesta-harness && git pull --ff-only origin vesta && pnpm install --frozen-lockfile && pnpm run build && systemctl --user restart vesta-harness
```

## Old sessions from rc.7

The rc.7 store (`~/.dsh/sessions`, format v0) is a different home; the new harness never reads it in place. `deploy/vesta/bin/vesta-migrate-sessions.mjs` copies each session directory into `~/.vesta-harness/sessions/<workspace>/` (the v0 file stays as the retained generation) and opens it through the real JSONL provider, which publishes `session.v2.jsonl.zstd` beside it. Pre-migrating matters: the web process's session index migrates inside a search request otherwise, and a multi-second migration aborts the search ("Content search is temporarily unavailable") while a refused log hides every later session. Restart the harness afterwards so the boot-time index sees them.

```bash
node ~/code/vesta-harness/deploy/vesta/bin/vesta-migrate-sessions.mjs --dry-run ~/.dsh/sessions ~/.vesta-harness/sessions
node ~/code/vesta-harness/deploy/vesta/bin/vesta-migrate-sessions.mjs ~/.dsh/sessions ~/.vesta-harness/sessions
systemctl --user stop vesta-harness && python3 ~/code/vesta-harness/deploy/vesta/bin/vesta-attach-sessions.py && systemctl --user start vesta-harness
```

The attach step puts the migrated sessions into the dsh-chat sidebar group (otherwise they sit under "Ungrouped"). A session that is in the store and in the list but absent from the sidebar is usually archived: `storages/workspace.json` → `global.archivedSessionIds` (edit with the harness stopped, or use the row's "Archive session" menu to toggle). Titles appear once each session has been opened once (the list reads the projection cache only); open each row once, or let them fill in as you click.

Forks (headers with `parentSession` + `seedLength`) migrate too, at ~30 s each for a few hundred thousand inherited events, which is why the script pre-migrates instead of leaving it to the web process. rc.7's subagent child sessions (`origin: subagent`, bare-uuid directories) are refused by the current codec ("subagent/descriptor uses unsupported descriptor version 2"); the script removes the failed copy again so the index stays healthy. They never appear in the sidebar; only the parents' subagent detail views lose them. rc.7 had 11 sessions archived (`~/.dsh/storages/workspace.json` → `archivedSessionIds`); the migration leaves everything visible.

## Cutover (done 2026-09-05) and rollback

Cutover was three reversible steps: `tailscale serve --bg --https=8790 http://127.0.0.1:3081` (re-points the existing port; nginx's `/dsh` redirect follows), `systemctl --user disable --now dsh-web`, and `tailscale serve --https=8791 off`. The old install keeps `~/.dsh` (its sessions are readable only there; the new home never sees them) and `~/code/dsh`.

Rollback to rc.7:

```bash
systemctl --user enable --now dsh-web && tailscale serve --bg --https=8790 http://127.0.0.1:3080
```

The new harness keeps running on `127.0.0.1:3081` meanwhile; `tailscale serve --bg --https=8791 http://127.0.0.1:3081` exposes it side by side again.
