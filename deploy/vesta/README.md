# Vesta Harness on vesta — ops runbook

Everything here runs as `hugo` on vesta from the source checkout `~/code/vesta-harness` (branch `vesta`), with a **fresh Harness home** `~/.vesta-harness`. Since 2026-09-10 the harness is served under a sub-path of the shared tailnet host: **`https://vesta.tail22b555.ts.net/harness/`** (production) and `/harness-staging/` (staging); the dedicated Serve listeners `:8790`/`:8792` used from the 2026-09-05 cutover until then are off (see “Sub-path move” below). The old rc.7 install (`~/code/dsh`, `~/.dsh`, unit `dsh-web`) was removed on 2026-09-07 at the user's request — only production and staging run now; its code and home are left inert on disk and its sessions are backed up in `~/backups` (see “Cutover … and rc.7 removal” below).

## Server documentation

This runbook covers the harness only. The server it runs on (stacks, ports, GPUs, exposure, change history) is documented in the canonical docs repo `~/vesta-docs` on vesta (`github.com/hugoacfs/vesta-docs`, published at `https://vesta.tail22b555.ts.net/docs/`); its `services/vesta-harness.md` and `services/voice.md` are the server-side views of this deployment, and its `AGENTS.md` carries the hard rules (GPU pinning, bindings, secrets). Agents inside harness sessions start from `~/workspace/dsh-chat/AGENTS.md`. Keep both in step: anything here that changes what runs or binds gets a dated entry in that README.

## Layout

| What | Where |
|---|---|
| Source checkout | `~/code/vesta-harness` (origin `hugoacfs/vesta-harness`, upstream `deepseek-ai/deepseek-harness`) |
| Harness home | `~/.vesta-harness` — `profiles/vesta/`, `settings.yaml`, `.credentials.yaml` (chmod 600), `.agent-presets/{vesta-default,vesta-orch}/`, `cordis.patch.yml` (machine-wide MCP mounts, see “Home”) |
| Service | systemd `--user` unit `vesta-harness` → `node apps/cli/lib/bin.js --profile vesta --host 127.0.0.1 --port 3081 --trusted-host vesta.tail22b555.ts.net --no-open`; drop-in `vesta-harness.service.d/basepath.conf` sets `DSH_BASE_PATH=/harness` |
| Tailnet URL | `https://vesta.tail22b555.ts.net/harness/` — the `:443` Serve listener → `reverse-proxy` nginx (`127.0.0.1:8090`), whose `/harness/` block strips the prefix and proxies to `127.0.0.1:3081` (WebSocket upgrade on, 900 s timeouts); `/dsh` → 302 `/harness/`. `/harness-staging/` → the staging instance (`127.0.0.1:3082`, see below). Reference copy of the blocks: `nginx-harness.conf`. (`:8790`/`:8792` were dedicated Serve listeners until 2026-09-10; `:8791`/rc.7 was removed 2026-09-07.) |
| Templates | this directory: `profiles/vesta/*`, `settings.yaml`, `home-cordis.patch.yml`, `agent-presets/{vesta-default,vesta-orch}/*`, `vesta-harness.service` + `vesta-harness.service.d/basepath.conf`, `vesta-harness-staging.service` + `vesta-harness-staging.service.d/basepath.conf`, `nginx-harness.conf`, `staging-cordis.patch.yml`, `fillers.yaml`, `livekit-voice.docker-compose.yml`, `moshi-server.docker-compose.yaml`, `bin/*` |

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
cp -r ~/code/vesta-harness/deploy/vesta/agent-presets/{vesta-default,vesta-orch} ~/.vesta-harness/.agent-presets/
cp ~/code/vesta-harness/deploy/vesta/home-cordis.patch.yml ~/.vesta-harness/cordis.patch.yml   # machine-wide MCP mounts (Telegram notifier)
install -m 600 ~/.dsh/.credentials.yaml ~/.vesta-harness/.credentials.yaml   # VESTA_API_KEY; never in git
```

`$DSH_HOME/cordis.patch.yml` is the machine-wide patch layer (every profile). Until the 0.1.6 sync the Loader watched this file and an edit on a running harness re-applied the plugin tree at once, aborting every running turn (production, 2026-09-12: a search-index row appended at 13:47 cut a user turn mid-compaction); **since 0.1.6 (staging 2026-09-18, production 2026-09-19) there is no watch: an edit takes effect at the next restart**, so still edit it right before the restart that follows, or with the unit stopped, and never expect a live change. It carries the host-plane mounts that depend on this box — the Telegram notifier (`ai-telegram-mcp`, loopback 7335 → `mcp__telegram-notify__notify`), the vision and PDF servers, the shell-guard hooks row, the own-history search index row and, since 2026-09-13 on staging and 2026-09-18 on production, the Home Assistant row (token in `$DSH_HOME/.env`). The versioned copy is `deploy/vesta/home-cordis.patch.yml` (production paths); keep it in step with the homes. Memory and search are mounted by the versioned `dsh-vesta-app` bundle (`mcp__memory__*`, `mcp__search__*`); do not add them here again: a second `vesta-search` row (2026-09-09..11) put every search tool twice in the model's catalogue. The default agent preset is `vesta-default` (lean single agent: no delegation, no DeepSeek web search, web lookups through the search MCP); `vesta-orch` stays for fan-out and `vesta-voice` for calls (`settings.yaml` → `agent-presets.default`).

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
- Since the 0.1.5 sync: `curl -b <jar> https://vesta.tail22b555.ts.net/harness/open-in-app/apps` → `200` (upstream's desktop hand-off probe, made base-relative in the fork); a session RPC `session/create` with each preset (`vesta-default`, `vesta-orch`, `vesta-voice`) returns a session id — a preset that fails to mount breaks new sessions AND resumes, so check it right after every update.

## Upstream base 0.1.6-alpha.2 (staging 2026-09-18, production 2026-09-19)

The fork sits on `upstream/master` `ddefc45fbc` (merge `5b51945db0`, re-fit `b488d0a4dc`, docs `28cb0acfba`; production tag `vesta-stable-2026-09-19-sync-0.1.6`; procedure, conflicts and lessons in `VESTA.md` → “Upstream sync”). What changed for operators: (1) programmatic tool calling runs in `dsh-ptc-runtime-node`, the base row `ptc-runtime` — a sandboxed Node process per program whose own file effects go through the same sandbox as `bash` (its stderr shows the `landlock-run: partial enforcement` notice) — with the fork's budgets restated on that row in the `vesta-app` bundle patch (elapsed deadline 300 s including nested tool waits, per-call cap 600 s, output 1 MiB, heap 512 MB); the `code-runtime` worker-thread row is gone; (2) the Build and Orch presets name `workflow-ptc` (`@deepseek-ai/dsh-workflow-ptc`) where they named `workflow-worker-thread` — refresh `$DSH_HOME/.agent-presets/` from `deploy/vesta/agent-presets/` at the promotion; (3) new upstream surfaces arrive on by default: a **Plugins** page in the sidebar's global list (plugin manager) and a read-only Plugins tab in Settings, a sidebar **terminal** and a sandboxed sidebar **browser**, Office-to-PDF conversion (the `@deepseek-ai/libreoffice-kit` WASM engine, about 194 MB, installed by `pnpm install`), a changed-files card under each turn, an upstream unarchive tab in Settings beside the fork's Archived panel, persistent plan cards, subagent chat in the sidebar, a context meter in the composer footer, MCP resources — all kept on at the 2026-09-19 promotion (Hugo checked staging and promoted as staged); a row can still be switched off with `disabled: true` in the bundle patch; (4) the Loader no longer watches `$DSH_HOME/cordis.patch.yml` (an edit needs a restart; `patchReload` in `profiles/vesta/package.json` is ignored); (5) session format stays v3, and pre-sync sessions open unchanged; (6) `settings.yaml` and the home patch need no change; rebuild the Landlock launcher after the build (`cd native/system && pnpm build:native`); (7) the verify scripts `m1-verify.sh`, `m4-verify.sh` and `p4-verify.sh` read the home's paths and run on the server with a server-side jar (`~/.local/bin/vesta-url staging` → `curl -c`), the rest run from the Mac; `sync-batch-check.sh` runs two Batch programs on the new runtime. Node 24 and pnpm 11.7 as before.

## Upstream base 0.1.5-rc.2 (synced 2026-09-11)

The fork now sits on `upstream/master` `c291e7961a` (merge `08ccc0210a`; procedure and lessons in `VESTA.md` → “Upstream sync”). What changed for operators: (1) build with `deploy/vesta/bin/vesta-build`; (2) presets follow upstream's `standard` composition — the persona row's config field is `prefix` (was `text`; a stale preset fails to mount with `$.prefix missing required value`), and `present` (file-delivery cards) is a bare tool row; (3) sessions are format v3, migrated lazily from v2 when opened (the v2 file stays beside the v3 one), so tar `~/.vesta-harness/sessions` before any downgrade; (4) the sidebar keeps workspaces collapsed until clicked and shows a session's title only once it has been opened (projection cache), the composer asks for a workspace before the first message, and the header's “···” menu holds the session log; (5) the tab title is `<session> — vesta harness`; (6) new upstream tools: `read_image`, `present`, and the right-hand panel with files and previews.


## Voice: retired from the harness (2026-09-24)

The voice modality built between 2026-09-05 and 2026-09-23 — a LiveKit call bound to a Session: the composer mic button and call bar (`ui-vesta-voice`), the host bridge (`vesta-voice`), the Python agent worker, the media sidecar, the two Kyutai moshi-server processes, fillers, the echo guard and the scripted caller — was removed from the fork at Hugo's request ahead of a redesign as its own project (`vesta-voice`: a standalone voice service the harness will plug into through one interface; options paper and design in `~/vesta-docs`). Nothing was destroyed.

- Code: the last commit with the voice modality is tag `vesta-voice-retired-base-2026-09-24` (`929a055802`); the removal is the commit after it on `staging`. Gone: `packages/vesta/vesta-voice`, `packages/client/ui-vesta-voice`, `services/{livekit-agent,livekit-media,moshi-server,kyutai-tts}`, the three compose files, `fillers.yaml`, the preset `vesta-voice`, the voice row of `staging-cordis.patch.yml`, `bin/{vesta-call-check,vesta-bridge-check,vesta-moshi-check.py,vesta-voice-pause-probe.py}` and `verify/voice-echo-scenarios.sh`.
- Server: the compose projects `livekit-voice` and `moshi-server` are stopped (`docker compose stop`: containers, images, model caches and `/srv/ai/compose/{livekit-voice,moshi-server,kyutai-tts}` stay on disk), `tailscale serve --https=8481` (the SFU listener) is off, the 3060 is free. Backup: `~/backups/voice-stack-retired-20260924.tgz` (the compose directories without caches, both homes' `vesta-voice` preset, the serve and compose state as text).
- Homes: at the restart that carries the removal (staging 2026-09-24; production on Hugo's word) the `vesta-voice` directory leaves `$DSH_HOME/.agent-presets/` and the `vesta-voice` row leaves `profiles/vesta/cordis.patch.yml` — a patch row for a plugin that is no longer mounted must not stay. Sessions that ran on the preset stay listed; see the plan log for what happens when one is opened.
- Rollback: check out the tag in the checkout, `vesta-build`, restore the preset directory and the profile-patch row from the backup, `cd /srv/ai/compose/moshi-server && docker compose start`, `cd /srv/ai/compose/livekit-voice && docker compose --profile staging start`, `tailscale serve --bg --https=8481 http://192.168.0.2:7880`, restart the harness.

What stays from that work: the memory-notes step message and the rule behind it (charter D19), the `vesta-companion` preset (generated from the voice preset, no dependency on it), and the lessons in the `VESTA-PLAN.md` log. Old runbook text for the stack is in the tag.

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

## Routines: standing agents on a schedule (roadmap R8–R11, 2026-09-12; v1 R1–R3 2026-09-11)

A routine is a standing agent with one hidden thread, not a job that starts blank. Host plugin `vesta-routines` (`packages/vesta/vesta-routines`, bundle patch), preset row `vesta-routine-tools` (`packages/vesta/vesta-routine-tools`, mounted by the `vesta-routine` preset in `deploy/vesta/agent-presets/vesta-routine`, copied to `$DSH_HOME/.agent-presets/` like the modes) and the **Routines** page (`packages/client/ui-vesta-routines`, the clock entry in the sidebar's panel list).

**Folders.** `$DSH_HOME/routines/<name>/` holds `routine.yaml` (the definition: `title`, five-field cron `schedule` in server local time or a one-off `at` or neither for manual and event runs, `workspace`, required `permission` tier, optional `reasoning` off|xhigh, the `brief`, `notify` always|failure|never|agent, `timeoutMinutes`, `enabled`, optional `rotateAfterRuns` and `compactAboveTokens`), `notes.md` (the agent's own notes, written through the `routine_note` tool at any tier, 16 KB cap), `runs.jsonl` (one line per run: time, run number, trigger, outcome, seconds, session, turn, seq range, summary, notified, input tokens), `thread.json` (the thread's session id, run counters, last outcome and summary, the latest compaction summary, pause, rotations) and `archive/` (rotated threads: a session tarball plus a `summary-<stamp>.md`). Examples: `deploy/vesta/routines.example/`. A v1 `$DSH_HOME/routines.yaml` is imported once at boot (`prompt` → `brief`, `mode` dropped) and renamed `routines.yaml.imported-<stamp>`; the v1 `routines.state.json` and `routines.log.jsonl` are left as they are.

**Thread.** At the first run the plugin creates the workspace if needed, creates a session on the `vesta-routine` preset (the Ops tool set plus `routine_note`, a standing-agent persona), pins its title to the routine's title and archives it in the workspace registry at once — the sidebar hides archived sessions, the Archived panel skips thread ids (`vesta-sessions` asks the `vestaRoutines` service), `vesta-notify` skips the preset. Every run first re-applies the routine's tier (`permissionPresets.set`) and reasoning (`selectModel` on the default route), so an edit on the page reaches the thread at the next run. The brief is rendered as the `vesta:routine-brief` prompt section (order 2) from the host plane for that session only, so compaction never loses it; it carries the schedule in words, the notify policy and the tier. A run is one queued `session/prompt` (request id `routine-<name>-<ms>`) whose text carries the run number, the trigger, the local time, any new information (event payload or the page's Run now `info`), the notes, and after a rotation the previous thread's compaction summary as a handover.

**Runs.** The observer matches the run's `user/message` by its request id (`source.rpcId`) and the turn opened just before it (upstream appends `turn/start` before the turn's `user/message`), collects the last assistant text and the step's `usage.inputTokens`, and ends the run at that turn's `turn/end` (completed → finished, aborted, blocked/error → failed) or at the timeout, which closes the session. Any other turn in the thread is logged too: a user prompt as trigger `chat`, a reminder the routine set itself (`schedule_*`, source plugin `schedule`) as `reminder`; neither notifies. The `Summary:` line (else the first line) becomes the run's summary; a final `NOTIFY:` line is sent to Telegram (through the notifier MCP, capped at 1000 characters, `linkBase` appended) under policy `agent`, and with the outcome under `always`; `failure` and `agent` also report timeouts and failures; `never` sends nothing. After an unattended run the routine stays busy while the plugin runs `/compact` in the thread (`commands.execute`) when the run's last request used more than `compactAboveTokens` input tokens (bundle default 24000, per-routine override), then rotates the thread after `rotateAfterRuns` runs (default 100): the session is closed, tarred into `archive/`, its directory removed and the registry told (`forgetSession`, `api-session/removed`), a `summary-<stamp>.md` written (latest compaction summary, notes, last runs), and the next run starts a fresh thread with the summary as handover. Reset on the page does the same at once. Due routines enter a FIFO (`maxConcurrent` 1); Run now goes to the front; a routine already running gets its next run queued. A run in flight when the process stops is marked `aborted` at the next boot.

**Page.** The list on the left (title, schedule in words, next run, badges running/queued/paused/disabled/problems) and the routine on the right: definition, brief, notes (Clear notes…), the latest compaction summary, the run history (time, run, trigger, outcome, duration, summary, sent), and Run now, Pause/Resume, Open thread (a normal chat with that agent; what you say is logged as a `chat` run), Edit, Reset thread…, Delete… (exports folder and thread to `~/backups/routines-deleted/<name>-<stamp>.tar.gz`, then removes both). New routine opens the form: a schedule builder (manual, every N minutes, hourly, daily, weekdays, weekly, monthly, cron, once), workspace, tier, reasoning, notify, timeout, rotation and compaction overrides, enabled, brief. Saving writes `routine.yaml`; validation errors come back inline.

Routes (cookie-authenticated, JSON): `GET /api/vesta/routines`, `GET /api/vesta/routines/detail?name=`, `POST …/save` (the definition with `name`), `POST …/delete`, `POST …/run { name, info? }` (409 only when already queued), `POST …/pause { name, paused }`, `POST …/reset`, `POST …/notes { name, text }`.

Verify without a browser: `scratchpad/r8-verify.sh` on the Mac (cookie jar via `jar.sh`) saves an `r8-smoke` routine (read-only, reasoning off, notify agent, `rotateAfterRuns: 3`, `compactAboveTokens: 100`, a brief that appends `counter: N` with `routine_note` and writes a NOTIFY line on even values), runs it four times and chats once: run 1 writes `counter: 1` and stays silent; the thread is in `archivedSessionIds` and absent from the Archived route; the session log has the brief in `system/message`, `permission/preset` read-only, our request id on the `user/message`; run 2 sends `NOTIFY: r8 smoke counter 2` and `/compact` runs (`command/run` compact in the log; a tiny thread answers "could not produce a useful summary" until it has enough history); after run 3 the thread is rotated (archive tarball + summary, `thread.json.rotations`); run 4 starts a fresh thread whose message carries the handover and the notes; the chat turn is logged as trigger `chat`, not sent; Reset rotates again; Delete exports and removes. Staging measured 2026-09-12: a read-only run with reasoning off takes 15–30 s, the request prefix of the routine preset is about 14 k input tokens.

Own-history search for threads (and every session) needs the session-query index, which the shipped composition disables (`session-query-sqlite` with `openAt: never`, so `session_search`/`session_event_search` fail with "session search is disabled in this deployment"). Each home patch now restates the row with a durable path and `openAt: first-search` (`/home/hugo/.vesta-harness-staging/session-search.db` on staging); the index opens at the first search.

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
| Companion (`vesta-companion`) | the lean set of the retired voice preset | warm and brief; memory MCP; knows the time; reminders | **read-only** / **off** | — |
| Incognito (`vesta-incognito`) | `vesta-companion` | nothing kept (see Incognito) | read-only / off | — |

`vesta-default` and `vesta-orch` stay in the roster so existing sessions resume; new sessions should use the modes. The Qwen lane declares `off`, `medium` (since T12 v2, budget 8192: the Batch level and Auto's quick depth) and `xhigh`. The tiers run under the Landlock launcher (`native/system`, partial enforcement on this kernel's Landlock ABI: writes outside the workspace are refused, `/tmp` stays writable in workspace-write); a Build session wrote and removed a file in its workspace and a Research session's `touch` was refused, with no approval prompt (2026-09-12). A preset can be switched only while the session is blank (upstream rule); a session that has produced anything keeps its tools. The soft switch is `/mode <ops|build|research|companion>` (roadmap M3, 2026-09-12): the tier and reasoning change at once, and the target mode's persona prefix (read from `$DSH_HOME/.agent-presets/<preset>/agent.cordis.yml`) is rendered as the `vesta:mode-override` prompt section right after the original persona, telling the model the new guidance replaces the old. `/mode` alone shows the current mode; Incognito refuses (`switchable: false`). Overrides persist in `$DSH_HOME/mode-overrides.json` and survive a resume. Over RPC: `commands/execute` with `{agentId, line: "/mode research", submittedAttachments: []}`; the log shows `command/run`, the new `permission/preset`, `command/done`, and the next `system/message` carries the override section.

**Auto (roadmap M5, 2026-09-12).** `agent-presets.default` is `vesta-auto` (`settings.yaml`), a placeholder preset (the Ops composition, read-only until routed) that never answers by itself. The `vesta-modes` plugin provides the `vestaPromptRouter` service; the session controller's `prompt()` (fork patch in `packages/api/session-controller/src/commands.ts`) calls it before admitting a prompt. For a blank session composed from `auto.preset` the router classifies the first message with one model call on the default route (system prompt with one line per mode from `auto.descriptions`, a rule that technical or factual questions are Research and Companion is personal talk only, four examples and the workspace path as a hint; reasoning off, temperature 0, eight tokens, `auto.timeoutMs` 8 s), swaps the session through `agentPresets.select` (upstream's blank-session switch, recorded as `agent-preset/selected` in the log before the first `turn/start`), and applies the mode's tier and reasoning. A `/mode` typed while the session is blank is honoured instead of the classifier and its soft-switch override is dropped, since the composition now is that mode. A failed classification or an unknown answer lands on `auto.fallback` (Ops); if even the switch fails the session runs as Auto, read-only. The New Session chip shows Auto, then the routed mode once the message is in. Measured on staging 2026-09-12: eight cases routed correctly (Build 70 tools with `lsp`, Ops 61, Research 51, Companion 43) in 0.45–0.6 s each after a 7.8 s cold first call; `scratchpad/m5-verify.sh` (RPC `session/create` with `agentPreset: vesta-auto`, `session/prompt`, then the log's `agent-preset/selected`, `permission/preset`, `model/selection` and `request/header.header.tools`) and `ffdrive/auto-chip-check.mjs` (New Session opens on Auto; the header reads Research after a Landlock question). A blank session left over from before the default changed keeps its old preset: New Session reuses a workspace's blank session instead of creating one.

**Programmatic tool calling and the Batch mode (roadmap T12, 2026-09-17).** Upstream's PTC lets a preset present its tools as one `run_code` transport plus a generated TypeScript SDK (`dsh-agent-tool-presentation` row, `mode: ptc` or `both`; the program ran in the host row `code-runtime`, `dsh-code-runtime-worker-thread`, budgets in the bundle patch: busy time 120 s, wall 600 s, output 1 MiB, heap 512 MB; since the 0.1.6 sync of 2026-09-18 it runs in the base row `ptc-runtime`, `dsh-ptc-runtime-node`, a sandboxed Node process — elapsed deadline 300 s, cap 600 s, output 1 MiB, heap 512 MB). A first pass put `both` into Build and measured it: the SDK for Build's ninety tools costs as much as the native schemas, so `both` doubled every request (24 k → 41 k tokens) for no gain, and `ptc` alone broke even; that row stays commented in `vesta-build` with the numbers. The second pass is **Batch** (`vesta-batch`, `preset.yml` name Batch): `ptc` presentation over a lean surface — shell, `read`, `write`, `edit`, `glob`, `grep`, the five session-search tools and `routine_note` — with a persona that plans the whole job, reduces in code and prints digests of at most forty lines; reasoning `medium` (a new level on the lane: `reasoningEfforts.medium` in `settings.yaml`, budget 8192) and the workspace-write tier from `vesta-modes`; never Auto-routed, not a `/mode` target. The lean surface comes from the host plugin `vesta-tool-restrict` (bundle patch, `presets.vesta-batch.allow`), which applies upstream's `tools.restrict` mask to each Batch agent from the agent's own scope at `agent/created` — a preset row cannot do it, because the mask filters what a scope inherits and never its own registrations and is validated from the registering scope, so from the preset's scope its own tools are unnameable while the agents below inherit them (the first attempt hid the shell and the model fell back to `node:fs` inside its programs). Two rules in `vesta-modes`: `run_code` is refused below the workspace-write tier on the `tools/pre-execute` waterfall (model code in the worker runs with the harness's own authority, outside the bash sandbox, while the tools it calls are still policed), and `/mode` refuses to move a Batch session below that tier (it would keep no usable tool). Routines may choose `preset: vesta-batch` per routine (page form and `routine.yaml`); a routine at read-only with that preset gets no tool, so pair it with workspace-write or full access.

Measured on staging 2026-09-17 (`deploy/vesta/verify/t12v2-bench.sh <preset> <label>`, five read-only tasks in the harness checkout, Build native against Batch; time to first token from the first step's stream record): first-request input 24.2 k against 10.3 k tokens; over the five tasks 607 s against 511 s, 722 k against 269 k input tokens, 210 k against 18 k characters of tool results entering the context. Per task Batch was faster on the log triage (373 s → 213 s, 8 → 4 steps), the README outline (94 s → 53 s) and the preset table (61 s → 41 s), and slower on the export listing (55 s → 116 s) and the status check (24 s → 88 s), where a shell one-liner beats writing a program; two of the twenty-three programs failed once and were fixed by the model. Reading: Batch is for batch-shaped work — routines, enumerations, log and document triage — and its real gain is context hygiene; it is not a replacement for the interactive modes. `t12-verify.sh` checks the guard; a Batch session's header shows one tool (`run_code`) and the SDK lists the fifteen bindings (twelve plus the per-agent reminder tools).

Verify a mode without a browser: create a session with `agentPreset: vesta-companion`, prompt once, and read its log — a `permission/preset` event with the configured tier, a `model/selection` event, and `request/header.config.reasoningEffort: off`. A `preset.yml` description containing a colon must be quoted, or the picker shows the id and "No description".

## Automatic memory notes (roadmap T13, 2026-09-17)

Evidence first: of 32 production sessions with a user in the three weeks before this work, 7 searched the memory store and 6 wrote to it; 19 that were plainly about Hugo or his setup never searched, and the eight Auto sessions searched zero times — memory use came only from the two older presets whose personas pushed it. The store itself (`ai-memory-mcp`, loopback 7332, notes as markdown under `/srv/ai/memory/notes/<scope>/`, git-committed, keyword search, scopes preference / fact / event / project) was designed for capture on request with approval and recall through an always-on instruction; neither reached the new modes.

Host plugin `vesta-memory-notes` (`packages/vesta/vesta-memory-notes`, bundle patch) closes both gaps. **Recall:** the modes plugin's prompt router calls it before every prompt; the message is searched in the store (`memory_search`, the best `recallLimit` notes), each note's body is read once and cached, and the result renders as the `vesta:memory-recall` prompt section (order 4) for that session with the note's age and the rule that a note conflicting with live files loses; the section only changes when the best names change. **Capture:** for eligible root sessions (every preset except `excludePresets` — Incognito, Routine, Batch — and never a child session) the plugin accumulates the turns' text (user, assistant, one line per tool call, capped at `sliceChars`); after `idleSeconds` of idleness following a turn with at least `everyTurns` user turns since the last pass, or when the session is closed or archived, one model call with reasoning off proposes at most `maxPerPass` notes as JSON using the store's own rules (preferences, decisions with reasons, stable facts, corrections, dated events; never task state, implementation detail or secrets). Each candidate above `minConfidence` is checked with `memory_search`: a hit with the same name or a description overlapping by 60 % is updated by appending a dated `**Update (auto-captured)**` line to its body; otherwise a new note is written with a `**Source:** auto-captured` line. Caps per session and per day apply; every action (created, updated, skipped, capped, failed, error) is one line in `$DSH_HOME/memory-notes.log.jsonl`. `/memory` shows the session's capture state, what is recalled now and the last ten automatic notes; `/memory now` runs a pass; `/memory off|on` pauses the session; `/memory forget <name>` deletes a note (the store's git history keeps it). The store is shared by production and staging, so a staging test writes real notes — the verify script marks its facts `t13test` and deletes them at the end.

Verify: `deploy/vesta/verify/t13-verify.sh` — four turns in an Ops session with two durable statements, an idle wait, the log and the store searched; a new session asks the preference back and its first `system/message` carries the recall section; the same statements again in a third session produce updates rather than duplicates; an Incognito session with a fact produces no log entry; `/memory` answers; the test notes are deleted. Result on staging (2026-09-17): the capture pass wrote the two statements as `config-backup-suffix` (preference, confidence 1.0) and `printer-bramble-location` (fact, 1.0) after the idle wait; when Hugo's phrasing made the model save the facts itself through `memory_write`, the pass recognised its own session's writes and skipped them instead of appending; the next session's first `system/message` carried the recall section with exactly the one relevant note and the answer used it (unrelated notes stay out through the score floor); an Incognito session with a fact produced no log line; `/memory` reported the state; the test notes were deleted, the store is back to its 23 notes. The zero-candidate case now logs the model's raw answer, because one pass proposed nothing and could not be explained.

## Engine fit (2026-09-17): one core, tool groups on demand, quick or deep, Batch for routines

The harness is built around one engine, Qwen 27B on vLLM: generating tokens is the expensive part (the prompt prefix is cached), the model dulls as the context fills, and deep thinking on every step is the largest hidden cost. Four changes follow from that, all in the bundle patch and the presets, verified on staging with `deploy/vesta/verify/engine-fit-verify.sh` and measured with `efficiency-bench.sh <preset> <label> [warm-only]` (eight fixed tasks: log triage, export listing, README outline, preset table, status check, and three interactive turns).

- **E1 One persona core.** `vesta-modes` renders the shared working rules as the `vesta:core` prompt section (order 0.5, right after each preset's persona prefix) from the bundle patch's `core` text: look before acting, no unchanged retries, FAILED plainly, the digest rule (reduce before returning, at most forty lines of any output unless asked for the full text, one call over several), the search and vision conventions, and the tool-group convention. The mode personas keep only their stance (Ops operator, Build engineer, Research find-out, Companion warm, Batch code mode). The tool-result pruner in every preset now cuts at 6144 characters (head 3072, tail 1024).
- **E2 Tool groups on demand.** `vesta-tool-restrict` 0.2 (host plugin, bundle patch `groups` + `onDemand`) masks the heavy, rarely used groups for agents of the listed presets at `agent/created`: `home` (the 20 Home Assistant tools, staging only today), `documents` (the 16 PDF tools), `vision` (the vision MCP and `read_image`); Research starts with `documents` awake. A group wakes for the rest of the session when a keyword of it appears in a user message (the modes plugin's prompt router runs `vestaToolGroups.autoEnable` before every prompt is admitted), when the model calls `tools_enable <group>` (a host-registered tool, visible in every managed session), or with `/tools <group>` (`/tools` shows the state, `/tools <group> off` puts it back to sleep). The `vesta:tool-groups` prompt section lists the dormant groups so the model knows what to ask for. Nothing is removed from the deployment; a wake-up costs one prompt-cache miss for that session. Verified: an Ops session without keywords sees 44 tools instead of 81 with `tools_enable` present; "is the heating on" wakes the home group before the turn (64 tools, the model used them); `tools_enable documents` adds the 16 PDF tools from the next step; `/tools` reports it.
- **E3 Quick or deep.** The Auto classifier answers with the mode and a depth; a quick message (a check, a lookup, a short answer) on Ops, Build or Research thinks at `medium` (the level declared on the lane for Batch), everything else keeps xhigh; `/think off|medium|xhigh` overrides at any time and is logged. Verified: "how much free space is on /" routed to Ops at medium; a test-planning request routed to Build at xhigh.
- **E4 Routines default to Batch where the tier allows.** A routine without a `preset` gets `vesta-batch` at workspace-write or full access and `vesta-routine` at read-only (`vesta-routines` config `batchPreset`, `batchTiers`); choosing Batch at read-only is refused with the reason on the page and in the file. The page's preset select offers default, Routine and Batch.

Measured (Ops, eight tasks, before → after; the other modes' first request): Ops first request 20.9 k → 15.3 k input tokens (81 → 44 tools), cold time to first token 17.5 s → 7.6 s, warm 6.4 s → 5.6 s; the eight tasks together 501 s → 461 s, 828 k → 605 k input tokens, 29 → 29 steps, no tool errors; the log triage alone 175 s → 107 s and 122 k → 13 k characters of raw tool output, while the export listing and the explain task read more than before (raw output 13 k → 135 k and 1.6 k → 10.7 k), so the digest rule needs a firmer line on piping through `head` — the pruner bounds what the model sees either way, and the input-token total is the honest measure. First request of the other modes: Build 24.2 k → 18.7 k (90 → 53 tools), Research 19.2 k → 16.4 k (71 → 50), Companion 16.1 k → 10.7 k (63 → 26), with cold first-token time down in proportion (Companion 13.5 s → 8.8 s).

## Quick mounts (roadmap T1–T6, 2026-09-11)

Six upstream capabilities the composition did not mount, added as rows only (no fork code). Every upstream package a row names must also be a dependency of `packages/bundle/vesta-app/package.json` (then `pnpm install`): the profile directory resolves packages through the bundle's dependency graph, and a row naming a package outside it fails the boot with `Cannot find package`. A patch row can restate a row's `config` or set `disabled`, but it cannot swap the row's package.

| Item | Row | Where | Check |
|---|---|---|---|
| T1 time awareness | `time-context` (`refreshIntervalMs: 300000`) | bundle patch (host) | a session's first step carries a user-role reading "Time sampled while preparing turn 1 … [Europe/London]"; at most one per 5 min |
| T2 own-history search | `tool-session-query` | preset row in `vesta-default` and `vesta-orch` | `session_search`, `session_event_search`, `session_trace`, `session_event_trace`, `session_event_read` in the request header's tool list; cross-session reads only within the same cwd |
| T3 whole-conversation titles | `session-title-llm` **disabled** + insert `session-title-all-prompts` (`@deepseek-ai/dsh-session-title-all-prompts-llm`, 16 KB input cap) | bundle patch (host) | `session/title-llm-request` events name `session-title-all-prompts-llm`; the title follows the conversation instead of the first words |
| T4 shell guard (hooks) | `hooks-claude-code` (`configPath: $DSH_HOME/hooks.json`) | home patch (machine-wide) | `hook/invoked` + `hook/result` events on every `bash` call; `echo vesta-guard-canary` is denied (`decision: block`, exit 2, the reason in the tool result). The bridge runs hook commands through the bash executor in `workspace-write`, so a sandbox runner must exist: the Landlock launcher (see Prerequisites; verified 2026-09-12). `bubblewrap` is installed but blocked by Ubuntu's `apparmor_restrict_unprivileged_userns` |
| T5 PDF | `mcp-pdf` → `http://127.0.0.1:7333/mcp` (server `pdf`) | home patch | 16 `mcp__pdf__*` tools in the header; files live under `/srv/ai/pdf-mcp/work` (the container's only visible path) |
| T6 reminders | `schedule` + `ui-schedule` enabled | bundle patch | `schedule_create` / `schedule_list` / `schedule_delete` in the header; delivery only while the session is open (Routines cover the cold case) |
| T7 persistent terminals (2026-09-12) | host rows `pty` (`dsh-terminal`) + `terminal-bash` (upstream mounts them only in its minimal SDK bundle); preset row `tool-terminal` in `vesta-ops` and `vesta-build` | bundle patch + presets | six `terminal_*` tools in the header; a Build session opened a shell, sent `uptime`, read it and closed it |
| T8 code intelligence (2026-09-12) | host rows `lsp` + `lsp-stdio` (servers: `~/.local/bin/typescript-language-server`, `~/.local/bin/basedpyright-langserver`, absolute paths because the unit's PATH lacks `~/.local/bin`); preset row `tool-lsp` in `vesta-build` | bundle patch + preset | the `lsp` tool in a Build session; `goToDefinition` on `parseCron` resolved to `cron.ts:55:17`. Servers: `npm i -g typescript-language-server typescript` (prefix `~/.local`) and `~/.local/bin/uv tool install basedpyright`; a missing executable fails the provider at load |

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

Promotion from staging, as run on 2026-09-18 (tag `vesta-stable-2026-09-18-p14`): commit and push on `staging`; on the production checkout `git fetch origin && git merge --ff-only origin/staging && git push origin vesta`, then `deploy/vesta/bin/vesta-build` (the running process keeps serving the old artifacts meanwhile); back up the home config (`tar -czf ~/backups/prod-home-config-before-<phase>-<stamp>.tgz -C ~/.vesta-harness settings.yaml cordis.patch.yml hooks.json hooks .agent-presets mode-overrides.json`); poll `session/list` for `running: true` and fail closed; `systemctl --user stop vesta-harness`; copy `deploy/vesta/settings.yaml`, `deploy/vesta/agent-presets/.` and `deploy/vesta/home-cordis.patch.yml` into the home (stopped, so no hot-reload); `--dump-config | grep -E 'vesta|mcp-'`; start; wait for the `401` gate; check the journal (never grep for `dsh web`); verify over RPC (`agentPresets/list`, an Auto session, `/tools`, `/memory`, a Batch session), delete the test sessions through `/api/vesta/sessions/delete`; tag; documentation break; fast-forward `staging` onto `vesta`.

Promotion of the 0.1.6 sync, as run on 2026-09-19 (tag `vesta-stable-2026-09-19-sync-0.1.6`): the same sequence, with three differences — `LEFTHOOK=0` on the push from the production checkout (its pre-push typecheck would rebuild host libs under the running unit and had already passed from staging); `cd native/system && pnpm build:native` after `vesta-build`; a full home backup (`tar czf ~/backups/prod-home-before-<phase>-<stamp>.tgz -C ~ .vesta-harness`). In the window only the presets were refreshed (`settings.yaml` and the home patch were already identical to the repo). Note that `pnpm install` prunes packages the running process may still lazy-load (the old PTC worker runtime at this sync), so build only while production is idle.

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

Shared: LiteLLM, the GPU lanes and every MCP server (the staging environment work, pipeline S, gives staging its own memory server and pdf server and turns the notifier off there). The voice worker rows that stood here until 2026-09-24 are in the tag `vesta-voice-retired-base-2026-09-24`.

Set-up (done 2026-09-06):

```bash
git clone git@github.com:hugoacfs/vesta-harness.git ~/code/vesta-harness-staging && cd ~/code/vesta-harness-staging && git checkout -b staging origin/vesta && pnpm install --frozen-lockfile && pnpm run build
H=~/.vesta-harness-staging; mkdir -p $H/profiles/vesta $H/.agent-presets $H/storages $H/sessions
cp ~/.vesta-harness/settings.yaml ~/.vesta-harness/.credentials.yaml $H/ && chmod 600 $H/.credentials.yaml $H/settings.yaml
cp -r ~/.vesta-harness/.agent-presets/. $H/.agent-presets/ && cp ~/.vesta-harness/profiles/vesta/{package.json,cordis.yml,pnpm-workspace.yaml} $H/profiles/vesta/ && mkdir -p $H/profiles/vesta/node_modules
cp ~/code/vesta-harness-staging/deploy/vesta/staging-cordis.patch.yml $H/profiles/vesta/cordis.patch.yml
cp ~/code/vesta-harness-staging/deploy/vesta/vesta-harness-staging.service ~/.config/systemd/user/ && install -D -m 644 ~/code/vesta-harness-staging/deploy/vesta/vesta-harness-staging.service.d/basepath.conf ~/.config/systemd/user/vesta-harness-staging.service.d/basepath.conf && systemctl --user daemon-reload && systemctl --user enable --now vesta-harness-staging
# nginx: the /harness-staging block from deploy/vesta/nginx-harness.conf (see “Service and tailnet”); until 2026-09-10 this was `tailscale serve --bg --https=8792 http://127.0.0.1:3082`
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
