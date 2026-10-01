/**
 * The code desk of `vesta-login`: issues one-time codes, remembers them hashed
 * for a short while, and judges the attempts. Pure apart from the injectable
 * clock and randomness, so it runs under test without a browser or Telegram.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

/** Why a code could not be issued. */
export type IssueRefusal = 'cooldown' | 'hourly'

/** A fresh code and its challenge id, or why the desk refused. */
export type IssueOutcome =
  | { readonly ok: true; readonly id: string; readonly code: string }
  | { readonly ok: false; readonly reason: IssueRefusal }

/** The outcome of checking a typed code. */
export type CheckOutcome = 'ok' | 'wrong' | 'expired' | 'tries' | 'unknown'

/** Limits the desk enforces. */
export interface CodeDeskOptions {
  /** Digits in a code. @default 6 */
  readonly digits: number
  /** How long a code may be redeemed, in ms. */
  readonly ttlMs: number
  /** Wrong tries a code survives; the next wrong one burns it. */
  readonly maxAttempts: number
  /** Minimum gap between two codes for the same identity, in ms. */
  readonly cooldownMs: number
  /** Codes one identity may request per hour. */
  readonly hourlyLimit: number
  /** Clock, epoch ms. @default Date.now */
  readonly now?: () => number
  /** Random digits, for tests. @default crypto.randomInt */
  readonly randomDigit?: () => number
}

interface Challenge {
  readonly hash: Buffer
  readonly expiresAt: number
  readonly identity: string
  attempts: number
}

const HOUR_MS = 60 * 60 * 1000

function hashCode(id: string, code: string): Buffer {
  return createHash('sha256').update(`${id}:${code}`).digest()
}

/** Issue, remember and judge one-time login codes. */
export class CodeDesk {
  private readonly options: CodeDeskOptions
  private readonly challenges = new Map<string, Challenge>()
  private readonly issued = new Map<string, number[]>()

  /**
   * @param options - limits; the clock and randomness default to the system's.
   */
  constructor(options: CodeDeskOptions) {
    this.options = options
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private digit(): number {
    return (this.options.randomDigit ?? (() => randomInt(10)))()
  }

  /** Drop expired challenges and send times older than an hour. */
  private sweep(): void {
    const now = this.now()
    for (const [id, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) this.challenges.delete(id)
    }
    for (const [identity, times] of this.issued) {
      const recent = times.filter(at => now - at < HOUR_MS)
      if (recent.length === 0) this.issued.delete(identity)
      else this.issued.set(identity, recent)
    }
  }

  /**
   * Issue a code for an identity. One pending code per browser: the returned
   * id goes into the browser's pending cookie and the code to the person.
   * @param identity - who asked (the tailnet login, or `anyone` when identity is not checked).
   * @returns the challenge id and the code, or why the desk refused.
   */
  issue(identity: string): IssueOutcome {
    this.sweep()
    const now = this.now()
    const times = this.issued.get(identity) ?? []
    const last = times.at(-1)
    if (last !== undefined && now - last < this.options.cooldownMs) return { ok: false, reason: 'cooldown' }
    if (times.length >= this.options.hourlyLimit) return { ok: false, reason: 'hourly' }
    const id = randomBytes(24).toString('base64url')
    let code = ''
    for (let index = 0; index < this.options.digits; index += 1) code += String(this.digit())
    this.challenges.set(id, { hash: hashCode(id, code), expiresAt: now + this.options.ttlMs, identity, attempts: 0 })
    this.issued.set(identity, [...times, now])
    return { ok: true, id, code }
  }

  /**
   * Judge a typed code. A right code is spent; a wrong one counts against the
   * challenge, and the attempt past the limit burns it.
   * @param id - the challenge id from the pending cookie.
   * @param code - what was typed, spaces ignored.
   * @param identity - who is redeeming; it must be who asked.
   * @returns the outcome.
   */
  check(id: string, code: string, identity: string): CheckOutcome {
    this.sweep()
    const challenge = this.challenges.get(id)
    if (challenge === undefined) return 'unknown'
    if (challenge.identity !== identity) return 'unknown'
    if (challenge.expiresAt <= this.now()) {
      this.challenges.delete(id)
      return 'expired'
    }
    const typed = hashCode(id, code.replaceAll(/\s+/gu, ''))
    if (timingSafeEqual(typed, challenge.hash)) {
      this.challenges.delete(id)
      return 'ok'
    }
    challenge.attempts += 1
    if (challenge.attempts >= this.options.maxAttempts) {
      this.challenges.delete(id)
      return 'tries'
    }
    return 'wrong'
  }

  /** Whether a challenge is still open, for the page's state. */
  pending(id: string): boolean {
    this.sweep()
    return this.challenges.has(id)
  }
}
