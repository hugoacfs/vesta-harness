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
    /** The user barged in while the reply was being spoken, or said "stop": abort the active turn, keep pending work. */
    readonly type: 'interrupt'
  }
  | {
    /** The user answered a pending approval by voice. */
    readonly type: 'approval-decision'
    readonly id: string
    readonly allow: boolean
  }
  | {
    /** The user asked for another permission preset by voice; the Host confirms with `say` or `error`. */
    readonly type: 'permission'
    readonly preset: string
  }
  | { readonly type: 'ping' }

/** Frames the Host sends to the agent job. */
export type HostToAgent =
  | {
    /** The socket is bound; spoken turns now enter this Session. */
    readonly type: 'ready'
    readonly sessionId: string
    /** Permission preset in effect at bind time. */
    readonly permission: string
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
    /** A tool call needs the user's decision; the agent asks aloud and answers with `approval-decision`. */
    readonly type: 'approval'
    readonly id: string
    readonly tool: string
    readonly reason?: string
  }
  | {
    /** The pending approval was settled elsewhere (on screen, or the turn ended); stop asking. */
    readonly type: 'approval-done'
    readonly id: string
    readonly outcome: string
  }
  | {
    /** Host-initiated speech outside a turn: confirmations of spoken commands. */
    readonly type: 'say'
    readonly text: string
  }
  | {
    /** The Host refused or lost a request. */
    readonly type: 'error'
    readonly message: string
  }
  | { readonly type: 'pong' }
