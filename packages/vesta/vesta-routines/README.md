# @deepseek-ai/dsh-vesta-routines

## Summary

`dsh-vesta-routines` runs scheduled agent jobs. `$DSH_HOME/routines.yaml` lists routines — a five-field cron `schedule` or a one-off `at`, a `workspace`, a `mode` (preset id), a required `permission` tier, a `prompt`, a `notify` policy (`always`, `failure`, `never`), an optional `timeoutMinutes` and `enabled`. Every `tickSeconds` the plugin starts what is due, one run at a time: it resolves the workspace, creates an ordinary session on the mode's preset, sets the tier, pins the title `routine: <name> <stamp>` and sends the prompt once. The run ends at the session's `turn/end` or at the timeout (which closes the session) and is reported through the send-only Telegram MCP. Run state (last run, outcome, pause) is `$DSH_HOME/routines.state.json`; the history is `$DSH_HOME/routines.log.jsonl`. Routes for the panel: `GET /api/vesta/routines`, `POST /api/vesta/routines/run { name }`, `POST /api/vesta/routines/pause { name, paused }`. The file is re-read whenever its modification time changes; invalid entries are reported in the panel and skipped. Private to the Vesta fork.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `file`, `stateFile`, `logFile` | `$DSH_HOME/routines.{yaml,state.json,log.jsonl}` | where routines, state and history live |
| `tickSeconds` | `30` | how often due routines are checked |
| `defaultTimeoutMinutes` | `30` | timeout for routines that name none |
| `notifyUrl`, `notifyTool` | `http://127.0.0.1:7335/mcp`, `notify` | the notifier MCP; empty url disables reports |
| `linkBase` | `''` | appended to reports |
