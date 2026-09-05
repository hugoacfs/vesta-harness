# Vesta Harness — plan and status log

Living document: agents working on this fork update the status table and the log as they go. Decisions live in [`VESTA.md`](VESTA.md); ops in [`deploy/vesta/README.md`](deploy/vesta/README.md).

## Status

| Phase | Goal | State |
|---|---|---|
| 0 | Fork online on vesta, styled, text-only: `vesta` profile, ember theme, Vesta brand, MCP rows; side-by-side on `:3081` / serve `:8791` | done 2026-09-05 (Landlock sandbox binary pending `musl-tools`) |
| A | Voice into the session: host bridge plugin, mic + call HUD, Python agent bridge (feature-flagged) | in progress |
| B | Autonomy and approvals by voice; spoken-mode persona preset | pending |
| C | Cutover `:8790`, retire the standalone `:8480` voice UI, move voice service sources into `services/`, upstream sync drill | pending |

Upstream base: `deepseek-ai/deepseek-harness@d347e70` (`dsh-v0.1.3-alpha.1`), forked 2026-09-04.

## Target architecture

You open any session in Vesta Harness, press the mic, and talk. What you say lands in that same session as a normal user turn; Qwen 27B does the agentic work with the session's tools (bash, fs, search, MCP memory/search, subagents) at the session's autonomy level; you see the tool cards on screen and hear the answer (Kyutai "calm" @1.2). Text and voice interleave in one transcript. Approvals can be answered on screen or by voice.

```
Browser (Vesta Harness UI) ──mic──▶ LiveKit SFU (:8481) ──▶ livekit-agent (Python: VAD/turn, SenseVoice STT+emotion, Kyutai TTS)  [3060 only]
        ▲  fetch /api/vesta/voice/token                                        │  each room's job dials ws://127.0.0.1:3081/vesta/voice/bridge
        │                                                                      ▼  (agent on host networking; bearer = LiveKit secret)
Vesta Harness host  `dsh --profile vesta`  (127.0.0.1:3081, serve :8791 → later :8790)
  ├─ dsh-vesta-voice (host): room ↔ session binding, submits the transcript into the session,
  │    streams assistant text back to be spoken, relays tool status, "spoken mode" prompt section
  ├─ dsh-client-ui-vesta-voice: mic button + call HUD (orb, state, mute, hide-emotions, end)
  ├─ dsh-client-ui-vesta-theme / -brand: ember tokens, fonts, ambient ground, Vesta mark, hero orb
  └─ everything else is stock DSH: Qwen via LiteLLM, tools, presets, permission tiers, sessions
```

Standing constraints: voice models run on the RTX 3060 only (`GPU-4c4e6e17-…`), never the 3090 (Qwen vLLM); Qwen via LiteLLM `default` with thinking disabled; tailnet-only exposure, ports on loopback / `192.168.0.2` / `100.120.132.105`, never `0.0.0.0`; secrets only in chmod-600 files, never in git or logs.

## Phase 0 — fork online, styled

1. Clone `hugoacfs/vesta-harness` locally and on vesta; `upstream` remote; branch `vesta`. ✅ 2026-09-04
2. Scaffold `dsh-vesta-app`, `dsh-client-ui-vesta-theme`, `dsh-client-ui-vesta-brand`, fonts, `deploy/vesta`, aggregate references. ✅ 2026-09-04
3. Build on vesta (`pnpm install`, `pnpm run build`). ✅ 2026-09-05 — `musl-tools` + landlock native build still pending (needs sudo); until then only `danger-full-access` runs bash.
4. Home `~/.vesta-harness` (profile, settings, credentials, `vesta-orch` preset). ✅ 2026-09-05
5. `vesta-harness.service` on `:3081`; `tailscale serve --bg --https=8791 http://127.0.0.1:3081`. ✅ 2026-09-05
- Verify: `--dump-config` lists the Vesta rows; `:8791` loads with Vesta brand + ember theme; a text session answers via Qwen `default`; `mcp__memory__*` / `mcp__search__*` present; `vesta-orch` active; `/permission` shows the 3-tier table; `:8790` untouched.

## Phase A — voice into the session

1. Host plugin `packages/vesta/vesta-voice/` (`@deepseek-ai/dsh-vesta-voice`): config `livekitUrl`, `apiKeyRef`/`apiSecretRef` (credential references), `bridgePath`, `mediaUrl`, `tokenTtlSeconds`, `roomPrefix`. Routes on the authenticated `/api` channel: `GET /api/vesta/voice/token?sessionId=` (LiveKit JWT for room `dsh-<sessionId>`), `GET/POST /api/vesta/voice/emotion` (proxy to the STT sidecar's `/config`). Bridge: `ctx.webServer.registerUpgrade('/vesta/voice/bridge')`; each agent job dials it with `Authorization: Bearer <LiveKit secret>` and `X-Vesta-Room`; the Host resolves/resumes the Session's Agent (`ctx.sessionController.resolveAgent`), registers the spoken-mode section on `agent.ctx.systemPrompt`, relays `agent/assistant-stream` `text-delta` chunks as `speak`, `tool/call` as `status`, `turn/end` as `done`; `turn` → `sessionController.prompt` (`queue` when idle, `steer` when running); `interrupt` → `sessionController.cancel` (inbox kept). ✅ written 2026-09-05
2. Client plugin `packages/client/ui-vesta-voice/`: mic button (`conversation.input.right`, order 40) and call HUD (`conversation.input.overlay`, order 2) over one store; `VoiceCallController` owns the LiveKit `Room` (token fetch, mic, agent audio, `lk.agent.state`, audio level → orb, perception toggle). `livekit-client` bundled privately; copy in the `vesta.voice` dictionary. ✅ written 2026-09-05
3. Agent worker moved into the fork (`services/livekit-agent/agent.py`): `DSH_BRIDGE_URL` set + room `dsh-*` → `DshBridgeLLM` (a LiveKit `LLM` whose stream is the bridge's `speak` deltas, with `SpokenTextFilter` dropping fenced code from speech and stripping inline markdown); otherwise direct Qwen-via-LiteLLM as before (the standalone `:8480` UI keeps working). Barge-in cancels the LiveKit stream → `interrupt`. Compose (`deploy/vesta/livekit-voice.docker-compose.yml`): agent on `network_mode: host`, build context = the checkout, STT sidecar published `127.0.0.1:8011`. ✅ written 2026-09-05
- Verify (server side, 2026-09-05): deployed on vesta — harness rebuilt with the plugin (bridge route answers 401 to a bad bearer), agent image rebuilt from the checkout on host networking and registered with the SFU, STT sidecar on `127.0.0.1:8011`. `deploy/vesta/bin/vesta-bridge-check` run inside the agent container against a real session: `ready` → `turn` → reply streamed as `speak` frames → `done` ("Hello there! I've got a memory set that reads, writes, searches… plus a search set…"), ~2.7 s wall for a one-liner. ✅
- First user test (2026-09-05 12:13 UTC) failed: the call HUD was registered in `conversation.input.overlay`, whose anchor is a zero-height absolute box at the composer card's top edge, so the HUD flowed over the text input ("UI quite broken"); the user re-clicked three times in 15 s, and the agent session had closed on the first participant's disconnect (`close_on_disconnect` default), leaving the room agentless. Fixes: HUD positioned absolutely above the card (as the slash menu does), `RoomInputOptions(close_on_disconnect=False)`, a failed start now leaves the room, `BRIDGE_GREETING` spoken cue. The browser did publish a microphone track on every join, so mic permission and the SFU path were fine.
- Verify (synthetic caller, 2026-09-05): `deploy/vesta/bin/vesta-call-check` run inside the agent container (joins the room as a STANDARD participant, plays a Kyutai-synthesized question, reports `lk.agent.state` transitions and audio received back). Result: STT transcribed the played question exactly ("Hello, Vesta, what is 2 plus 2 answer in a few words."), agent `thinking → speaking → listening`, 51 s of agent audio received (cue + answer), bridge bound. HUD verified rendered above the composer (screenshot via the tunnel with a stubbed microphone). Two-round probe: first reply ~15 s after the question ended (binding the call registers the spoken-mode section, so the first turn pays a full prompt prefill), second turn **3.9 s** (STT → harness → Qwen → first Kyutai audio). ✅
- Latency levers, next: (a) deliver the spoken-mode guidance as a per-turn injected context instead of a prompt section so the request prefix stays cache-stable across call start/end; (b) per-session `reasoningEffort: off` during calls via `sessionController.selectModel` once the `vesta` provider declares `compat.thinkingFormat: qwen-chat-template` + `chatTemplateKwargs.enable_thinking: { $var: thinking.enabled }` (pi-ai resolves the placeholder from the effective level); (c) `BRIDGE_GREETING` masks part of the first-turn wait.
- Verify (browser, pending the user): press mic in a session, ask about the workspace → user turn in the chat, tool cards render, answer spoken; interrupt cancels; typed follow-up works; `[stt]` + bridge logs show timings; the 3090 untouched. ⏳

## Phase B — autonomy and approvals by voice

1. Spoken approvals: answerer on `approval/request` for bound sessions, racing the spoken yes/no against the on-screen card (`next()`); first decision wins.
2. Voice commands → `ctx.commands`: "switch to safe / workspace / full mode" (`/permission …`), "stop".
3. `vesta-voice` agent preset (spoken-assistant persona, same tools) alongside `vesta-orch`.

## Phase C — cutover and consolidation

1. serve `:8790` → `127.0.0.1:3081`; old `dsh-web` stopped but installed.
2. Retire the standalone `:8480` voice UI (stop `livekit-webui`, keep image/dir); `:8481` SFU stays.
3. Move voice service sources (`agent/`, `media/`) under `services/`; point the compose build contexts there.
4. Upstream sync drill.

## Rollback

`:8790` keeps pointing at the untouched rc.7 `dsh-web` until Phase C; the `:8480/:8481` voice stack is unchanged until Phase C; the agent bridge is env-flagged. Nothing is deleted; `~/.dsh` is never written.

## Log

- 2026-09-04 — Fork cloned (`d347e70`), `vesta` branch created locally and on vesta, `pnpm install` green on both. Scaffolded the three Vesta packages, the bundle, fonts, deploy tree; aggregate references added.
- 2026-09-05 — Local `pnpm run build` green (230 client artifacts). `dsh --profile vesta --dump-config` lists the Vesta rows after `dsh-web-app`. Booted locally on `:3082` against a scratch home: ember token layer applied (`--dsw-alias-bg-base: #07080c`), all three self-hosted fonts loaded, sidebar orb + "Vesta Harness" wordmark, hero orb, `vesta-orch` preset (ported, `+command-goal`) resolves as "Vesta Orchestrator"; no console errors. Note: 0.1.3 prints a tokenized startup URL; the browser exchanges it once for a persistent signed cookie (`journalctl --user -u vesta-harness` shows the URL after each start). Stock DeepSeek API-key onboarding modal shows once ("Configure later").
- 2026-09-05 — Deployed on vesta: `pnpm run build` green from the checkout, home `~/.vesta-harness` created from `deploy/vesta` (credentials copied with `install -m 600`), unit `vesta-harness` active on `127.0.0.1:3081`, `tailscale serve :8791 → 3081`. Verified through the tailnet with curl: `?token=` → 303 + signed cookie, index 200 with the boot payload listing `ui-vesta-theme` / `ui-vesta-brand`, shell asset and `/vesta/fonts/*` 200; boot journal quiet. Old install untouched (`dsh-web` active, `:3080` → 200, `:8790` unchanged). Plugin bundles are served as combos (`/plugins/??<id>,<id>…`), not per-entry paths.
- 2026-09-05 — Live deployment exercised through an SSH tunnel (browser) and the new `vesta-headless` profile (CLI): theme/brand/fonts render, hero shows "Vesta Orchestrator"; Qwen `default` answered "pong" via the `vesta` LiteLLM provider in ~14 s including boot; the agent lists all 11 MCP tools (`mcp__memory__{delete,list,read,search,status,write}`, `mcp__search__{fetch_url,news_search,search_and_fetch,search_status,web_search}`). Phase 0 verification complete; only the Landlock native build (sudo `musl-tools`) is outstanding.
