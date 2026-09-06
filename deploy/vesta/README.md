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
