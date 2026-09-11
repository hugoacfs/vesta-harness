# Vesta Harness

Vesta Harness is a private fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) for the vesta server: the stock agent harness — tools, bash, filesystem, MCP, subagents, agent presets, permission presets, sessions — plus a **voice modality** (LiveKit + SenseVoice + Kyutai, RTX 3060 only) and the **Vesta ember look**. Qwen 27B (via LiteLLM) stays the brain. Built on DeepSeek Harness; "DeepSeek Harness" is not used as this project's name (see `BRAND_GUIDELINES.md`).

The living plan and status log is [`VESTA-PLAN.md`](VESTA-PLAN.md). The ops runbook is [`deploy/vesta/README.md`](deploy/vesta/README.md).

## What is ours

Everything Vesta is additive — new packages, one bundle, one profile, and a deploy tree — so upstream syncs stay tractable:

| Path | Package | Role |
|---|---|---|
| `packages/bundle/vesta-app/` | `@deepseek-ai/dsh-vesta-app` | the Vesta patch layer over `dsh-web-app`: brand + theme rows, vesta MCP servers |
| `packages/client/ui-vesta-theme/` | `@deepseek-ai/dsh-client-ui-vesta-theme` | ember `--dsw-*` token layer, self-hosted fonts, ambient ground |
| `packages/client/ui-vesta-brand/` | `@deepseek-ai/dsh-client-ui-vesta-brand` | sidebar mark + name, hero orb |
| `packages/vesta/vesta-voice/` | `@deepseek-ai/dsh-vesta-voice` | host voice bridge: LiveKit token + perception routes, the agent bridge upgrade route, room ↔ Session binding, spoken-mode prompt section |
| `packages/client/ui-vesta-voice/` | `@deepseek-ai/dsh-client-ui-vesta-voice` | mic button in the composer + call HUD (orb, state, mute, perception, end) |
| `services/livekit-agent/` | — | the LiveKit agent worker (Python): STT/TTS via sidecars, bridge-mode brain = the Harness Session, direct mode = Qwen via LiteLLM |
| `apps/web/public/vesta/` | — | self-hosted font files (SIL OFL 1.1) |
| `deploy/vesta/` | — | profile template, settings template, agent presets, systemd unit, runbook |

Upstream files we touch, all mechanical registration edits: `tsconfig.client.json` and `tsconfig.host.json` (project references), `apps/cli/package.json` (the bundle dependency so a profile can resolve it from the installation), and the generated `tsconfig.base.json` paths (`pnpm run gen-tsconfig-paths`).

## Decisions

- **D1 Bridge topology.** The proven Python LiveKit agent stays. LiveKit runs each room's job in its own process, so the direction is agent → Harness: every job dials the Host's `/vesta/voice/bridge` WebSocket upgrade route on `127.0.0.1:3081` (bearer = the LiveKit API secret, `X-Vesta-Room` = the room), and the agent container runs on the host network to reach loopback. DSH stays bound to `127.0.0.1`; no new listeners; nothing on `0.0.0.0`. An all-Node `@livekit/agents` in-process agent is a later option, not now.
- **D2 Fork discipline.** Upstream packages are never edited; Vesta is new packages + one bundle + one profile. `master` tracks upstream, work happens on `vesta`, syncs are deliberate `git merge upstream/master` at pinned SHAs.
- **D3 Naming.** Vesta packages use the `@deepseek-ai/dsh-` prefix (`private: true`, never published) so the repository's tooling — paths generator, client scan, bundle resolution — works unmodified. Product name: "Vesta Harness — built on DeepSeek Harness".
- **D4 Deployment.** Fresh Harness home `~/.vesta-harness` (rc.7 on-disk formats are not readable by current builds); side-by-side on `:3081` / serve `:8791`; cutover of `:8790` only when approved. The rc.7 `dsh-web` unit stays installed as the rollback.
- **D5 Upstream gates.** Vesta packages satisfy what the build and boot need (manifest `dsh` fields, tsconfig references, bundle rows) plus `typecheck` and targeted tests. The full upstream documentation, bilingual, coverage, and snapshot gates are not applied to Vesta packages. GitHub Actions should stay disabled on the fork.
- **D4 amendment (2026-09-05).** Cutover done: `:8790` → `127.0.0.1:3081`, `dsh-web` disabled, `:8791` off, standalone voice UI `:8480` retired behind the compose profile `legacy`; both voice services build from `services/` in this checkout. Rollback commands in `deploy/vesta/README.md`.
- **D4 amendment (2026-09-07).** rc.7 fully removed at the user's request (only production and staging remain): `dsh-web` stopped, disabled and its unit file deleted, `:8791` serve off. Backups in `~/backups`; `~/code/dsh` and `~/.dsh` left inert on disk (the fork depends on neither). Resurrection steps in `deploy/vesta/README.md`.
- **D4 amendment (2026-09-10).** Sub-path serving: both harnesses are reached under the shared `:443` host (`/harness/`, `/harness-staging/`) through the `reverse-proxy` nginx; the dedicated Serve listeners `:8790`/`:8792` are off. Mechanism: `DSH_BASE_PATH` (systemd drop-ins) → `<base href>` from `frontend-static`, base-relative Host calls in the clients, prefixed plugin bundle URLs, rewritten font URLs; root serving stays the default when the variable is empty. Runbook: “Sub-path move”.
- **D6 Autonomy.** DSH's own two per-session selectors: agent preset (tools + persona) × permission preset (`read-only` + ask, `workspace-write` + ask, `danger-full-access` + never — the upstream table). Default stays `danger-full-access`; switch per session in the UI or by voice ("switch to safe / workspace / full access mode" → `permissionPresets.set`, never a model tool). Approvals ask aloud and on screen at once; the first answer wins (Phase B).
- **D9 Notifications (2026-09-11).** The harness reaches the user through the send-only Telegram MCP only, never a bot token of its own: `vesta-notify` reports finished long turns and waiting approvals or questions while no browser tab is visible (`ui-vesta-presence` heartbeat), rate-limited and with quiet hours. Anything that could read from Telegram stays out of the harness.
- **D8 Default preset (2026-09-09).** `vesta-default` — a lean single agent (no delegation or workflows, no DeepSeek web search; web lookups through the on-box search MCP) — is the default preset; `vesta-orch` remains for fan-out and `vesta-voice` for calls. Machine-dependent MCP mounts live in `$DSH_HOME/cordis.patch.yml` (versioned as `deploy/vesta/home-cordis.patch.yml`; today the Telegram notifier); memory and search stay in the bundle and are mounted once (a duplicate `vesta-search` row was removed 2026-09-11).

## Upstream sync

```sh
git fetch upstream
git checkout master && git merge --ff-only upstream/master && git push origin master
git checkout vesta && git merge master        # resolve: tsconfig.*.json refs, apps/cli/package.json, tsconfig.base.json paths
pnpm install && pnpm run gen-tsconfig-paths && pnpm run build
```

Record the merged upstream SHA in `VESTA-PLAN.md`.

**Sync record.** 2026-09-11 — `upstream/master` `c291e7961a` (0.1.5-rc.2 + 139) merged as `08ccc0210a`; `master` = `c291e7961a`. Lessons kept for the next one: create the merge commit in a checkout whose `node_modules` match the merged lockfile (the pre-commit hook bundles client packages); re-derive the presets from upstream's `standard` (this time a `present` row appeared and the persona config renamed `text` → `prefix`); build with `deploy/vesta/bin/vesta-build`, which sets the build-time `DSH_CLIENT_TITLE`; tar both homes' sessions first, because the session format moves (v2 → v3, migrated lazily on open, the old file retained).

## Fork patches to upstream packages

D2 says upstream packages are never edited; these are the deliberate exceptions, each with its retire condition. Re-apply or retire them on every upstream sync.

| File | Why | Retire when |
|---|---|---|
| `packages/util/values/src/index.ts` (+ `tests/intrinsic-constructor.spec.ts`) | `hasIntrinsicConstructor` compared `Function.prototype.toString(Object)` with one exact V8 string; SpiderMonkey/JavaScriptCore render native source across lines, so in Firefox and Safari every plain object failed the lossless-JSON check and every assistant stream chunk was rejected (blank transcripts, "Assistant stream raw chunk must be a lossless JSON object"). The check now matches the native-source shape. | upstream ships an engine-independent check (report it upstream; `packages/core/tools/src/json-schema.ts`, `packages/extensions/cordis-host-runner/src/guard.ts`, and `packages/code-runtime/code-runtime-worker-thread/src/worker-json.ts` carry the same comparison but run only under Node/V8) |
| `packages/host/frontend-static/src/index.ts`, `packages/client/connection/src/browser-auth.ts`, `packages/client/connection/src/client/rpc.ts`, `packages/api/gateway/src/client/stream-client.ts`, `packages/client/hmr/src/client/index.ts`, `packages/client/file-upload/src/client/runtime.ts`, `packages/client/modules/src/index.ts` | Sub-path serving (2026-09-10, commits `a9ea2fd9fb`..`a044d22f9f`): `DSH_BASE_PATH` → `<base href>`, base-relative Host/RPC/stream/HMR/upload URLs, post-login redirect to the mount path, prefixed plugin bundle URLs matched raw-or-prefixed. Empty variable = upstream behaviour. Recorded here 2026-09-11; not upstreamed. | upstream serves under a reverse-proxy base path natively (report it upstream) |
| `packages/client/ui-open-in-app/src/client/controller.ts` | Sub-path serving, continued after the 2026-09-11 upstream sync: upstream's new open-in-app probe built `/open-in-app/apps` and `/open-in-app/open` from `location.origin`, so under `/harness/` the probe hit the origin root and 404'd on every page load. Same treatment as the other base-path files: prefer `document.baseURI`, join the routes base-relative. | upstream serves under a reverse-proxy base path natively |
| `packages/client/ui-settings/src/client/index.ts` | Upstream keeps every settings scope process-local (`memory`) for a browser that is not on a loopback hostname, so from the tailnet the Settings UI never persisted and the one-time welcome notice reappeared on every load. The fork adds a build-time opt-in, `DSH_CLIENT_SETTINGS_PERSISTENCE=host` (set by `deploy/vesta/bin/vesta-build`), for this single-user, cookie-authenticated deployment; unset = upstream behaviour. | upstream lets a trusted authority persist settings (report it upstream) |
| `apps/web/index.html` (title), `apps/web/public/{favicon.svg,manifest.webmanifest}`, `apps/web/public/vesta/fonts/*` (+ `OFL-NOTICE.txt`), `apps/cli/package.json` (the `dsh-vesta-app` bundle dependency) | App-shell branding and the bundle wiring; there is no plugin hook for the tab title, favicon or manifest, and the fonts are static assets. | never for the assets; the dependency line is part of D3's wiring |

**D7 Staging instance (2026-09-06).** A second Harness (`~/code/vesta-harness-staging`, branch `staging`, home `~/.vesta-harness-staging`, unit `vesta-harness-staging`, `127.0.0.1:3082` → `https://vesta.tail22b555.ts.net/harness-staging/`) runs beside production for bleeding-edge work. Isolation: separate home, sessions, settings, unit, port and room prefix (`dshs-`); a separate voice worker (production accepts only `dsh-`, staging only `dshs-`). **livekit-server 1.13.6 does not re-offer a rejected job to another worker, so exactly one unnamed worker runs per SFU: production is the sole unnamed worker on automatic dispatch, and staging runs named (`vesta-staging`), out of the auto pool** — it needs explicit AgentDispatch to serve calls (two unnamed workers raced and took prod voice down on 2026-09-07; fixed by naming staging). Token-based named dispatch stays unusable on 1.13.6. Shared on purpose: the SFU, `moshi-server`, the media sidecar, LiteLLM, the 3060. Promotion is a merge of `staging` into `vesta` followed by the production update; rollback is stopping the staging unit and container. Ports: production 3081 → `/harness/`, staging 3082 → `/harness-staging/` (dedicated Serve listeners `:8790`/`:8792` until 2026-09-10; rc.7 3080/`:8791` removed 2026-09-07).
