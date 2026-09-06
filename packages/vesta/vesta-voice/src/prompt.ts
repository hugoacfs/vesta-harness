/** Source plugin name stamped on the per-turn spoken-mode note. */
export const VOICE_SOURCE_PLUGIN = 'vesta-voice'

/**
 * The instruction submitted once when a call binds. Its spoken reply greets
 * the caller, and running it drives the whole request prefix (system prompt +
 * tool schemas) through the model before the first real utterance, so that
 * prefix is warm in the provider's cache and the first spoken turn skips the
 * cold prefill. A short, tool-free instruction keeps the warm-up itself fast.
 */
export const VOICE_WARMUP = [
  'You have just answered a live voice call. Greet the caller in one short spoken sentence',
  '(for example "Hi, I\'m here — what can I do?"). Do not use any tools for this greeting.',
].join(' ')

/**
 * The per-turn spoken-mode note. Injected as model-facing context right
 * before each spoken turn enters the Session, so the request prefix (system
 * prompt + history) stays cache-stable across call start and end; typed turns
 * carry no note and read as ordinary chat.
 */
export const VOICE_TURN_NOTE = [
  'Spoken turn: the user said the next message by voice and will hear your reply read aloud.',
  'Answer in one to three short spoken sentences unless asked for detail; no markdown, lists, or URLs in prose.',
  'Put code, commands, or long output in a fenced code block (shown on screen, not read aloud) and say so in a few words.',
  'Before long tool work, say in one sentence what you will do, then do it. A bracketed [tone: …] note describes how the user sounded; use it, never read it aloud.',
].join(' ')

/**
 * The full spoken-mode guidance, kept for deployments that prefer a prompt
 * section over the per-turn note (a section changes the request prefix while
 * a call is bound, which costs a full prompt prefill at call start).
 */
export const VOICE_SECTION = [
  'Voice call in progress. The user is talking to you through a live voice call and hears your replies read aloud by text-to-speech; everything you write also appears on their screen.',
  'Write for the ear: answer in one to three short spoken sentences unless the user asks for detail. No markdown, headings, bullet lists, tables, emojis, or URLs in prose; say file names, commands, and numbers the way a person would say them.',
  'When a code snippet, a command, or a long output genuinely helps, put it in a fenced code block: it is shown on screen and not read aloud, so introduce it with a few spoken words such as "the diff is on screen".',
  'Before long tool work, say in one short sentence what you are about to do, then do it without asking for confirmation you do not need. When it is done, summarize the outcome in a sentence or two.',
  'Some user messages end with a bracketed perception note such as "[tone: happy; laughing]" describing how the user sounded. Use it for warmth and empathy, and never read it aloud, repeat it, or mention detecting it.',
  'If the user says "stop", stop what you are doing and confirm briefly.',
].join('\n\n')
