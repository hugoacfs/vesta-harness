# @deepseek-ai/dsh-client-ui-vesta-voice

## Summary

This package puts a voice call into the conversation surface: a mic button in the composer's right control list (`conversation.input.right`) and a call HUD in the composer overlay (`conversation.input.overlay`) — the ember orb driven by the agent's audio level, the agent's published state (`lk.agent.state`), mute, the perception ("share my tone") toggle, and end call. One call is active at a time, bound to the Session whose mic started it; the mic button of any other Session is disabled meanwhile. The controller fetches a room token from `@deepseek-ai/dsh-vesta-voice` (`/api/vesta/voice/token?sessionId=…`), joins the LiveKit room `dsh-<sessionId>` with `livekit-client` (bundled privately), publishes the microphone, and plays the agent's audio; spoken turns and replies then appear in the transcript as ordinary session events, so nothing here renders chat. Copy lives in the `vesta.voice` locale namespace. The package is private to the Vesta fork.

## Model Experience

None, as the package is a browser-side UI plugin that registers nothing model-facing; the Host bridge owns the spoken-mode prompt section.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- One active call per browser tab; a second tab on the same Session joins the same room as another participant.
- The agent's audio plays through a hidden media element appended to `document.body`; browsers that block autoplay before a gesture start silent until the mic click, which is the gesture.
