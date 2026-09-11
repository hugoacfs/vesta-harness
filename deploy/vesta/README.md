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
(cd native/system && pnpm build:native)   # Landlock sandbox launcher → native/system/packages/linux-x64/bin/landlock-run (needs musl-tools; built 2026-09-12)
deploy/vesta/bin/vesta-build   # = pnpm install --frozen-lockfile && pnpm run build, with DSH_CLIENT_TITLE="vesta harness" (the tab title since 0.1.5)
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
install -m 755 ~/code/vesta-harness/deploy/vesta/bin/vesta-url ~/.local/bin/vesta-url && sudo ln -sfn ~/.local/bin/vesta-url /usr/local/bin/vesta-url
vesta-url            # https://vesta.tail22b555.ts.net/harness/?token=… for the running production process
vesta-url staging    # …/harness-staging/?token=… (the legacy VESTA_UNIT=vesta-harness-staging form still works)
```

`vesta-url` reads the token from the unit's journal (the process's own start line, else the unit's newest one), works from ssh/cron without a login session (it sets the user-bus variables itself), and **probes the URL before printing it**: the harness must answer `303` to the exchange, otherwise it explains what is wrong (`401` = the token belongs to an older process, restart or wait for the new start line; other codes = the reverse proxy or the unit). `--no-check` or `VESTA_URL_CHECK=0` skips the probe; `VESTA_BASE` overrides the base URL for a dedicated-port rollback.

## Verify

- `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3081/` → `401` (the auth gate; a `404` in the first seconds after a restart only means the fallback route is not registered yet).
- `https://vesta.tail22b555.ts.net/harness/` → `401` without the cookie; with it the index carries `<base href="/harness/">`, the three Vesta fonts (Inter, Space Grotesk, JetBrains Mono) load under the prefix, and the page shows the brand (veiled-goddess emblem, lowercase “vesta harness_” wordmark) on the ember theme.
- A new session answers through Qwen (`default`); `mcp__memory__*`, `mcp__search__*` and `mcp__telegram-notify__notify` appear once each in the tool list; the hero shows `Vesta Default`; `/permission` lists `read-only`, `workspace-write`, `danger-full-access`.
- Voice: the composer's “Start a voice call” goes Connecting → Listening → Speaking (the greeting) and `docker logs livekit-agent` shows `bridge bound: room=dsh-session-…`.
- Since the 0.1.5 sync: `curl -b <jar> https://vesta.tail22b555.ts.net/harness/open-in-app/apps` → `200` (upstream's desktop hand-off probe, made base-relative in the fork); a session RPC `session/create` with each preset (`vesta-default`, `vesta-orch`, `vesta-voice`) returns a session id — a preset that fails to mount breaks new sessions AND resumes, so check it right after every update.

## Upstream base 0.1.5-rc.2 (synced 2026-09-11)

The fork now sits on `upstream/master` `c291e7961a` (merge `08ccc0210a`; procedure and lessons in `VESTA.md` → “Upstream sync”). What changed for operators: (1) build with `deploy/vesta/bin/vesta-build`; (2) presets follow upstream's `standard` composition — the persona row's config field is `prefix` (was `text`; a stale preset fails to mount with `$.prefix missing required value`), and `present` (file-delivery cards) is a bare tool row; (3) sessions are format v3, migrated lazily from v2 when opened (the v2 file stays beside the v3 one), so tar `~/.vesta-harness/sessions` before any downgrade; (4) the sidebar keeps workspaces collapsed until clicked and shows a session's title only once it has been opened (projection cache), the composer asks for a workspace before the first message, and the header's “···” menu holds the session log; (5) the tab title is `<session> — vesta harness`; (6) new upstream tools: `read_image`, `present`, and the right-hand panel with files and previews.


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

### TTS channels

`moshi-server` serves two TTS channels for the whole box (`configs/vesta.toml`, `batch_size = 2`) and an utterance's socket stays open for the server's generation tail after the last word. Since 2026-09-11 each worker process serialises its utterances (`KyutaiTTS._channel_gate`), so one call holds one channel and back-to-back replies no longer overlap; an interrupted reply closes its socket at once. A refusal from the pool (`kyutai tts: server refused a channel`) therefore means another call holds both channels — LiveKit retries it 3 × 2 s and then drops the utterance. Raising `batch_size` costs 3060 memory (≈2 GB free); leave it at 2 unless two calls at once become normal.

### Speech speed

The call bar's speed chip (1.0× to 1.3×, since 2026-09-11) posts `{ sessionId, speed }` to `POST /api/vesta/voice/config`; the bridge forwards a `config` frame and the agent applies the speed from its next utterance (`TTS_SPEED` in the compose file stays the default, 1.2). The choice is remembered per browser in `localStorage` (`vesta.voice.speed`). Filler clips are rendered once at the default speed and keep it. Evidence of a change: `docker logs livekit-agent | grep 'harness config'`.

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

## Notifications (Telegram) and presence

Since 2026-09-11 (feature plan P2) the harness pings you on Telegram when nobody is looking. Host plugin `vesta-notify` (`packages/vesta/vesta-notify`, mounted by the `vesta-app` bundle) watches every Session's durable log and the approval / question waterfalls; the browser half `ui-vesta-presence` posts a heartbeat to `POST /api/vesta/notify/presence` every 30 s while a tab is visible. Delivery is a stateless streamable-HTTP `tools/call` to the send-only Telegram MCP (`ai-telegram-mcp`, loopback `127.0.0.1:7335`, tool `notify`); the bot token stays inside that container.

| Trigger | Default | Message |
|---|---|---|
| a turn ran at least `minTurnSeconds` and finished | 120 s | “Turn finished after N s.” + the first line of the reply |
| an approval or ask-user question waited `approvalWaitSeconds` | 60 s | “Approval waiting for <tool>.” / “Question waiting for you.” |

Guards: `onlyWhenAway` (default true: no visible-tab heartbeat for `awayAfterSeconds` = 90 s), `cooldownSeconds` (300 per Session and trigger), `quietHours` (`HH:MM-HH:MM`, local time, may wrap midnight), `silent`; `linkBase` (`https://vesta.tail22b555.ts.net/harness/` in the bundle) is appended to every message. Staging runs short thresholds through its home patch (`staging-cordis.patch.yml`: 20 s / 10 s / 30 s) so the path can be exercised in minutes.

```bash
curl -s -b <jar> -H 'content-type: application/json' -X POST https://vesta.tail22b555.ts.net/harness/api/vesta/notify/presence -d '{"visible":false}'   # {"ok":true,"away":…}
docker logs --since 10m ai-telegram-mcp | grep -c CallToolRequest      # one line per delivery
```

End to end: with every harness tab closed for 90 s, prompt a session over RPC to run `sleep 130` through the shell tool; one message arrives when the turn ends (2026-09-11: 138 s after the prompt on production, 34 s on staging with the short thresholds). Plugin log lines never reach the journal; the MCP container's log is the evidence. A visible tab keeps the notifier quiet by design.

## Sessions: archive, restore, delete, export

Upstream archives a session from its row menu (a registry-global hidden set) and offers nothing after that. Since 2026-09-11 (feature plan P4) the sidebar's global panel list has an **Archived** entry (host `vesta-sessions`, browser `ui-vesta-sessions`, both mounted by the `vesta-app` bundle) whose panel lists every archived session — title, age, workspace — with three actions per row:

| Action | What happens |
|---|---|
| Restore | `POST /api/vesta/sessions/unarchive {sessionId}` → the fork's `WorkspaceRegistry.unarchiveSession`; the session returns to its old place in the sidebar at once (the workspace feed publishes the change to every tab) |
| Download log | upstream's `GET /api/session.export?sessionId=…` (a ZIP of the log); nothing changes on the server |
| Delete for good… | an inline confirm, then `POST /api/vesta/sessions/delete {sessionId}`: an open session is closed first (the fork's `sessionController.close`, 2026-09-11; only a session the controller cannot close, such as a subagent, answers 409), then the session directory is tarred to `exportDir` as `<sessionId>-<timestamp>.tar.gz`, removed, forgotten in the registry (archive set, workspace accounting, header index) and every browser drops the row (`api-session/removed`) |

`exportDir` defaults to `~/backups/sessions-deleted` (bundle row); staging writes to `~/backups/sessions-deleted-staging` (`staging-cordis.patch.yml`). The tarball is the raw directory (`session.v3.jsonl.zstd`, `session.lock`, attachments when present). To bring a deleted session back, unpack it into the workspace directory it came from — the sanitised cwd, e.g. `--home-hugo-workspace-dsh-chat--`:

```bash
tar xzf ~/backups/sessions-deleted/<id>-<stamp>.tar.gz -C ~/.vesta-harness/sessions/<workspace-dir>/
```

The listing reads the directories on every request, so the session is back in `session/list` without a restart; it shows under *Ungrouped* until you move it into a workspace (its accounting was removed with it). The projection cache keeps a derived row for a deleted session; that is harmless and rebuildable. Only the panel deletes: there is no bulk delete and no delete entry in the session row menu. Without a browser (ids are `session-<uuid>`):

```bash
curl -s -b <jar> https://vesta.tail22b555.ts.net/harness/api/vesta/sessions/archived | head -c 300      # {"items":[{"sessionId":…,"title":…,"updatedAt":…,"cwd":…}]}
curl -s -o /dev/null -w '%{http_code}\n' -b <jar> -H 'content-type: application/json' -X POST https://vesta.tail22b555.ts.net/harness/api/vesta/sessions/delete -d '{"sessionId":"session-00000000-0000-0000-0000-000000000000"}'   # 404
```

## Routines: scheduled agent jobs (roadmap R1–R3, 2026-09-11)

Host plugin `vesta-routines` (`packages/vesta/vesta-routines`, bundle patch) and the **Routines** panel (`packages/client/ui-vesta-routines`, next to Archived in the sidebar's panel list). `$DSH_HOME/routines.yaml` lists routines — template `deploy/vesta/routines.example.yaml`, every entry disabled — each with a five-field cron `schedule` (server local time) or a one-off `at`, a `workspace`, a `mode` (preset id), a required `permission` tier, a `prompt`, `notify` (`always`, `failure`, `never`), optional `timeoutMinutes` (30) and `enabled`. Every 30 s the plugin starts what is due, one run at a time: the workspace is resolved or created, a session is created on the mode's preset, its tier set, its title pinned `routine: <name> <stamp>`, the prompt sent once. The run ends at the session's `turn/end` (the last assistant text is the detail) or at the timeout, which closes the session; the outcome goes to Telegram through the notifier MCP per the policy, with `linkBase` appended. State (last run, outcome, session, pause) is `routines.state.json`, the history `routines.log.jsonl` (one JSON line per start and end), both beside the file. The panel shows next and last run, problems in the file, and offers Run now, Pause/Resume (a state-file override; `enabled` in the file is the static switch) and Open last session. Upstream's own reminders (`schedule_*` tools) stay for "remind me in 30 min" inside an open conversation; routines cover the cold case.

Routes: `GET /api/vesta/routines`, `POST /api/vesta/routines/run { name }` (409 while another run is active), `POST /api/vesta/routines/pause { name, paused }`. Verify: a `smoke` routine on `*/2 * * * *` with `notify: never` produces, within two minutes, a `started` and a `finished` line in the log and a session titled `routine: smoke …` in the workspace; Run now on a routine whose mode does not exist logs `failed` with the reason. Staging measured: a "reply ready" routine finishes in 2–3 s, a Research one-liner in 4 s.

## Incognito (roadmap M4, 2026-09-11)

The `vesta-incognito` preset (the Companion composition with an incognito persona) plus the host plugin `vesta-incognito` (`packages/vesta/vesta-incognito`, mounted by the bundle patch): the memory MCP's `memory_write`/`memory_edit`/`memory_delete` are refused on the `tools/pre-execute` waterfall with a reason the model sees; the title is pinned to "Incognito" at creation (a user rename, so no title request runs); `vesta-notify` skips the preset (`excludePresets`); and the session is wiped — directory removed, registry traces forgotten, every browser told — when it is closed, when it is archived (the one-click way out: the row menu's Archive), when the process disposes it, and at the next boot for anything an earlier run left behind. Reasoning is off (`vesta-modes`). Boundaries: the log exists on disk while the session runs (there is no in-memory backend) and the model gateway sees the prompts as for any session.

Verify without a browser: create a session with `agentPreset: vesta-incognito`, ask it to save something with the memory write tool — the tool result is a refusal and the reply says so; the log has one `session/title` event (`Incognito`, source `user`) and no `session/title-llm-request`; archive it with `workspace/archiveSession` and within a few seconds the session directory is gone and `session/list` no longer names it. Restart with an incognito session still open: it is gone after the boot sweep (about five seconds after start).

## Modes (roadmap M1–M2, 2026-09-11)

A mode is an agent preset plus what the harness applies when a session starts with it. The presets live in `deploy/vesta/agent-presets/<mode>/` (copied to `$DSH_HOME/.agent-presets/`, like the older three); the host plugin `vesta-modes` (`packages/vesta/vesta-modes`, configured in the `vesta-app` bundle patch) sets the permission tier and the reasoning level once, on a root session that has not produced a turn yet, so a change made by hand or by voice later is never undone by a resume. The New Session chip (upstream's preset selector, on by default) lists the modes; upstream's demo presets are hidden (`agent-presets.includeShippedRoot: false`). The deployment default is `vesta-ops` (`agent-presets.default` in `settings.yaml`).

| Mode (preset) | Built from | Persona | Tier / reasoning today | Later |
|---|---|---|---|---|
| Ops (`vesta-ops`) | `vesta-default` | operator: look before acting, background jobs, running summary | full access / xhigh | — |
| Build (`vesta-build`) | `vesta-orch` | engineer: read before edit, tests, plan mode, ≤ 2 subagents | **workspace-write** / xhigh (since 2026-09-12) | — |
| Research (`vesta-research`) | `vesta-default` minus plan mode and goals | find out, do not guess; sources; PDF and vision tools | **read-only** / xhigh | — |
| Companion (`vesta-companion`) | `vesta-voice` | warm and brief; memory MCP; knows the time; reminders | **read-only** / **off** | — |
| Incognito (`vesta-incognito`) | `vesta-companion` | nothing kept (see Incognito) | read-only / off | — |

`vesta-default`, `vesta-orch` and `vesta-voice` stay in the roster so existing sessions resume; new sessions should use the modes. The Qwen lane declares only `off` and `xhigh`, so there is no medium level. The tiers run under the Landlock launcher (`native/system`, partial enforcement on this kernel's Landlock ABI: writes outside the workspace are refused, `/tmp` stays writable in workspace-write); a Build session wrote and removed a file in its workspace and a Research session's `touch` was refused, with no approval prompt (2026-09-12). A preset can be switched only while the session is blank (upstream rule); a session that has produced anything keeps its tools, and a soft switch (persona, tier, reasoning) is roadmap M3.

Verify a mode without a browser: create a session with `agentPreset: vesta-companion`, prompt once, and read its log — a `permission/preset` event with the configured tier, a `model/selection` event, and `request/header.config.reasoningEffort: off`. A `preset.yml` description containing a colon must be quoted, or the picker shows the id and "No description".

## Quick mounts (roadmap T1–T6, 2026-09-11)

Six upstream capabilities the composition did not mount, added as rows only (no fork code). Every upstream package a row names must also be a dependency of `packages/bundle/vesta-app/package.json` (then `pnpm install`): the profile directory resolves packages through the bundle's dependency graph, and a row naming a package outside it fails the boot with `Cannot find package`. A patch row can restate a row's `config` or set `disabled`, but it cannot swap the row's package.

| Item | Row | Where | Check |
|---|---|---|---|
| T1 time awareness | `time-context` (`refreshIntervalMs: 300000`) | bundle patch (host) | a session's first step carries a user-role reading "Time sampled while preparing turn 1 … [Europe/London]"; at most one per 5 min |
| T2 own-history search | `tool-session-query` | preset row in `vesta-default` and `vesta-orch` (not the voice preset) | `session_search`, `session_event_search`, `session_trace`, `session_event_trace`, `session_event_read` in the request header's tool list; cross-session reads only within the same cwd |
| T3 whole-conversation titles | `session-title-llm` **disabled** + insert `session-title-all-prompts` (`@deepseek-ai/dsh-session-title-all-prompts-llm`, 16 KB input cap) | bundle patch (host) | `session/title-llm-request` events name `session-title-all-prompts-llm`; the title follows the conversation instead of the first words |
| T4 shell guard (hooks) | `hooks-claude-code` (`configPath: $DSH_HOME/hooks.json`) | home patch (machine-wide) | `hook/invoked` + `hook/result` events on every `bash` call; `echo vesta-guard-canary` is denied (`decision: block`, exit 2, the reason in the tool result). The bridge runs hook commands through the bash executor in `workspace-write`, so a sandbox runner must exist: the Landlock launcher (see Prerequisites; verified 2026-09-12). `bubblewrap` is installed but blocked by Ubuntu's `apparmor_restrict_unprivileged_userns` |
| T5 PDF | `mcp-pdf` → `http://127.0.0.1:7333/mcp` (server `pdf`) | home patch | 16 `mcp__pdf__*` tools in the header; files live under `/srv/ai/pdf-mcp/work` (the container's only visible path) |
| T6 reminders | `schedule` + `ui-schedule` enabled | bundle patch | `schedule_create` / `schedule_list` / `schedule_delete` in the header; delivery only while the session is open (Routines cover the cold case) |

The guard itself is `deploy/vesta/hooks/guard-shell.py` (copied to `$DSH_HOME/hooks/`, config `$DSH_HOME/hooks.json`): a Claude Code style PreToolUse hook that denies, with a reason the model sees, recursive deletes of `/`, the home or `/srv`, `mkfs`, `dd` onto a disk, power actions, fork bombs, recursive `chmod` on `/`, redirects onto disk devices, `docker system prune`/volume removal, force-pushes and `systemctl disable|mask`. Test the list without running anything: `echo '{"tool_name":"bash","tool_input":{"command":"rm -rf /"}}' | python3 deploy/vesta/hooks/guard-shell.py; echo $?` → 2. Extend `DENY` in the script; the home copies must be updated with the template.

## Image reading (CPU vision MCP)

The Qwen lane is text-only, so the composer refuses image attachments and upstream's `read_image` tool refuses as well (`does not support image input`). Since 2026-09-11 (feature plan P5) the harness mounts a CPU vision server instead: `mcp__vision__read_image(path, question?)` from `/srv/ai/compose/vision-mcp` — Ollama `qwen2.5vl:3b` pinned to the CPU on loopback `:11434` and a read-only FastMCP container on loopback `:7338`; no GPU is touched. The row lives in the machine-wide home patch (`deploy/vesta/home-cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` in both homes; a new row needs a harness restart) and the three presets' persona text points the model at it. Put images under `~/workspace` (say `~/workspace/inbox/`), `~/code`, either home's `attachments/`, or `/srv/ai/pdf-mcp/work` — the container mounts those read-only at the same paths — then ask, for example, "read /home/hugo/workspace/inbox/shot.png and tell me what error it shows". Expect 20–60 s with a warm model (59 s for the first call after the container starts) and 2–5 s when the same image is asked about again. Knobs, model swap and rollback: `~/vesta-docs/services/vision-mcp.md`.

```bash
curl -s -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' http://127.0.0.1:7338/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | head -c 200   # read_image
docker logs --since 1h ai-vision-mcp | grep read_image      # one line per call: path, sizes, seconds, chars
```

## Settings from a tailnet browser, and the welcome notice

Upstream keeps every settings scope process-local for a browser whose hostname is not loopback, so from the tailnet the Settings page never persisted and the “Internal Testing Notice” reappeared on every load. The fork's `ui-settings` honours `DSH_CLIENT_SETTINGS_PERSISTENCE=host` at build time (`vesta-build` sets it; `VESTA.md` fork-patch table): settings written from the tailnet land in `$DSH_HOME/settings.yaml`, and the acknowledgement already stored there (`ui-onboarding.welcomeNoticeVersion`) keeps the notice away. Verify: a fresh browser profile opens the `vesta-url` link and lands on the app with no dialog. If upstream bumps the notice version, acknowledge it once from any browser; it persists.

## Phones and home-screen install

Since 2026-09-11 the call bar wraps onto two rows below 480 px (device name and mic meter hidden, errors still shown), and the app installs as a PWA under the sub-path: the manifest's `start_url`/`scope`/`id` are `./` (resolved against `/harness/manifest.webmanifest`), display `standalone`, ember colours, SVG + PNG icons (`apple-touch-icon.png` 180 px, `icon-512.png` 512 px maskable, rendered from `favicon.svg`; regenerate with a 512 px screenshot of the SVG on `#07080c` if the emblem changes). `index.html` carries `theme-color` and the iOS `apple-mobile-web-app-*` tags. Verify: `curl -b <jar> https://vesta.tail22b555.ts.net/harness/manifest.webmanifest` shows `./` fields and three icons; the PNGs answer `image/png`. On the phone: open the `vesta-url` link once in the browser (the cookie persists), then “Add to Home Screen”; the installed app must open the harness, not the landing page, and the mic button must prompt for the microphone.

## CLI smoke check (no browser)

`profiles/vesta-headless` stacks the same layers without the web server, so a one-shot run proves the model route, credentials, preset, and MCP tools from a shell:

```bash
cd ~/code/vesta-harness && DSH_HOME=~/.vesta-harness node apps/cli/lib/bin.js --profile vesta-headless "Reply with exactly the word pong and nothing else."
```

Ask it to "list the tool names starting with mcp__" to confirm the memory and search servers are mounted.

## Update

```bash
cd ~/code/vesta-harness && git pull --ff-only origin vesta && deploy/vesta/bin/vesta-build && systemctl --user restart vesta-harness
```

`vesta-build` is `pnpm install --frozen-lockfile && pnpm run build` with `DSH_CLIENT_TITLE="vesta harness"`: since the 0.1.5 sync the tab title is set at runtime from that build-time variable (a bare `pnpm run build` yields "DSH Local Build").

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

Shared: the LiveKit SFU, `moshi-server`, the media sidecar (its emotion flag is global), LiteLLM, the 3060. **livekit-server 1.13.6 does NOT re-offer a rejected job to another worker, so exactly one unnamed worker may run per SFU.** Production is the sole unnamed worker on automatic dispatch (it accepts only `dsh-` rooms); staging runs **named** (`AGENT_NAME=vesta-staging`) so it leaves the auto-dispatch pool and can never steal a prod room. This matters because two unnamed workers raced: the SFU handed each new room to one of them at random, and when a `dsh-` room landed on the staging worker it rejected it (`declining room …`) and the room got no agent — that took prod voice down on 2026-09-07, fixed by naming staging. Since 2026-09-11 the staging harness's token route requests an **explicit AgentDispatch** through the SFU's API whenever `agentName` is set (`vesta-voice` config `agentName: vesta-staging`, `livekitApiUrl: http://192.168.0.2:7880` in the staging home patch; idempotent per room, best effort), so staging voice works again; the token claim alone stays ignored by 1.13.6. Scripted checks against staging pass `AGENT_NAME=vesta-staging` so `vesta-call-check` requests the same dispatch.

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
vesta-url staging      # first-visit URL for the staging instance
```

Update staging: `cd ~/code/vesta-harness-staging && git fetch origin && git merge --ff-only origin/vesta && deploy/vesta/bin/vesta-build && systemctl --user restart vesta-harness-staging` (the `staging` branch is `vesta` plus whatever is being tried; commit there and `git push origin staging`, never hand-copy files into the checkout), plus `docker compose --profile staging up -d --build livekit-agent-staging` when `services/livekit-agent` changed. Scripted check against staging: `ROOM_PREFIX=dshs- docker exec livekit-agent-staging python /tmp/call-check.py <session-id> /tmp/p_hello.wav` (the staging harness's session id, created on `127.0.0.1:3082`). Promotion: merge `staging` into `vesta` and run the production update. Rollback: `systemctl --user disable --now vesta-harness-staging` (the nginx `/harness-staging/` block then answers a branded 502; remove the block to hide the path), `docker compose --profile staging down` — production is never touched. On 2026-09-11 the checkout had drifted (uncommitted copies of production files, nine commits behind) and its settings had lost the staging-only `ceres` model entry; it was reset to `origin/vesta`, rebuilt, and `ceres` restored from `~/.vesta-harness-staging/RECOVERY-bak-20260910T170822/settings.yaml`.

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
