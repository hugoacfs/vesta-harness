import { describe, expect, it } from 'vitest'
import { CodeDesk } from '../src/codes.ts'

function desk(overrides: Partial<ConstructorParameters<typeof CodeDesk>[0]> = {}) {
  let now = 1_000_000
  const clock = { now: () => now, advance: (ms: number) => { now += ms } }
  const instance = new CodeDesk({
    digits: 6,
    ttlMs: 300_000,
    maxAttempts: 3,
    cooldownMs: 30_000,
    hourlyLimit: 3,
    now: clock.now,
    randomDigit: () => 7,
    ...overrides,
  })
  return { desk: instance, clock }
}

describe('CodeDesk', () => {
  it('issues a code of the configured digits and accepts it once', () => {
    const { desk: d } = desk()
    const issued = d.issue('hugo')
    expect(issued.ok).toBe(true)
    if (!issued.ok) return
    expect(issued.code).toBe('777777')
    expect(d.pending(issued.id)).toBe(true)
    expect(d.check(issued.id, '777 777', 'hugo')).toBe('ok')
    expect(d.check(issued.id, '777777', 'hugo')).toBe('unknown')
  })

  it('counts wrong tries and burns the code past the limit', () => {
    const { desk: d } = desk()
    const issued = d.issue('hugo')
    if (!issued.ok) throw new Error('issue failed')
    expect(d.check(issued.id, '000000', 'hugo')).toBe('wrong')
    expect(d.check(issued.id, '000000', 'hugo')).toBe('wrong')
    expect(d.check(issued.id, '000000', 'hugo')).toBe('tries')
    expect(d.check(issued.id, '777777', 'hugo')).toBe('unknown')
  })

  it('expires a code after its lifetime', () => {
    const { desk: d, clock } = desk()
    const issued = d.issue('hugo')
    if (!issued.ok) throw new Error('issue failed')
    clock.advance(300_000)
    expect(d.pending(issued.id)).toBe(false)
    expect(d.check(issued.id, '777777', 'hugo')).toBe('unknown')
  })

  it('refuses a code redeemed by a different identity', () => {
    const { desk: d } = desk()
    const issued = d.issue('hugo')
    if (!issued.ok) throw new Error('issue failed')
    expect(d.check(issued.id, '777777', 'someone')).toBe('unknown')
    expect(d.check(issued.id, '777777', 'hugo')).toBe('ok')
  })

  it('enforces the cooldown and the hourly limit per identity', () => {
    const { desk: d, clock } = desk()
    expect(d.issue('hugo').ok).toBe(true)
    expect(d.issue('hugo')).toEqual({ ok: false, reason: 'cooldown' })
    clock.advance(30_000)
    expect(d.issue('hugo').ok).toBe(true)
    clock.advance(30_000)
    expect(d.issue('hugo').ok).toBe(true)
    clock.advance(30_000)
    expect(d.issue('hugo')).toEqual({ ok: false, reason: 'hourly' })
    expect(d.issue('other').ok).toBe(true)
    clock.advance(60 * 60 * 1000)
    expect(d.issue('hugo').ok).toBe(true)
  })
})
