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
- **D6 Autonomy.** DSH's own two per-session selectors: agent preset (tools + persona) × permission preset (`read-only` + ask, `workspace-write` + ask, `danger-full-access` + never — the upstream table). Default stays `danger-full-access`; switch per session in the UI or by voice.

## Upstream sync

```sh
git fetch upstream
git checkout master && git merge --ff-only upstream/master && git push origin master
git checkout vesta && git merge master        # resolve: tsconfig.*.json refs, apps/cli/package.json, tsconfig.base.json paths
pnpm install && pnpm run gen-tsconfig-paths && pnpm run build
```

Record the merged upstream SHA in `VESTA-PLAN.md`.
