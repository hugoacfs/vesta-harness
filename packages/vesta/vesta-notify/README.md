# @deepseek-ai/dsh-vesta-notify

## Summary

`dsh-vesta-notify` pings the user on Telegram when something worth a glance happens while no browser tab is looking at the harness. Delivery goes through the send-only notifier MCP (`ai-telegram-mcp`, loopback `127.0.0.1:7335`, tool `notify`): the harness posts a stateless streamable-HTTP `tools/call`; the recipient is pinned server-side and the bot token never reaches the harness. Two triggers: a turn that ran at least `minTurnSeconds` finished (`turn/end` on the Session's durable log; the message carries the first line of the reply), and an approval or ask-user question has waited `approvalWaitSeconds` for a decision (passive observers at the front of the `approval/request` and `user-questions/request` waterfalls: they record, call the rest of the chain, and forget when it settles). Presence comes from `ui-vesta-presence`, which posts `{ visible }` to `POST /api/vesta/notify/presence` every 30 s while a tab is visible; no visible heartbeat for `awayAfterSeconds` means away, and with `onlyWhenAway` (the default) nothing is sent while a tab is watching. `cooldownSeconds` caps one message per Session and trigger; `quietHours` (`HH:MM-HH:MM`, local time, may wrap midnight) silences the notifier. The package is private to the Vesta fork.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `url` | `http://127.0.0.1:7335/mcp` | notifier MCP endpoint |
| `tool` | `notify` | tool to call |
| `minTurnSeconds` | `120` | report finished turns at least this long |
| `approvalWaitSeconds` | `60` | report approvals / questions waiting this long |
| `cooldownSeconds` | `300` | minimum gap per Session and trigger |
| `awayAfterSeconds` | `90` | no visible heartbeat for this long = away |
| `onlyWhenAway` | `true` | report only while away |
| `quietHours` | `''` | `HH:MM-HH:MM` local window with no messages |
| `silent` | `false` | deliver without sound |
| `linkBase` | `''` | link appended to every message |

## Verify

`docker logs ai-telegram-mcp` shows the delivery; the harness journal does not carry plugin logs. A scripted check: create a session, prompt a turn that runs longer than the threshold (for example a `sleep 150` through the shell tool) with every tab closed, and expect one message.
