# Memory keep-up (memory Phase 4, P28)

Vesta's nightly writer of the day's durable knowledge (charter D27). It reads the day's conversations and turns decisions, Hugo's stated preferences and corrections, changed facts and methods into memory notes. The 03:00 `memory-dream` routine checks its work. In production since 2026-10-03.

## Files

- `routine.yaml`: the definition and brief as in production (home `/home/hugo/.vesta-harness`), saved here with `enabled: false`. On staging, use `/home/hugo/.vesta-harness-staging` in both paths of the digest command and keep it disabled.
- `digest.py`: the read-only script the routine runs with bash to read the day: Hugo's messages, Vesta's replies and tool names per session since a time, redacted, skipping routine, Batch, Incognito and subagent sessions. Session tools only reach sessions with the routine's own workspace, so the routine cannot read the day without it.

## Install

1. Copy this folder to `$DSH_HOME/routines/memory-keepup/`, or save the definition through `POST /api/vesta/routines/save` and copy `digest.py` beside it.
2. `mkdir -p /home/hugo/workspace/memory-keepup`. The plugin registers the workspace but does not create the directory; without it the run fails with ENOENT.
3. Give it notes whose first line is `last run: <YYYY-MM-DD HH:MM>` (where the first digest starts), then a handover heading: `POST /api/vesta/routines/notes`, or the Routines page.
4. Enable it on the Routines page, or set `enabled: true` and save.

## Settings (Hugo, 2026-10-03)

- 02:00, 45 minutes (it wraps up from about 35), read-only tier, reasoning `xhigh`, notify `agent`: a Telegram message only when something changed or failed.
- At most 10 changes a night (writes, merges and replacements together), never a deletion, card changes only as suggestions in its handover.
- Its writes carry `source: dream` and the id of the session the knowledge came from; a changed fact is written with `supersedes`.

## Tests on staging (2026-10-03)

- The second run made 4 changes in under 7 minutes. Two were a verify script's test facts, and it proposed that script's test backup suffix as a card suggestion. The brief gained its test-material rule and the writes were reverted.
- A fresh routine then read 18 sessions in 8.5 minutes and made no changes. It skipped all test material and flagged two real items for Hugo: a note he had asked to delete, and staging-only notes lost in a clone. Both were settled on his word.

The plan and its measurements: claude-data `vesta/memory-options.md` and `tools/vesta-memory/keepup/`. The store: `~/vesta-docs/services/memory.md`.
