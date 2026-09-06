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
  | {
    /** The user answered a pending question set by voice (one answer per question item). */
    readonly type: 'question-answer'
    readonly id: string
    readonly answers: readonly VoiceQuestionAnswer[]
  }
  | { readonly type: 'ping' }

/** One question item as spoken to the user: the tool's item without model-facing detail. */
export interface VoiceQuestionItem {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly options?: readonly { readonly label: string; readonly description?: string }[]
  readonly multiSelect?: boolean
  /** `plan-review` questions approve with the named option and take free text as feedback. */
  readonly intent?: { readonly kind: 'plan-review'; readonly approve: string }
}

/** One spoken answer: selected option labels, or free text when no option matched. */
export interface VoiceQuestionAnswer {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

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
    /** The Agent asked the user something (ask_user_question or a plan review); the agent asks aloud and answers with `question-answer`. */
    readonly type: 'question'
    readonly id: string
    readonly items: readonly VoiceQuestionItem[]
  }
  | {
    /** The pending question set was answered elsewhere or withdrawn; stop asking. */
    readonly type: 'question-done'
    readonly id: string
  }
  | {
    /** The Session's permission preset changed (on screen or by voice); the agent answers "what mode am I in" from it. */
    readonly type: 'permission'
    readonly preset: string
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
