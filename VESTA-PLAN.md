# Vesta Harness — plan and status log

Living document: agents working on this fork update the status table and the log as they go. Decisions live in [`VESTA.md`](VESTA.md); ops in [`deploy/vesta/README.md`](deploy/vesta/README.md).

## Status

| Phase | Goal | State |
|---|---|---|
| 0 | Fork online on vesta, styled, text-only: `vesta` profile, ember theme, Vesta brand, MCP rows; side-by-side on `:3081` / serve `:8791` | done 2026-09-05 (Landlock sandbox binary pending `musl-tools`) |
| A | Voice into the session: host bridge plugin, mic + call HUD, Python agent bridge (feature-flagged) | pending |
| B | Autonomy and approvals by voice; spoken-mode persona preset | pending |
| C | Cutover `:8790`, retire the standalone `:8480` voice UI, move voice service sources into `services/`, upstream sync drill | pending |

Upstream base: `deepseek-ai/deepseek-harness@d347e70` (`dsh-v0.1.3-alpha.1`), forked 2026-09-04.

## Target architecture

You open any session in Vesta Harness, press the mic, and talk. What you say lands in that same session as a normal user turn; Qwen 27B does the agentic work with the session's tools (bash, fs, search, MCP memory/search, subagents) at the session's autonomy level; you see the tool cards on screen and hear the answer (Kyutai "calm" @1.2). Text and voice interleave in one transcript. Approvals can be answered on screen or by voice.

```
Browser (Vesta Harness UI) ──mic──▶ LiveKit SFU (:8481) ──▶ livekit-agent (Python: VAD/turn, SenseVoice STT+emotion, Kyutai TTS)  [3060 only]
        ▲  fetch /api/vesta/voice/token                                        │  WS bridge, loopback 127.0.0.1:8490
        │                                                                      ▼
Vesta Harness host  `dsh --profile vesta`  (127.0.0.1:3081, serve :8791 → later :8790)
  ├─ dsh-vesta-voice (host): room ↔ session binding, submits the transcript into the session,
  │    streams assistant text back to be spoken, relays approvals, "spoken mode" prompt section
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

1. Host plugin `packages/vesta/voice/` (`@deepseek-ai/dsh-vesta-voice`): config `bridgeUrl`, `livekitUrl`, credentials `LIVEKIT_API_KEY/SECRET` via `ctx.credentials`, `narrateTools`, `greeting`. Token route `registerFetchRoute('/api/vesta/voice/token')` → LiveKit JWT for room `dsh-<sessionId>`. Bridge client: reconnecting WS; `turn{room,text,meta}` → submit via `ctx.sessionController` prompt (`source:{kind:'user'}`); `session/event` → `assistant/chunk`→`speak`, `tool/call`→`status`, `turn/end`→`done`; `interrupt{room}` → `agent.cancel(cause, {keepInbox:true})`. Spoken-mode prompt section registered through `agent.ctx` while a room is bound.
2. Client plugin `packages/client/ui-vesta-voice/`: mic button in `conversation.input.right`, call HUD in `conversation.input.overlay` (orb, state chip from `lk.agent.state`, mute, hide-emotions, end call); `livekit-client` bundled privately; copy in a locale dictionary.
3. Python agent (`/srv/ai/compose/livekit-voice/agent/agent.py`), feature-flagged `DSH_BRIDGE_PORT=8490` (unset = today's direct-LiteLLM behaviour): WS server published `127.0.0.1:8490:8490`; custom `llm_node` streams `speak` deltas from the bridge; sentence-chunking to Kyutai; TTS sanitizer; barge-in → `interrupt`; room name → session binding.
- Verify: press mic in a session, ask about the workspace → user turn in the chat, tool cards render, answer spoken; interrupt cancels; typed follow-up works; bridge + `[stt]` logs show timings; the 3090 untouched.

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
