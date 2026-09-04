/** Registration name of the spoken-mode section on a bound Agent. */
export const VOICE_SECTION_NAME = 'vesta-voice'

/** Placement right after the deployment persona (order 0) and before the plan and tool sections. */
export const VOICE_SECTION_ORDER = 10

/**
 * The spoken-mode prompt section. Registered on the Agent's own scope while a
 * voice call is bound to its Session and removed when the call ends, so typed
 * turns in the same Session return to the ordinary prompt.
 */
export const VOICE_SECTION = [
  'Voice call in progress. The user is talking to you through a live voice call and hears your replies read aloud by text-to-speech; everything you write also appears on their screen.',
  'Write for the ear: answer in one to three short spoken sentences unless the user asks for detail. No markdown, headings, bullet lists, tables, emojis, or URLs in prose; say file names, commands, and numbers the way a person would say them.',
  'When a code snippet, a command, or a long output genuinely helps, put it in a fenced code block: it is shown on screen and not read aloud, so introduce it with a few spoken words such as "the diff is on screen".',
  'Before long tool work, say in one short sentence what you are about to do, then do it without asking for confirmation you do not need. When it is done, summarize the outcome in a sentence or two.',
  'Some user messages end with a bracketed perception note such as "[tone: happy; laughing]" describing how the user sounded. Use it for warmth and empathy, and never read it aloud, repeat it, or mention detecting it.',
  'If the user says "stop", stop what you are doing and confirm briefly.',
].join('\n\n')
