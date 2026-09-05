/**
 * Vesta voice surface, browser half: the mic button in the composer's right
 * control list and the call HUD in the input dock above the composer, both
 * over one shared call store written by the apply-world call controller.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots) and the composer slot declarations.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { VoiceCallController } from './call.ts'
import { CallHud, type CallHudInjected } from './CallHud.tsx'
import { MicButton, type MicButtonInjected } from './MicButton.tsx'
import { en, VOICE_NS, zh, type VoiceKey } from './locales.ts'
import { createVoiceCallStore } from './store.ts'

export type { CallHudInjected } from './CallHud.tsx'
export type { MicButtonInjected } from './MicButton.tsx'
export type { VoiceKey } from './locales.ts'
export type { AgentState, CallStatus, VoiceCallState } from './store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The mic button and call HUD copy. */
    'vesta.voice': VoiceKey
  }
}

/** Required services: the UI slot registry and the locale dictionaries. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the mic button and the HUD over one store.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(VOICE_NS, { zh, en }), 'ui-vesta-voice: dictionaries')
  const store = createVoiceCallStore()
  const calls = new VoiceCallController()

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'vesta-voice-mic',
    order: 40,
    store,
    locale: VOICE_NS,
    inject: (sessionId, actions): MicButtonInjected => {
      calls.adopt(actions)
      return {
        start: () => calls.start(String(sessionId)),
        end: () => calls.end(),
      }
    },
  }, MicButton))

  // The dock is in-flow above the composer card (the goal bar lives there),
  // so the HUD takes layout space instead of covering the transcript.
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'vesta-voice-hud',
    order: 5,
    store,
    locale: VOICE_NS,
    inject: (_sessionId, actions): CallHudInjected => {
      calls.adopt(actions)
      return {
        end: () => calls.end(),
        toggleMute: () => calls.toggleMute(),
        setEmotion: enabled => calls.setEmotion(enabled),
      }
    },
  }, CallHud))

  ctx.effect(() => () => { void calls.end() }, 'ui-vesta-voice: active call')
}
