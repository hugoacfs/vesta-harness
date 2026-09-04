/**
 * Wire messages of the voice bridge. The LiveKit agent job that owns one room
 * dials the Host's upgrade route and speaks newline-free JSON frames; the Host
 * answers on the same socket. One socket binds exactly one room to one Session.
 */

/** Frames the agent job sends to the Host. */
export type AgentToHost =
  | {
    /** One finished user utterance (the transcript, with any perception note appended by the STT sidecar). */
    readonly type: 'turn'
    readonly text: string
  }
  | {
    /** The user barged in while the reply was being spoken: abort the active turn, keep pending work. */
    readonly type: 'interrupt'
  }
  | { readonly type: 'ping' }

/** Frames the Host sends to the agent job. */
export type HostToAgent =
  | {
    /** The socket is bound; spoken turns now enter this Session. */
    readonly type: 'ready'
    readonly sessionId: string
  }
  | {
    /** One assistant text delta to be spoken, in stream order. Reasoning deltas are never sent. */
    readonly type: 'speak'
    readonly text: string
  }
  | {
    /** The Agent started a tool call; optional narration on the agent side. */
    readonly type: 'status'
    readonly tool: string
  }
  | {
    /** The turn closed; nothing more will be spoken for it. */
    readonly type: 'done'
    readonly reason: string
  }
  | {
    /** The Host refused or lost the turn. */
    readonly type: 'error'
    readonly message: string
  }
  | { readonly type: 'pong' }
