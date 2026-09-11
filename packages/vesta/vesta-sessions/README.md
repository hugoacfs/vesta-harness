# @deepseek-ai/dsh-vesta-sessions

## Summary

`dsh-vesta-sessions` gives the Web client the session lifecycle upstream lacks: an archived list, restore, and permanent delete. Three routes under the authenticated `/api` channel: `GET /api/vesta/sessions/archived` (the archived ids from the workspace registry joined with the Session controller's listing for titles and dates), `POST /api/vesta/sessions/unarchive { sessionId }` (the fork's `WorkspaceRegistry.unarchiveSession`; the session keeps its workspace slot, so it returns to its old place) and `POST /api/vesta/sessions/delete { sessionId }`. Delete closes a session that is currently open (the fork's `sessionController.close`; a session it cannot close answers 409), exports the session directory as `<exportDir>/<sessionId>-<timestamp>.tar.gz` (the raw log generations and attachments), removes the directory, and calls the fork's `WorkspaceRegistry.forgetSession` (archive set, workspace accounting, header index). A stale projection-cache record is left behind on purpose: the listing is driven by persistence, and the cache record is harmless. The browser half is `dsh-client-ui-vesta-sessions`. The package is private to the Vesta fork.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `exportDir` | `~/backups/sessions-deleted` | where deleted sessions are exported before removal |
