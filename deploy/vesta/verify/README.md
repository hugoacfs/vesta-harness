# Verification scripts (2026-09-11/12)

Run from any machine with `ssh vesta` (they mint a cookie jar through `~/.local/bin/vesta-url` on the server and never print the token). Targets staging unless the name says prod.

- `jar.sh` / `jar-prod.sh` — ensure `/tmp/jar-staging.txt` / `/tmp/jar-prod.txt` hold a valid session cookie (mint via `vesta-url`).
- `r8-verify.sh` — routines v2 end to end on staging: a smoke routine (read-only, notify agent, rotate after 3, compact above 100 tokens), four runs, hidden thread, NOTIFY delivery (one Telegram message reaches Hugo), compaction, rotation, handover, a chat turn, reset, delete. `NAME=` overrides the routine name.
- `m5-verify.sh` — Auto mode: eight first messages routed to the expected mode plus a `/mode` override, read from the session logs (`agent-preset/selected` before the first `turn/start`, tier, reasoning, tool count).
- `m1-verify.sh`, `m4-verify.sh`, `p4-verify.sh` — earlier phases (modes, incognito, archived panel).
- `ffdrive/*.mjs` — headless Firefox checks (macOS: `/Applications/Firefox.app`, `puppeteer-core` from `ffdrive/package.json`; `npm install` in that folder first): the Routines page, the Auto chip, the Archived panel, the mode picker. `home-link-check.mjs` (2026-09-25): the `Vesta home` link at the staging sidebar foot, wide and rail, and the `‹ home` link on the vesta-voice page at desktop and phone widths; prints each link's resolved URL and box. Screenshots go to `/tmp/vesta-shots` (create it).

- `homes-drift.sh` (2026-09-25, runs ON vesta) — where each live home differs from its versioned templates (settings, home and profile patches, hooks, presets); the staging `ceres` alias is the one intended divergence.
- `s-verify.sh` (2026-09-25, from the Mac) — Pipeline S: a staging session's tool catalogue (no Telegram, no Home Assistant, the memory tools), a `memory_search` answered by the staging memory server on 7339, the session deleted.
- `ffdrive/staging-check.mjs` (2026-09-25) — the staging harness's tab title and wordmark, and the staging voice page's, with screenshots.

Session logs: `zstd -dc -- $DSH_HOME/sessions/<workspace>/<session>/session.v3.jsonl.zstd`. RPC from a script: `POST /api/<ns>/<method>` with `{type:'client-request', rpcId, method:'<ns>/<method>', payload:{args:{…}}}` and the cookie jar; results under `result.value`.
- `sync-batch-check.sh` (2026-09-18) — two Batch programs on the PTC runtime (`ptc-runtime-node` since the 0.1.6 sync): header, tier, outcome and a workspace write/read/delete under the sandbox. `m1-verify.sh`, `m4-verify.sh` and `p4-verify.sh` read the home's paths and run ON vesta with a server-side jar (`~/.local/bin/vesta-url staging` → `curl -c /tmp/jar-staging.txt`); the others run from the Mac.
