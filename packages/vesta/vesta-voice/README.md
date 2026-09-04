# @deepseek-ai/dsh-vesta-voice

## Summary

`dsh-vesta-voice` makes a LiveKit voice call a modality of an ordinary Session. The browser asks `GET /api/vesta/voice/token?sessionId=…` for a room token (room `dsh-<sessionId>`), joins the LiveKit SFU, and the Vesta agent job that picks up the room dials this plugin's upgrade route (`/vesta/voice/bridge`, bearer = the LiveKit API secret, `X-Vesta-Room` = the room). The plugin resolves or resumes the Session's Agent and binds the socket: each finished utterance is submitted through `ctx.sessionController.prompt` (queued when the Agent is idle, steering when it is running), assistant `text-delta` chunks from `agent/assistant-stream` are relayed as `speak` frames, `tool/call` and `turn/end` session events as `status` and `done`, and a barge-in `interrupt` cancels the active turn while keeping the inbox. While a room is bound, a spoken-mode prompt section is registered on the Agent's own scope and unwinds when the socket closes. `GET/POST /api/vesta/voice/emotion` proxies the STT sidecar's perception flag. The package is private to the Vesta fork.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `livekitUrl` | required | LiveKit signaling URL for browsers |
| `apiKeyRef` / `apiSecretRef` | `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | credential references (stored in `$DSH_HOME/.credentials.yaml`) |
| `bridgePath` | `/vesta/voice/bridge` | upgrade path on the Host web server |
| `mediaUrl` | absent | STT sidecar base URL for the perception toggle |
| `tokenTtlSeconds` | `3600` | room token lifetime |
| `roomPrefix` | `dsh-` | room name prefix before the Session id |

## Model Experience

While a room is bound, the Agent's prompt carries the spoken-mode section (`VOICE_SECTION`, order 10): short spoken sentences, no markdown in prose, fenced code for on-screen material, perception notes never read aloud. Spoken turns are ordinary `user/message` events with a `user-rpc` source; nothing else reaches the model.

#### KV Cache effect

Binding or unbinding a room changes the assembled system prompt of that Agent, so the request prefix changes at the next step of that Session only.

## Known Limitations and Deferred Work

- One socket per room; a second browser joining the same Session's room shares the agent job and therefore the binding.
- Barge-in forwards `interrupt` whenever the agent's reply is cut off, which also aborts tool work the model started after its spoken preamble.
- Perception toggle is global to the STT sidecar, not per Session.
