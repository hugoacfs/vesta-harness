import { describe, expect, it } from 'vitest'
import { noteBody, unwrapBody } from '../src/note-record.ts'

/** A `memory_read` answer as the store serialises it (indented JSON). */
function answer(content: string, name = 'subject-note'): string {
  return JSON.stringify({
    name,
    description: 'One line about the subject',
    scope: 'fact',
    project: null,
    created: '2026-09-01',
    updated: '2026-09-23',
    content,
    path: `/memory/notes/fact/${name}.md`,
    content_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  }, null, 2)
}

describe('noteBody', () => {
  it('returns the content field of a memory_read record', () => {
    expect(noteBody(answer('The fact.\n\n**Why:** the reason.'))).toBe('The fact.\n\n**Why:** the reason.')
  })

  it('returns the body under a frontmatter block', () => {
    expect(noteBody('---\nname: subject-note\nscope: fact\n---\n\nThe fact.\n')).toBe('The fact.')
  })

  it('unwraps records nested by earlier updates and keeps the updates in order', () => {
    const once = `${answer('Base fact.')}\n\n**Update (2026-09-20, auto-captured by Vesta):** first change.`
    const twice = `${answer(once)}\n\n**Update (2026-09-23, auto-captured by Vesta):** second change.`
    expect(noteBody(answer(twice))).toBe([
      'Base fact.',
      '**Update (2026-09-20, auto-captured by Vesta):** first change.',
      '**Update (2026-09-23, auto-captured by Vesta):** second change.',
    ].join('\n\n'))
  })

  it('keeps a body that starts with a brace but holds no record', () => {
    expect(noteBody(answer('{curly} braces lead this sentence.'))).toBe('{curly} braces lead this sentence.')
    expect(noteBody(answer('{"port": 7332} is the production endpoint.'))).toBe('{"port": 7332} is the production endpoint.')
  })

  it('returns an empty string for an empty answer', () => {
    expect(noteBody('')).toBe('')
  })
})

describe('unwrapBody', () => {
  it('leaves a capture update that reads, appends and writes twice without a nested record', () => {
    let stored = 'Base fact.\n\n**Why:** the reason.'
    for (const day of ['2026-10-01', '2026-10-02']) {
      stored = `${noteBody(answer(stored))}\n\n**Update (${day}, auto-captured by Vesta):** change on ${day}.`
    }
    expect(stored).toBe([
      'Base fact.',
      '**Why:** the reason.',
      '**Update (2026-10-01, auto-captured by Vesta):** change on 2026-10-01.',
      '**Update (2026-10-02, auto-captured by Vesta):** change on 2026-10-02.',
    ].join('\n\n'))
    expect(unwrapBody(stored)).toBe(stored)
  })

  it('keeps braces inside JSON strings from ending the record early', () => {
    const body = `${answer('A note quoting } and { inside its text.')}\n\n**Update (2026-09-30, auto-captured by Vesta):** more.`
    expect(unwrapBody(body)).toBe('A note quoting } and { inside its text.\n\n**Update (2026-09-30, auto-captured by Vesta):** more.')
  })
})
