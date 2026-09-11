# @deepseek-ai/dsh-vesta-modes

## Summary

`dsh-vesta-modes` turns an agent preset into a mode. When a root session starts with a preset named in its `modes` map, the plugin sets the session's permission tier (`permissionPresets.set`) and reasoning level (`sessionController.selectModel` on the default route) once, before the first turn; a session that already has a turn is left alone, so later changes survive restarts. `/mode <name>` (ops, build, research, companion by label or preset id) switches a running session softly: tier and reasoning change at once, and the target mode's persona prefix — read from `$DSH_HOME/.agent-presets/<preset>/agent.cordis.yml` — is rendered as the `vesta:mode-override` prompt section right after the original persona, telling the model the new guidance replaces the old; the tool set cannot change once a session has produced anything (upstream rule). Modes with `switchable: false` (Incognito) refuse the switch. Overrides persist in `$DSH_HOME/mode-overrides.json` and are re-applied on resume. Private to the Vesta fork.

## Configuration

```yaml
modes:
  vesta-ops:       { label: Ops, permission: danger-full-access, reasoning: xhigh }
  vesta-companion: { label: Companion, permission: read-only, reasoning: 'off' }
  vesta-incognito: { label: Incognito, permission: read-only, reasoning: 'off', switchable: false }
overridesFile: ''   # empty = $DSH_HOME/mode-overrides.json
```
