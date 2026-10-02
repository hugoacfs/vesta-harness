# Egress appraisal — does the harness talk to anyone it should not?

Hugo asked (2026-10-02) for "a proper appraisal to check no telemetry or any sort of dodgy calls are being made out of it to DeepSeek's servers". This is the record: what was examined, what was measured on vesta, what was changed, what remains. Measured-here facts are marked; nothing below is taken from upstream's documentation alone.

## Verdict

One real finding. `dsh-base` loads `session-telemetry-otel` in `FEEDBACK_ONLY` mode with its exporter pointed at DeepSeek's collector, `https://harness-telemetry.deepseeksvc.com/v1/logs` (`packages/bundle/base/cordis.patch.yml`, env `DSH_TELEMETRY_OTLP_URL` / `DSH_TELEMETRY_MODE`). In that mode a thumbs rating on a message or the `/feedback` command captures the **whole session history** and queues it for upload, tagged with an anonymous user id the plugin writes to `$DSH_HOME/.anonymous-user-id` at first boot. Nothing is sent without feedback. Measured here: no `feedback/record` or `feedback/message-put` event exists in any session log of either home (0 files), and in two traced runs that recorded feedback on a staging test session (one before the fix, one after) the process never connected to the collector's addresses. So no session has left vesta this way — but the configuration allowed it, and the thumbs buttons are on every message. Fixed on staging the same day (below); production carries the old configuration until the promotion.

Everything else that can reach the network is either local by design, dormant (loaded but without a model, key or tool to use it), or user intent (the model's shell tool reaches the internet).

## Method

1. **Static.** Every literal host in `packages/*/*/src`, `apps/*/src`, `apps/web/index.html`, `apps/web/public` (tests excluded); every network primitive (`fetch`, `undici`, `http(s).request`, `WebSocket`, `net.connect`, `sendBeacon`, `dgram`); every host in yml/json/env files outside docs; the telemetry and update knobs (`DSH_TELEMETRY_*`, `DSH_DESKTOP_UPDATE_*`).
2. **Composition.** The 190 rows the Vesta web profile composes (`bundle/base`, `bundle/web-app`, `bundle/vesta-app`, `deploy/vesta/home-cordis.patch.yml`, the profile patch, the staging patch), each crossed with the static list: loaded, disabled, or absent.
3. **Dynamic (staging, 2026-10-02).** `strace -f -e trace=connect` on the staging harness's whole process tree while a test session ran a shell tool call (`curl https://example.com`) and then a `/feedback` record; `ss -tnp` sampled every 0.5 s for the first 30 s after a restart (boot-time egress). Addresses resolved on vesta the same hour.
4. **Build time.** Lifecycle scripts among installed dependencies and pnpm's `allowBuilds` policy.

## Findings

| # | Capability | In the Vesta profile? | Destination | Status |
|---|---|---|---|---|
| 1 | `session-telemetry-otel` (dsh-base row, `FEEDBACK_ONLY`) | loaded | `harness-telemetry.deepseeksvc.com:443` (from vesta: 120.53.70.166, 120.53.78.102, 43.137.64.240) | **Finding.** Fixed on staging: bundle row `mode: DISABLED` + `Environment=DSH_TELEMETRY_DISABLED=1` in both unit templates (`32e1172f5b`). Production: pending promotion |
| 2 | `anonymous-user-id` (written by #1 at first boot) | file present in both homes since 5–6 Sep | none itself | staging file moved to `~/trash/anonymous-user-id-20261002/`; not recreated under `DISABLED`; production file to move at promotion |
| 3 | `llm-deepseek` (DeepSeek provider, file upload client) | loaded | `api.deepseek.com` | dormant: `llm-deepseek: models: []` in settings, no DeepSeek credential (0 records in `.credentials.yaml`), the only provider offered is `vesta` → LiteLLM `192.168.0.2:4000` |
| 4 | `web-search-deepseek` + `web` (`searchProvider: deepseek-official`) + `web-fetch-http` | loaded | `api.deepseek.com/anthropic/v1`, any URL | dormant: `tool-web` is `disabled: true`, `DEEPSEEK_API_KEY` unset; the model's search is the local MCP `127.0.0.1:7333` |
| 5 | `message-feedback`, `command-feedback` (thumbs, `/feedback`) | loaded | none (session log) | local; with #1 disabled they stay local |
| 6 | `plugin-package-inventory-deepseek` | loaded | none (`file:` URLs) | local inventory of installed packages |
| 7 | `agent-default-model` fallback entry `deepseek-official/deepseek-flash` (dsh-base) | loaded | DeepSeek, only if `settings.yaml` were lost | replaced by `vesta/default` in the bundle row (`4a2dde7b22`, same day) |
| 8 | `apps/desktop` (update checks `download.deepseek.com`, Feishu login) | not part of the web profile | — | not built or run on vesta |
| 9 | LiteLLM, MCPs (memory, search, vision, pdf, Home Assistant `127.0.0.1:8123`, Telegram notifier `127.0.0.1:7335`), Mac tunnel `127.0.0.1:2222` | loaded | LAN / loopback | by design. The Telegram notifier's own hop to Telegram happens in its container, not in the harness |
| 10 | Web Push (`vesta-notify`) | loaded | Apple/Google/Mozilla/Windows push endpoints, allowlisted | by design; only when a phone has subscribed and an alert fires |
| 11 | Model tools (`bash`, terminal, SSH) | loaded | anywhere | user intent; measured: the shell tool's `curl https://example.com` returned 200. No fence exists today (see below) |
| 12 | Web client bundle (`apps/web/dist`) | served | hosts in the bundle are SVG namespaces (`www.w3.org`) and icon-library attribution strings | no third-party script, CDN, font or analytics; `sw.js` has no fetch handler; fonts served locally |
| 13 | Build time | — | `registry.npmjs.org`; lifecycle scripts allowed by `pnpm-workspace.yaml` `allowBuilds`: esbuild, lefthook, node-pty, koffi, the workspace postinstall; denied: @google/genai, protobufjs, node-addon-require-builtin, electron-winstaller | expected |

## Dynamic results (staging, measured)

- Boot: 300 `ss` samples over 30 s after a restart, every peer `127.0.0.1` (the MCP servers). No external peer.
- Session turn with the shell tool + `/feedback` record, `strace` on the process tree, both before and after the fix: peers `192.168.0.2` ×2 (LiteLLM), `127.0.0.1` ×2 (MCP), `127.0.0.53` ×1 (DNS for curl), `104.20.23.154` and `172.66.147.243` (= `example.com`, the curl in the tool). Never any of the collector's three addresses. Denied connects: 0 (no fence was active in the end — see below).
- The plugin's `DISABLED` branch logs "OpenTelemetry session upload is DISABLED" on feedback; that line did not appear in the journal (the harness logger's routing was not chased). The configuration is verified by `verify-cordis-config` (214 files) and by the trace.

## What did not work, and the fence question

- nftables `socket cgroupv2` matching on the unit's cgroup counted 0 packets while traffic flowed (not debugged; table removed).
- systemd `IPAddressDeny=any` + `IPAddressAllow=` on the **user** unit is accepted but not enforced: the journal says "unit configures an IP firewall, but not running as root" (properties reverted).
- Hugo's rule (same day): MCPs and the shell tools keep the internet; the harness process itself must not reach home. Built as D26: a Node preload (`egress-gate.mjs`) hooking `net.Socket.prototype.connect` in the harness process only — allowlist loopback, LAN, tailnet, push services; `EGRESS_DENIED` before any DNS lookup; one journal line per destination per minute; the module strips itself from `NODE_OPTIONS` so children are untouched. Verified on staging with `verify/egress-gate-verify.sh` (raw socket, `http.get`, `fetch` refused; loopback reaches the stack; child ungated) and the regular exercise (LiteLLM, MCPs, the shell tool's `curl` → 200, the Mac SSH provider) with zero denials.

## Changes made (staging only, 2026-10-02)

- `packages/bundle/vesta-app/cordis.patch.yml`: row `session-telemetry-otel` with `mode: DISABLED`; dependency declared; `deploy/vesta/vesta-harness.service` and `vesta-harness-staging.service`: `Environment=DSH_TELEMETRY_DISABLED=1`. Live staging unit file edited the same way (backup `~/backups/vesta-harness-staging.service.bak-before-telemetry-off-*`).
- `strace` 6.8 installed on vesta (apt), kept.
- Promotion checklist: fast-forward `vesta`, `vesta-build`, add the `Environment` line to `~/.config/systemd/user/vesta-harness.service` (template copy), `daemon-reload`, restart with no session active, move `~/.vesta-harness/.anonymous-user-id` to `~/trash/anonymous-user-id-20261002/`, confirm it is not recreated.

## Re-check on an upstream sync

Repeat the static sweep's two greps (hosts; primitives), diff the composition rows for new `telemetry`, `feedback`, `identity`, `update` or `deepseek` plugins, and keep the bundle row + unit env. The base row's exporter URL and mode come from env with DeepSeek defaults, so the fork must keep setting `DISABLED` explicitly.
