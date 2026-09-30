import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_SUBSCRIPTIONS, PushStore } from '../src/push-store.ts'
import type { PushSubscriptionRecord } from '../src/push.ts'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vesta-push-store-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function subscription(n: number): PushSubscriptionRecord {
  return { endpoint: `https://web.push.apple.com/device-${String(n)}`, keys: { p256dh: 'p', auth: 'a' }, createdAt: n }
}

describe('PushStore', () => {
  it('creates the file with a key pair on first use and keeps the same pair afterwards', async () => {
    const file = join(dir, 'nested', 'vesta-push.json')
    const first = new PushStore(file)
    await first.ready()
    const pair = first.vapid
    expect(pair.publicKey.length).toBeGreaterThan(80)
    const second = new PushStore(file)
    await second.ready()
    expect(second.vapid).toEqual(pair)
    expect(second.list()).toEqual([])
  })

  it('writes the file readable by its owner only', async () => {
    if (process.platform === 'win32') return
    const file = join(dir, 'vesta-push.json')
    await new PushStore(file).ready()
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('persists subscriptions across a reload, replacing one with the same endpoint', async () => {
    const file = join(dir, 'vesta-push.json')
    const store = new PushStore(file)
    await store.ready()
    await store.add(subscription(1))
    await store.add(subscription(2))
    await store.add({ ...subscription(1), createdAt: 99 })
    const reloaded = new PushStore(file)
    await reloaded.ready()
    expect(reloaded.list().map(item => [item.endpoint.slice(-8), item.createdAt])).toEqual([['device-2', 2], ['device-1', 99]])
  })

  it('removes a subscription and ignores an unknown endpoint', async () => {
    const store = new PushStore(join(dir, 'vesta-push.json'))
    await store.ready()
    await store.add(subscription(1))
    await store.remove('https://web.push.apple.com/nobody')
    expect(store.list()).toHaveLength(1)
    await store.remove(subscription(1).endpoint)
    expect(store.list()).toEqual([])
  })

  it('keeps only the newest subscriptions beyond the cap', async () => {
    const store = new PushStore(join(dir, 'vesta-push.json'))
    await store.ready()
    for (let n = 1; n <= MAX_SUBSCRIPTIONS + 3; n += 1) await store.add(subscription(n))
    expect(store.list()).toHaveLength(MAX_SUBSCRIPTIONS)
    expect(store.list()[0]?.createdAt).toBe(4)
  })

  it('serialises concurrent changes so none is lost', async () => {
    const file = join(dir, 'vesta-push.json')
    const store = new PushStore(file)
    await store.ready()
    await Promise.all([1, 2, 3, 4, 5].map(n => store.add(subscription(n))))
    const reloaded = new PushStore(file)
    await reloaded.ready()
    expect(reloaded.list()).toHaveLength(5)
  })

  it('refuses a damaged file instead of regenerating the key pair', async () => {
    const file = join(dir, 'vesta-push.json')
    await writeFile(file, '{not json')
    await expect(new PushStore(file).ready()).rejects.toThrow('not valid JSON')
    await writeFile(file, JSON.stringify({ version: 2, vapid: {}, subscriptions: [] }))
    await expect(new PushStore(file).ready()).rejects.toThrow('version 2')
    await writeFile(file, JSON.stringify({ version: 1, vapid: { publicKey: 'x', privateKey: 'y' }, subscriptions: [] }))
    await expect(new PushStore(file).ready()).rejects.toThrow('malformed VAPID')
    const store = new PushStore(join(dir, 'other.json'))
    await store.ready()
    const good = JSON.parse(await readFile(join(dir, 'other.json'), 'utf8')) as { vapid: unknown }
    await writeFile(file, JSON.stringify({ version: 1, vapid: good.vapid, subscriptions: [{ endpoint: 1 }] }))
    await expect(new PushStore(file).ready()).rejects.toThrow('malformed subscriptions')
    expect(await readFile(file, 'utf8')).toContain('"endpoint":1')
  })

  it('refuses use before the file is loaded', () => {
    const store = new PushStore(join(dir, 'vesta-push.json'))
    expect(() => store.list()).toThrow('not loaded')
  })
})
