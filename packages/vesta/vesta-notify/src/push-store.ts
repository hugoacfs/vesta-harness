/**
 * Persistent state of the Web Push channel: the server's VAPID key pair and
 * the browsers subscribed to it, in one JSON file (0600) in the Harness home.
 *
 * The private key never leaves this file, and subscriptions are bearer
 * endpoints (anyone holding one plus the VAPID key can push to that device),
 * so the file gets the same protection as `.credentials.yaml`.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { generateVapidKeys, isVapidKeys } from './push.ts'
import type { PushSubscriptionRecord, VapidKeys } from './push.ts'

/** The file format; a different number is refused rather than guessed at. */
const STORE_VERSION = 1

/** A personal harness has a handful of devices; the cap only bounds file growth. */
export const MAX_SUBSCRIPTIONS = 20

interface StoreFile {
  readonly version: typeof STORE_VERSION
  readonly vapid: VapidKeys
  readonly subscriptions: readonly PushSubscriptionRecord[]
}

function isRecord(value: unknown): value is PushSubscriptionRecord {
  if (typeof value !== 'object' || value === null) return false
  const { endpoint, keys, createdAt } = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; createdAt?: unknown }
  return typeof endpoint === 'string' && typeof keys?.p256dh === 'string' && typeof keys.auth === 'string' && typeof createdAt === 'number'
}

/**
 * Parse the stored file, refusing anything unexpected: a silently regenerated key pair would orphan every subscription.
 * @param file - path, for the error text.
 * @param text - the file contents.
 * @returns the validated state.
 */
function parseStore(file: string, text: string): StoreFile {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`vesta-notify: ${file} is not valid JSON; fix or delete it (deleting drops every push subscription)`)
  }
  const { version, vapid, subscriptions } = (typeof value === 'object' && value !== null ? value : {}) as {
    version?: unknown
    vapid?: unknown
    subscriptions?: unknown
  }
  if (version !== STORE_VERSION) throw new Error(`vesta-notify: ${file} has version ${String(version)}; this build reads version ${String(STORE_VERSION)}`)
  if (!isVapidKeys(vapid)) throw new Error(`vesta-notify: ${file} holds a malformed VAPID key pair`)
  if (!Array.isArray(subscriptions) || !subscriptions.every(isRecord)) throw new Error(`vesta-notify: ${file} holds malformed subscriptions`)
  return { version: STORE_VERSION, vapid, subscriptions }
}

/** The Web Push key pair and subscription list, loaded once and persisted on every change. */
export class PushStore {
  private readonly file: string
  private state: StoreFile | undefined
  private opening: Promise<void> | undefined
  private writes: Promise<unknown> = Promise.resolve()

  /**
   * @param file - absolute path of the JSON file.
   */
  constructor(file: string) {
    this.file = file
  }

  /**
   * Load the file, creating it with a fresh VAPID key pair on first use. Safe to call repeatedly.
   * @returns a promise that settles once the state is available; rejects on an unreadable file.
   */
  ready(): Promise<void> {
    this.opening ??= this.open()
    return this.opening
  }

  private async open(): Promise<void> {
    let text: string | undefined
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (text !== undefined) {
      this.state = parseStore(this.file, text)
      return
    }
    const created: StoreFile = { version: STORE_VERSION, vapid: generateVapidKeys(), subscriptions: [] }
    await this.persist(created)
    this.state = created
  }

  private loaded(): StoreFile {
    if (this.state === undefined) throw new Error('vesta-notify: the push store is not loaded; await ready() first')
    return this.state
  }

  private async persist(next: StoreFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${String(process.pid)}.tmp`
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.file)
  }

  /** Apply one change and persist it; changes run one at a time so concurrent requests cannot interleave. */
  private change(update: (current: StoreFile) => StoreFile): Promise<void> {
    const run = async (): Promise<void> => {
      const next = update(this.loaded())
      await this.persist(next)
      this.state = next
    }
    const result = this.writes.then(run)
    this.writes = result.catch(() => undefined)
    return result
  }

  /** The server's VAPID key pair. */
  get vapid(): VapidKeys {
    return this.loaded().vapid
  }

  /** Current subscriptions, oldest first. */
  list(): readonly PushSubscriptionRecord[] {
    return this.loaded().subscriptions
  }

  /**
   * Store a subscription, replacing one with the same endpoint and dropping the oldest beyond the cap.
   * @param subscription - a validated subscription.
   */
  add(subscription: PushSubscriptionRecord): Promise<void> {
    return this.change((current) => {
      const others = current.subscriptions.filter(existing => existing.endpoint !== subscription.endpoint)
      return { ...current, subscriptions: [...others, subscription].slice(-MAX_SUBSCRIPTIONS) }
    })
  }

  /**
   * Forget a subscription.
   * @param endpoint - the endpoint to drop; unknown endpoints are ignored.
   */
  remove(endpoint: string): Promise<void> {
    return this.change(current => ({
      ...current,
      subscriptions: current.subscriptions.filter(existing => existing.endpoint !== endpoint),
    }))
  }
}
