# @deepseek-ai/dsh-vesta-app

## Summary

`dsh-vesta-app` is the Vesta Harness patch layer: a profile bundle applied over `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app` that turns the stock web application into Vesta Harness. It inserts the ember theme and Vesta brand client rows and the two vesta MCP client rows (memory, search). The `vesta` profile lists it as its third bundle (`deploy/vesta/profiles/vesta/package.json`); model route, agent preset, permission default, and theme preference stay in `$DSH_HOME/settings.yaml`. The package is private to the Vesta fork and is never published.

## Rows

| id | package | role |
|---|---|---|
| `ui-vesta-theme` | `@deepseek-ai/dsh-client-ui-vesta-theme` | ember `--dsw-*` alias overrides, fonts, ambient ground |
| `ui-vesta-brand` | `@deepseek-ai/dsh-client-ui-vesta-brand` | sidebar mark + name, hero orb |
| `mcp-vesta-memory` | `@deepseek-ai/dsh-mcp-client` | `mcp__memory__*` tools over `http://127.0.0.1:7332/mcp` |
| `mcp-vesta-search` | `@deepseek-ai/dsh-mcp-client` | `mcp__search__*` tools over `http://127.0.0.1:7331/mcp` |

## Model Experience

None directly; the MCP client rows contribute their tool schemas exactly as the upstream `dsh-mcp-client` package documents.

## Known Limitations and Deferred Work

- The MCP endpoints are vesta deployment facts baked into the bundle; a second deployment overrides the two rows by id from its profile patch.
