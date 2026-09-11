# @deepseek-ai/dsh-vesta-modes

## Summary

`dsh-vesta-modes` turns an agent preset into a mode: when a root session starts with a preset named in its `modes` map, the plugin sets the session's permission tier (`permissionPresets.set`) and reasoning level (`sessionController.selectModel` on the default route) once, before the first turn. A session that already has a turn (a resume, or a session switched by hand) is left alone, so later changes made by hand or by voice survive restarts. Presets not in the map keep the deployment defaults. Configured in the `vesta-app` bundle patch; the presets themselves live in `deploy/vesta/agent-presets`. Private to the Vesta fork.

## Configuration

```yaml
modes:
  vesta-ops:       { permission: danger-full-access, reasoning: xhigh }
  vesta-companion: { permission: danger-full-access, reasoning: off }
```
