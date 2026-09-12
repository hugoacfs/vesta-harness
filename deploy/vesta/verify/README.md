# Verification scripts (2026-09-11/12)

Run from any machine with `ssh vesta` (they mint a cookie jar through `~/.local/bin/vesta-url` on the server and never print the token). Targets staging unless the name says prod.

- `jar.sh` / `jar-prod.sh` — ensure `/tmp/jar-staging.txt` / `/tmp/jar-prod.txt` hold a valid session cookie (mint via `vesta-url`).
- `r8-verify.sh` — routines v2 end to end on staging: a smoke routine (read-only, notify agent, rotate after 3, compact above 100 tokens), four runs, hidden thread, NOTIFY delivery (one Telegram message reaches Hugo), compaction, rotation, handover, a chat turn, reset, delete. `NAME=` overrides the routine name.
- `m5-verify.sh` — Auto mode: eight first messages routed to the expected mode plus a `/mode` override, read from the session logs (`agent-preset/selected` before the first `turn/start`, tier, reasoning, tool count).
- `m1-verify.sh`, `m4-verify.sh`, `p4-verify.sh` — earlier phases (modes, incognito, archived panel).
- `ffdrive/*.mjs` — headless Firefox checks (macOS: `/Applications/Firefox.app`, `puppeteer-core` from `ffdrive/package.json`; `npm install` in that folder first): the Routines page, the Auto chip, the Archived panel, the mode picker. Screenshots go to `/tmp/vesta-shots` (create it).

Session logs: `zstd -dc -- $DSH_HOME/sessions/<workspace>/<session>/session.v3.jsonl.zstd`. RPC from a script: `POST /api/<ns>/<method>` with `{type:'client-request', rpcId, method:'<ns>/<method>', payload:{args:{…}}}` and the cookie jar; results under `result.value`.
