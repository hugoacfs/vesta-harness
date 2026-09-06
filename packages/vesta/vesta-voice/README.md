# @deepseek-ai/dsh-vesta-voice

## Summary

`dsh-vesta-voice` makes a LiveKit voice call a modality of an ordinary Session. The browser asks `GET /api/vesta/voice/token?sessionId=…` for a room token (room `dsh-<sessionId>`), joins the LiveKit SFU, and the Vesta agent job that picks up the room dials this plugin's upgrade route (`/vesta/voice/bridge`, bearer = the LiveKit API secret, `X-Vesta-Room` = the room). The plugin resolves or resumes the Session's Agent and binds the socket: each finished utterance is submitted through `ctx.sessionController.prompt` (queued when the Agent is idle, steering when it is running), assistant `text-delta` chunks from `agent/assistant-stream` are relayed as `speak` frames, `tool/call` and `turn/end` session events as `status` and `done`, and a barge-in `interrupt` cancels the active turn while keeping the inbox. Every spoken turn is preceded by a short injected note (`VOICE_TURN_NOTE`, source `vesta-voice`) telling the model the message came by voice and how to answer for the ear; the note rides the same step as the utterance, so the request prefix stays cache-stable across call start and end. While a room is bound the Session's reasoning effort is switched to `off` through `sessionController.selectModel` and restored on unbind (a provider whose model declares no `off` effort keeps its selection). `GET/POST /api/vesta/voice/emotion` proxies the STT sidecar's perception flag. The token identity is one per Session (`user-<uuid>`): LiveKit's RoomIO links the first caller and only ever re-links that identity, so a re-join or a second tab must present the same name. The warm-up greeting on bind (`warmupOnBind`) is a plugin-sourced message (`agent.followup`), so it renders as an injection and never becomes the Session's automatic title. The package is private to the Vesta fork.

While a room is bound the bridge is also the outermost `approval/request` answerer for that Agent (registered with `prepend`, because the on-screen answerer holds the chain until the user clicks). It sends the question to the agent job as an `approval` frame, re-dispatches the rest of the chain with a request whose cancellation it owns, and races the two: a spoken `approval-decision` settles `allowed-once` or `rejected` and aborts the derived request, which withdraws the on-screen card through the gateway; an on-screen decision, the asker's cancellation, or a chain that answers `unavailable` (no browser attached, so the spoken answer is the only channel until the socket closes) sends `approval-done` so the agent stops asking. Unbind settles every open question `unavailable`. A `permission` frame applies a preset through `ctx.get('permissionPresets')` (`resolve` then `set`, logged as `permission/preset`) and confirms with a `say` frame, or refuses with `error`; `ready` carries the preset in effect at bind time.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `livekitUrl` | required | LiveKit signaling URL for browsers |
| `apiKeyRef` / `apiSecretRef` | `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | credential references (stored in `$DSH_HOME/.credentials.yaml`) |
| `bridgePath` | `/vesta/voice/bridge` | upgrade path on the Host web server |
| `mediaUrl` | absent | STT sidecar base URL for the perception toggle |
| `tokenTtlSeconds` | `3600` | room token lifetime |
| `roomPrefix` | `dsh-` | room name prefix before the Session id (`dshs-` on the staging instance) |
| `agentName` | empty | LiveKit agent name added to the token as an explicit dispatch; empty leaves rooms on automatic dispatch (the vesta SFU ignores the claim; workers accept rooms by prefix instead) |
| `warmupOnBind` | `true` | on bind, submit the greeting turn that warms the request prefix (a plugin-sourced message, so it never titles the Session) |

## Wire frames

| Direction | Frame | Meaning |
|---|---|---|
| agent → host | `turn {text}` | one finished utterance |
| agent → host | `interrupt` | barge-in or a spoken "stop": cancel the active turn |
| agent → host | `approval-decision {id, allow}` | spoken answer to a pending approval |
| agent → host | `permission {preset}` | spoken permission switch |
| host → agent | `ready {sessionId, permission}` | bound; preset in effect |
| host → agent | `speak {text}` / `status {tool}` / `done {reason}` | assistant text delta, tool call, turn end |
| host → agent | `approval {id, tool, reason?}` / `approval-done {id, outcome}` | ask aloud; stop asking |
| host → agent | `question {id, items}` / `question-done {id}` | ask_user_question or plan review aloud; stop asking |
| agent → host | `question-answer {id, answers}` | spoken answers, one per item (selected labels or free text) |
| host → agent | `permission {preset}` | the Session's preset changed (screen or voice) |
| host → agent | `say {text}` / `error {message}` | host-initiated speech; refusal |

The agent job owns speech: it turns `approval` into a spoken question and judges the next utterance as yes/no; it reads `question` items one at a time (options spoken as "Options: A, B, or C", a plan review as "say approve or tell me what to change") and maps the reply to an option label, an ordinal, an approval, or free text; and it handles "stop", "switch to … mode" and "what mode am I in" before anything reaches the model. Questions race the on-screen card exactly like approvals (`user-questions/request`, outermost answerer, bridge-owned cancellation closes the card).

## Model Experience

Each spoken turn adds one injected user-role context (`VOICE_TURN_NOTE`, ~90 words): short spoken sentences, no markdown in prose, fenced code for on-screen material, perception notes never read aloud. The utterance itself is an ordinary `user/message` with a `user-rpc` source. While a call is bound the Session runs with reasoning effort `off`, so voice replies skip the thinking phase; typed turns after the call return to the previous effort.

#### KV Cache effect

The system prompt is untouched by a call; the per-turn note appends to history, and the reasoning switch changes only request parameters, so the cached prefix survives call start and end. On bind, `warmupOnBind` submits a greeting turn whose only job besides greeting the caller is to run the request prefix through the model so the provider caches it before the first real utterance; the first spoken turn then reuses the warm prefix instead of paying a cold prefill.

## Known Limitations and Deferred Work

- One socket per room; a second browser joining the same Session's room shares the agent job and therefore the binding.
- Barge-in forwards `interrupt` whenever the agent's reply is cut off, which also aborts tool work the model started after its spoken preamble.
- Perception toggle is global to the STT sidecar, not per Session.
- Approvals only arise where the composition asks: sandbox escalation (`sandbox_permissions` on bash and fs calls in a `read-only` or `workspace-write` Session) and hook-driven asks. A `danger-full-access` Session never asks, so nothing is spoken there.
