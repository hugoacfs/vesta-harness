# @deepseek-ai/dsh-client-ui-vesta-voice

## Summary

This package puts a voice call into the conversation surface: a mic button in the composer's right control list (`conversation.input.right`) and a call HUD in the input dock above the composer (`conversation.input.dock`, in-flow so the transcript shrinks rather than being covered) — the ember orb driven by the agent's audio level, the agent's published state (`lk.agent.state`), the microphone in use with a picker (a caret next to mute; the choice is kept in `localStorage` `vesta.voice.micDeviceId`), a five-bar meter of what the room hears, a downlink signal glyph (LiveKit connection quality; its tooltip carries the receiver's concealed audio, packets lost and jitter, printed to the console once a second when `localStorage` `vesta.voice.debug` is `1`), mute, the perception ("share my tone") toggle, and end call. One call is active at a time, bound to the Session whose mic started it; the mic button of any other Session is disabled meanwhile. The controller fetches a room token from `@deepseek-ai/dsh-vesta-voice` (`/api/vesta/voice/token?sessionId=…`), joins the LiveKit room `dsh-<sessionId>` with `livekit-client` (bundled privately), publishes the microphone, and plays the agent's audio; spoken turns and replies then appear in the transcript as ordinary session events, so nothing here renders chat. Copy lives in the `vesta.voice` locale namespace. The package is private to the Vesta fork.

## Model Experience

None, as the package is a browser-side UI plugin that registers nothing model-facing; the Host bridge owns the spoken-mode prompt section.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- One active call per browser tab; a second tab on the same Session presents the same participant identity (`user-<session uuid>`) and replaces the first, because the agent stays linked to that identity.
- The agent's audio plays through a hidden media element appended to `document.body`; browsers that block autoplay before a gesture start silent until the mic click, which is the gesture.
