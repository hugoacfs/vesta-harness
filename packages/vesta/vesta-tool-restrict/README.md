# @deepseek-ai/dsh-vesta-tool-restrict

Vesta fork, a preset row (roadmap T12 v2, 2026-09-17). Calls upstream's `tools.restrict({ allow })` in the preset's scope, so agents composed from that preset see only the listed host-global tools (MCP servers, reminders and other host-registered tools) while the preset's own rows stay visible. `allow: []` hides every host-global tool. Used by `deploy/vesta/agent-presets/vesta-batch` to keep the PTC SDK small.
