# @deepseek-ai/dsh-client-ui-vesta-sessions

## Summary

`dsh-client-ui-vesta-sessions` adds an **Archived** entry to the sidebar's global panel list and the matching main-column panel: every archived session with its title, age and workspace, and three actions per row — Restore (back to its old place in the sidebar), Download log (upstream's session-log ZIP export) and Delete for good, which asks once inline, then exports the session directory to the server's backup directory and removes it. Data and actions go through the `dsh-vesta-sessions` host routes (`/api/vesta/sessions/*`), resolved against the document base so a reverse-proxy sub-path works. A session that is open somewhere cannot be deleted (the Host answers 409). The package is private to the Vesta fork.
