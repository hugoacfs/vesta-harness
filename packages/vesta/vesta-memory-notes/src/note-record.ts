/**
 * Note bodies from the memory store's answers. `memory_read` answers with a JSON record
 * (`name`, `description`, `scope`, `project`, `created`, `updated`, `content`, …); older stores
 * answered with markdown under a frontmatter block. Capture before 2026-10-01 appended updates to
 * the whole record, so a note's body can start with records nested once per update, each followed
 * by the update appended to it.
 */

/** Fields that mark a JSON object as a store note record rather than JSON quoted in a note. */
const RECORD_FIELDS = ['name', 'description', 'content'] as const

/**
 * The body of a note from the text of a `memory_read` answer.
 * @param answer - the answer text: a JSON record, or markdown under a frontmatter block.
 * @returns the body with frontmatter, record fields and nested records removed; '' for an empty answer.
 */
export function noteBody(answer: string): string {
  const trimmed = answer.trim()
  if (trimmed.startsWith('---')) {
    const end = trimmed.indexOf('\n---', 3)
    if (end !== -1) return unwrapBody(trimmed.slice(end + 4))
  }
  return unwrapBody(trimmed)
}

/**
 * A body with each leading note record replaced by its content, recursively; the text that
 * followed each record (appended updates) is kept in order.
 * @param body - a note body.
 * @returns the flat body.
 */
export function unwrapBody(body: string): string {
  const trimmed = body.trim()
  const record = leadingRecord(trimmed)
  if (record === undefined) return trimmed
  const inner = unwrapBody(record.content)
  const rest = record.rest.trim()
  return rest === '' ? inner : `${inner}\n\n${rest}`
}

function leadingRecord(text: string): { readonly content: string; readonly rest: string } | undefined {
  if (!text.startsWith('{')) return undefined
  const end = objectEnd(text)
  if (end === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(0, end))
  } catch {
    // SyntaxError: braces that are not JSON, so the body has no record to unwrap.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const fields = parsed as Record<string, unknown>
  if (!RECORD_FIELDS.every(field => typeof fields[field] === 'string')) return undefined
  return { content: fields['content'] as string, rest: text.slice(end) }
}

/** Index just past the object that opens `text`, by brace depth outside JSON strings; undefined when it never closes. */
function objectEnd(text: string): number | undefined {
  let depth = 0
  let inString = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i += 1
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return undefined
}
