# @deepseek-ai/dsh-vesta-incognito

## Summary

`dsh-vesta-incognito` makes a session that starts with an incognito preset leave nothing behind. The memory MCP's writing tools are refused on the `tools/pre-execute` waterfall with a reason the model sees; the title is pinned to "Incognito" at creation (a user rename, so no title request carries the conversation); `vesta-notify` skips the session through its `excludePresets`; and the session directory plus every registry trace is wiped when the session is closed or archived, when the process disposes it, and, as the backstop, at the next boot for whatever an earlier run left on disk. A live session is closed first through the fork's `sessionController.close`. The conversation still exists on disk while it runs (the harness has no in-memory session backend) and still reaches the model gateway. Private to the Vesta fork.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `presets` | `['vesta-incognito']` | preset ids treated as incognito |
| `title` | `Incognito` | the pinned title |
| `denyTools` | memory write, edit, delete | tool names refused in incognito sessions |
