# @deepseek-ai/dsh-client-ui-vesta-routines

## Summary

`dsh-client-ui-vesta-routines` adds a **Routines** entry to the sidebar's global panel list and the matching main-column panel: every routine from `$DSH_HOME/routines.yaml` with its schedule, next and last run and outcome, plus Run now, Pause/Resume and Open last session. Problems in the file are listed at the top. Data and actions go through the `dsh-vesta-routines` host routes (`/api/vesta/routines*`), resolved against the document base so a reverse-proxy sub-path works; the list refreshes every 15 s while the panel is open. Private to the Vesta fork.
