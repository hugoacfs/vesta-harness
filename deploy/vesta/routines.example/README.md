# Routine examples (v2, roadmap R8)

Copy a folder to `$DSH_HOME/routines/<name>/` (the folder name is the routine's name). Each holds `routine.yaml`; the plugin adds `notes.md` (the agent's notes), `runs.jsonl` (history), `thread.json` (thread and run state) and `archive/` (rotated threads). The Routines page creates and edits the same files. A v1 `$DSH_HOME/routines.yaml` is imported once at boot (`prompt` becomes `brief`, `mode` is dropped) and renamed `routines.yaml.imported-<stamp>`.
