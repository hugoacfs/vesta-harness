# Vesta Harness on vesta — ops runbook

Everything here runs as `hugo` on vesta from the source checkout `~/code/vesta-harness` (branch `vesta`), with a **fresh Harness home** `~/.vesta-harness`. Since 2026-09-10 the harness is served under a sub-path of the shared tailnet host: **`https://vesta.tail22b555.ts.net/harness/`** (production) and `/harness-staging/` (staging); the dedicated Serve listeners `:8790`/`:8792` used from the 2026-09-05 cutover until then are off (see “Sub-path move” below). The old rc.7 install (`~/code/dsh`, `~/.dsh`, unit `dsh-web`) was removed on 2026-09-07 at the user's request — only production and staging run now; its code and home are left inert on disk and its sessions are backed up in `~/backups` (see “Cutover … and rc.7 removal” below).

## Server documentation

This runbook covers the harness only. The server it runs on (stacks, ports, GPUs, exposure, change history) is documented in the canonical docs repo `~/vesta-docs` on vesta (`github.com/hugoacfs/vesta-docs`, published at `https://vesta.tail22b555.ts.net/docs/`); its `services/vesta-harness.md` and `services/voice.md` are the server-side views of this deployment, and its `AGENTS.md` carries the hard rules (GPU pinning, bindings, secrets). Agents inside harness sessions start from `~/workspace/dsh-chat/AGENTS.md`. Keep both in step: anything here that changes what runs or binds gets a dated entry in that README.

## Layout

| What | Where |
|---|---|
| Source checkout | `~/code/vesta-harness` (origin `hugoacfs/vesta-harness`, upstream `deepseek-ai/deepseek-harness`) |
| Harness home | `~/.vesta-harness` — `profiles/vesta/`, `settings.yaml`, `.credentials.yaml` (chmod 600), `.agent-presets/{vesta-default,vesta-orch,vesta-voice}/`, `cordis.patch.yml` (machine-wide MCP mounts, see “Home”) |
| Service | systemd `--user` unit `vesta-harness` → `node apps/cli/lib/bin.js --profile vesta --host 127.0.0.1 --port 3081 --trusted-host vesta.tail22b555.ts.net --no-open`; drop-in `vesta-harness.service.d/basepath.conf` sets `DSH_BASE_PATH=/harness` |
| Tailnet URL | `https://vesta.tail22b555.ts.net/harness/` — the `:443` Serve listener → `reverse-proxy` nginx (`127.0.0.1:8090`), whose `/harness/` block strips the prefix and proxies to `127.0.0.1:3081` (WebSocket upgrade on, 900 s timeouts); `/dsh` → 302 `/harness/`. `/harness-staging/` → the staging instance (`127.0.0.1:3082`, see below). Reference copy of the blocks: `nginx-harness.conf`. (`:8790`/`:8792` were dedicated Serve listeners until 2026-09-10; `:8791`/rc.7 was removed 2026-09-07.) |
| Templates | this directory: `profiles/vesta/*`, `settings.yaml`, `home-cordis.patch.yml`, `agent-presets/{vesta-default,vesta-orch,vesta-voice}/*`, `vesta-harness.service` + `vesta-harness.service.d/basepath.conf`, `vesta-harness-staging.service` + `vesta-harness-staging.service.d/basepath.conf`, `nginx-harness.conf`, `staging-cordis.patch.yml`, `fillers.yaml`, `livekit-voice.docker-compose.yml`, `moshi-server.docker-compose.yaml`, `bin/*` |

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
cp -r ~/code/vesta-harness/deploy/vesta/agent-presets/{vesta-default,vesta-orch,vesta-voice} ~/.vesta-harness/.agent-presets/
cp ~/code/vesta-harness/deploy/vesta/home-cordis.patch.yml ~/.vesta-harness/cordis.patch.yml   # machine-wide MCP mounts (Telegram notifier)
install -m 600 ~/.dsh/.credentials.yaml ~/.vesta-harness/.credentials.yaml   # VESTA_API_KEY; never in git
```

`$DSH_HOME/cordis.patch.yml` is the machine-wide patch layer (every profile). It carries the host-plane MCP mounts that depend on this box — today only the Telegram notifier (`ai-telegram-mcp`, loopback 7335 → `mcp__telegram-notify__notify`). Memory and search are mounted by the versioned `dsh-vesta-app` bundle (`mcp__memory__*`, `mcp__search__*`); do not add them here again: a second `vesta-search` row (2026-09-09..11) put every search tool twice in the model's catalogue. The default agent preset is `vesta-default` (lean single agent: no delegation, no DeepSeek web search, web lookups through the search MCP); `vesta-orch` stays for fan-out and `vesta-voice` for calls (`settings.yaml` → `agent-presets.default`).

Check the composed tree before booting:

```bash
cd ~/code/vesta-harness && DSH_HOME=~/.vesta-harness node apps/cli/lib/bin.js --profile vesta --dump-config | grep -E 'vesta|mcp-'
```

## Service and tailnet

```bash
install -m 644 ~/code/vesta-harness/deploy/vesta/vesta-harness.service ~/.config/systemd/user/vesta-harness.service
install -D -m 644 ~/code/vesta-harness/deploy/vesta/vesta-harness.service.d/basepath.conf ~/.config/systemd/user/vesta-harness.service.d/basepath.conf   # DSH_BASE_PATH=/harness
systemctl --user daemon-reload && systemctl --user enable --now vesta-harness
systemctl --user status vesta-harness --no-pager
# reverse proxy: paste the /harness blocks from deploy/vesta/nginx-harness.conf into the :443 server block of
# /srv/ai/compose/reverse-proxy/nginx.conf (back it up first; that project is not under git), then
docker exec reverse-proxy nginx -t && docker exec reverse-proxy nginx -s reload
```

The app assumes the site root unless `DSH_BASE_PATH` is set. With it, `frontend-static` emits `<base href="/harness/">`, the clients resolve every Host call (RPC, the gateway stream-mux WebSocket, HMR, uploads, the voice token and emotion routes) against `document.baseURI`, the post-login redirect lands on the prefix, plugin bundle URLs carry it, and the inlined Vesta font URLs are rewritten onto it (commits `a9ea2fd9fb`..`6eaee28660`). Dedicated-port fallback, no nginx involved: remove the drop-in, `systemctl --user daemon-reload && systemctl --user restart vesta-harness`, `tailscale serve --bg --https=8790 http://127.0.0.1:3081`, then `VESTA_BASE=https://vesta.tail22b555.ts.net:8790 vesta-url`.

## First visit from a browser

`dsh web` gates the page behind a per-process launch token: the bare URL answers `401 dsh web authentication required` until the browser has opened the tokenized URL once. That exchange sets a signed, host-bound cookie whose signing secret lives in `$DSH_HOME/.credentials.yaml`, so the cookie survives service restarts; only a new browser or device needs the token again.

```bash
install -m 755 ~/code/vesta-harness/deploy/vesta/bin/vesta-url ~/.local/bin/vesta-url
vesta-url    # prints https://vesta.tail22b555.ts.net/harness/?token=… for the running process (VESTA_UNIT=vesta-harness-staging → /harness-staging/)
```

## Verify

- `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3081/` → `401` (the auth gate; a `404` in the first seconds after a restart only means the fallback route is not registered yet).
- `https://vesta.tail22b555.ts.net/harness/` → `401` without the cookie; with it the index carries `<base href="/harness/">`, the three Vesta fonts (Inter, Space Grotesk, JetBrains Mono) load under the prefix, and the page shows the brand (veiled-goddess emblem, lowercase “vesta harness_” wordmark) on the ember theme.
- A new session answers through Qwen (`default`); `mcp__memory__*`, `mcp__search__*` and `mcp__telegram-notify__notify` appear once each in the tool list; the hero shows `Vesta Default`; `/permission` lists `read-only`, `workspace-write`, `danger-full-access`.
- Voice: the composer's “Start a voice call” goes Connecting → Listening → Speaking (the greeting) and `docker logs livekit-agent` shows `bridge bound: room=dsh-session-…`.

## Voice (Phase A)

The LiveKit stack stays in `/srv/ai/compose/livekit-voice`; its compose file is versioned here as `livekit-voice.docker-compose.yml`, and both voice services build from this checkout: the agent worker `services/livekit-agent` and the media sidecar `services/livekit-media` (SenseVoice tone notes + the Whisper second pass); the streaming voice server is `services/moshi-server` (its own compose project, see below). The standalone voice UI (`livekit-webui`, `:8480`) and its frontend are retired behind the compose profile `legacy` (stopped, image kept); `docker compose --profile legacy up -d livekit-webui` plus `tailscale serve --bg --https=8480 http://127.0.0.1:3010` bring the old page back. The Harness needs the LiveKit credentials as references:

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

Make the WAVs with the streaming voice server: `docker exec livekit-agent python /tmp/say.py "Yes, go ahead." /tmp/yes.wav` (`say.py` is kept in `/srv/ai/compose/livekit-voice/probes/`, next to the probe WAVs; `docker cp` both into the container after a rebuild). The old sidecar route (`127.0.0.1:8010/v1/audio/speech`) only works with the parked `kyutai-tts` project started. Plugin logger lines do not reach the journal (only the startup URL does); use the agent container's log and the session log for evidence.

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

A commit that touches a client plugin (`packages/client/*`) is not live until `pnpm run build` **and** the restart have both run after it: on 2026-09-10 the font-URL fix was committed after the last build and stayed undeployed until the next day.

## Old sessions from rc.7

The rc.7 store (`~/.dsh/sessions`, format v0) is a different home; the new harness never reads it in place. `deploy/vesta/bin/vesta-migrate-sessions.mjs` copies each session directory into `~/.vesta-harness/sessions/<workspace>/` (the v0 file stays as the retained generation) and opens it through the real JSONL provider, which publishes `session.v2.jsonl.zstd` beside it. Pre-migrating matters: the web process's session index migrates inside a search request otherwise, and a multi-second migration aborts the search ("Content search is temporarily unavailable") while a refused log hides every later session. Restart the harness afterwards so the boot-time index sees them.

```bash
node ~/code/vesta-harness/deploy/vesta/bin/vesta-migrate-sessions.mjs --dry-run ~/.dsh/sessions ~/.vesta-harness/sessions
node ~/code/vesta-harness/deploy/vesta/bin/vesta-migrate-sessions.mjs ~/.dsh/sessions ~/.vesta-harness/sessions
systemctl --user stop vesta-harness && python3 ~/code/vesta-harness/deploy/vesta/bin/vesta-attach-sessions.py && systemctl --user start vesta-harness
```

The attach step puts the migrated sessions into the dsh-chat sidebar group (otherwise they sit under "Ungrouped"). A session that is in the store and in the list but absent from the sidebar is usually archived: `storages/workspace.json` → `global.archivedSessionIds` (edit with the harness stopped, or use the row's "Archive session" menu to toggle). Titles appear once each session has been opened once (the list reads the projection cache only); open each row once, or let them fill in as you click.

Forks (headers with `parentSession` + `seedLength`) migrate too, at ~30 s each for a few hundred thousand inherited events, which is why the script pre-migrates instead of leaving it to the web process. rc.7's subagent child sessions (`origin: subagent`, bare-uuid directories) are refused by the current codec ("subagent/descriptor uses unsupported descriptor version 2"); the script removes the failed copy again so the index stays healthy. They never appear in the sidebar; only the parents' subagent detail views lose them. rc.7 had 11 sessions archived (`~/.dsh/storages/workspace.json` → `archivedSessionIds`); the migration leaves everything visible.

## Staging instance (bleeding edge beside production)

A second Harness runs from its own checkout and home so new work can be tried without touching production:

| | production | staging |
|---|---|---|
| checkout | `~/code/vesta-harness` (branch `vesta`) | `~/code/vesta-harness-staging` (branch `staging`) |
| home | `~/.vesta-harness` | `~/.vesta-harness-staging` |
| unit / URL | `vesta-harness`, 3081 → `https://vesta.tail22b555.ts.net/harness/` (drop-in `DSH_BASE_PATH=/harness`) | `vesta-harness-staging`, 3082 → `…/harness-staging/` (drop-in `DSH_BASE_PATH=/harness-staging`) |
| voice rooms | `dsh-session-<uuid>` | `dshs-session-<uuid>` (home patch `roomPrefix: dshs-`) |
| worker | `livekit-agent` (accepts `dsh-*`, health `127.0.0.1:8081`) | `livekit-agent-staging` (compose profile `staging`, accepts `dshs-*`, health `127.0.0.1:8082`) |

Shared: the LiveKit SFU, `moshi-server`, the media sidecar (its emotion flag is global), LiteLLM, the 3060. **livekit-server 1.13.6 does NOT re-offer a rejected job to another worker, so exactly one unnamed worker may run per SFU.** Production is the sole unnamed worker on automatic dispatch (it accepts only `dsh-` rooms); staging runs **named** (`AGENT_NAME=vesta-staging`) so it leaves the auto-dispatch pool and can never steal a prod room. This matters because two unnamed workers raced: the SFU handed each new room to one of them at random, and when a `dsh-` room landed on the staging worker it rejected it (`declining room …`) and the room got no agent — that took prod voice down on 2026-09-07, fixed by naming staging. Consequence: **staging voice is parked** until explicit AgentDispatch (the server API `CreateDispatch`, not the token claim which 1.13.6 ignores) is wired for `dshs-` rooms. Token-based named dispatch (`vesta-voice` `agentName`, `AGENT_NAME` in the token) stays off — 1.13.6 ignores it.

Set-up (done 2026-09-06):

```bash
git clone git@github.com:hugoacfs/vesta-harness.git ~/code/vesta-harness-staging && cd ~/code/vesta-harness-staging && git checkout -b staging origin/vesta && pnpm install --frozen-lockfile && pnpm run build
H=~/.vesta-harness-staging; mkdir -p $H/profiles/vesta $H/.agent-presets $H/storages $H/sessions
cp ~/.vesta-harness/settings.yaml ~/.vesta-harness/.credentials.yaml $H/ && chmod 600 $H/.credentials.yaml $H/settings.yaml
cp -r ~/.vesta-harness/.agent-presets/. $H/.agent-presets/ && cp ~/.vesta-harness/profiles/vesta/{package.json,cordis.yml,pnpm-workspace.yaml} $H/profiles/vesta/ && mkdir -p $H/profiles/vesta/node_modules
cp ~/code/vesta-harness-staging/deploy/vesta/staging-cordis.patch.yml $H/profiles/vesta/cordis.patch.yml
cp ~/code/vesta-harness-staging/deploy/vesta/vesta-harness-staging.service ~/.config/systemd/user/ && install -D -m 644 ~/code/vesta-harness-staging/deploy/vesta/vesta-harness-staging.service.d/basepath.conf ~/.config/systemd/user/vesta-harness-staging.service.d/basepath.conf && systemctl --user daemon-reload && systemctl --user enable --now vesta-harness-staging
# nginx: the /harness-staging block from deploy/vesta/nginx-harness.conf (see “Service and tailnet”); until 2026-09-10 this was `tailscale serve --bg --https=8792 http://127.0.0.1:3082`
cd /srv/ai/compose/livekit-voice && docker compose --profile staging up -d --build livekit-agent-staging
VESTA_UNIT=vesta-harness-staging vesta-url      # first-visit URL for the staging instance
```

Update staging: `cd ~/code/vesta-harness-staging && git fetch origin && git merge --ff-only origin/vesta && pnpm install --frozen-lockfile && pnpm run build && systemctl --user restart vesta-harness-staging` (the `staging` branch is `vesta` plus whatever is being tried; commit there and `git push origin staging`, never hand-copy files into the checkout), plus `docker compose --profile staging up -d --build livekit-agent-staging` when `services/livekit-agent` changed. Scripted check against staging: `ROOM_PREFIX=dshs- docker exec livekit-agent-staging python /tmp/call-check.py <session-id> /tmp/p_hello.wav` (the staging harness's session id, created on `127.0.0.1:3082`). Promotion: merge `staging` into `vesta` and run the production update. Rollback: `systemctl --user disable --now vesta-harness-staging` (the nginx `/harness-staging/` block then answers a branded 502; remove the block to hide the path), `docker compose --profile staging down` — production is never touched. On 2026-09-11 the checkout had drifted (uncommitted copies of production files, nine commits behind) and its settings had lost the staging-only `ceres` model entry; it was reset to `origin/vesta`, rebuilt, and `ceres` restored from `~/.vesta-harness-staging/RECOVERY-bak-20260910T170822/settings.yaml`.

## Sub-path move (2026-09-10) and follow-up (2026-09-11)

On 2026-09-10 both harnesses moved off their dedicated Serve listeners onto sub-paths of the shared `:443` host (done by another agent; commits `a9ea2fd9fb`, `4631d2dbc1`, `099a9aa40c`, `a044d22f9f`, `6eaee28660`, savepoint `ae2ff41f85`): nginx `location /harness/` and `/harness-staging/` (prefix stripped, WebSocket upgrade, 900 s timeouts) in `/srv/ai/compose/reverse-proxy/nginx.conf` (backups `nginx.conf.bak-harness-prod-20260910`, `nginx.conf.bak-harness-staging-20260910`), systemd drop-ins setting `DSH_BASE_PATH`, and `tailscale serve --https=8790 off` / `--https=8792 off`. The landing page links `/harness`; `/dsh` bounces there. The same days brought the brand pass (lowercase wordmark with a blinking caret, veiled-goddess emblem, favicon/manifest/tab title, retuned ambient ground), the `vesta-default` preset as the default, and the Telegram notifier mount (2026-09-09).

Follow-up on 2026-09-11: the last of those commits (the unquoted-`url()` font fix) had been committed after the last build, so production was rebuilt and restarted; the duplicate search mount was removed from both homes; the `*.bak-*` and `dist.bak-*` files left in both checkouts were moved to `~/backups/harness-checkouts-bak-20260911/`; the drop-ins, nginx blocks, home patch and `vesta-url` were versioned here. Verified: token exchange `303 → /harness/`, base href, fonts and plugin bundles under the prefix, a scripted bridged call (replies 2.0 s and 1.5 s after the question, zero audio starves) and a headless-Firefox call through the composer mic (Connecting → Listening 1.5 s → Speaking 7.5 s, no failed requests).

Rollback to the dedicated ports: remove the drop-in(s), `systemctl --user daemon-reload && systemctl --user restart vesta-harness`, `tailscale serve --bg --https=8790 http://127.0.0.1:3081` (`8792` → `3082` for staging), `VESTA_BASE=https://vesta.tail22b555.ts.net:8790 vesta-url`; the nginx blocks can stay.

## Cutover (done 2026-09-05) and rc.7 removal (2026-09-07)

Cutover was three reversible steps: `tailscale serve --bg --https=8790 http://127.0.0.1:3081` (re-points the existing port; nginx's `/dsh` redirect follows), `systemctl --user disable --now dsh-web`, and `tailscale serve --https=8791 off`.

The old install (`~/.dsh`, `~/code/dsh`, unit `dsh-web`) was then kept as the rollback until **2026-09-07, when rc.7 was removed** at the user's request — only production and staging run now. Steps taken: `dsh-web` stopped and disabled, the unit file `~/.config/systemd/user/dsh-web.service` deleted, and `tailscale serve --https=8791 off` (Serve then listed only `:8790` and `:8792`; both went off on 2026-09-10 with the sub-path move). It was backed up first to `~/backups` (`dsh-web.service.bak-before-remove-20260907` and `dsh-home.bak-before-remove-20260907.tar.gz` = the 34M `~/.dsh` home). `~/code/dsh` (315M) and `~/.dsh` (34M) are left inert on disk; neither is shared with the fork (both live units set `DSH_HOME=~/.vesta-harness{,-staging}`; no symlinks point into `~/code/dsh`).

To resurrect rc.7 from the backups if ever needed:

```bash
cp ~/backups/dsh-web.service.bak-before-remove-20260907 ~/.config/systemd/user/dsh-web.service
systemctl --user daemon-reload && systemctl --user enable --now dsh-web
tailscale serve --bg --https=8791 http://127.0.0.1:3080
```

Production and staging are untouched by any of this.
