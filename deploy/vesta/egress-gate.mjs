// Vesta egress gate — a Node preload for the harness process only.
//
// Loaded through the unit's NODE_OPTIONS=--import=…/egress-gate.mjs. It hooks net.Socket.prototype.connect,
// the one path every outbound TCP connection in Node takes (http, https, tls, undici fetch, WebSocket), and
// refuses any destination outside the allowlist before a DNS lookup happens. Processes the harness spawns
// (bash, the terminal, the PTC runtime, LSP servers) are NOT gated: the module removes its own --import from
// NODE_OPTIONS at load, so children inherit a clean environment and keep their internet access, and MCP
// servers are separate processes anyway. Decision D26 in VESTA.md; the record is egress-appraisal-2026-10-02.md.
//
// Allowed by default: loopback, 192.168.0.0/16 (LiteLLM), the tailnet (100.64.0.0/10, fd7a:115c:a1e0::/48),
// link-local, unix sockets, and the Web Push services vesta-notify delivers to. VESTA_EGRESS_ALLOW adds
// hosts (exact or `.suffix`) and CIDRs, comma-separated. VESTA_EGRESS_GATE=off disables the hook (logged).

import net from 'node:net'
import { isIPv4, isIPv6 } from 'node:net'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const TAG = 'vesta-egress-gate'

const DEFAULT_HOSTS = [
  'localhost',
  'push.apple.com', '.push.apple.com',
  'fcm.googleapis.com',
  'notify.windows.com', '.notify.windows.com',
  'push.services.mozilla.com', '.push.services.mozilla.com',
]
const DEFAULT_CIDRS = [
  '127.0.0.0/8', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16',
  '::1/128', 'fe80::/10', 'fd7a:115c:a1e0::/48',
]

/** Strip this module's own --import from NODE_OPTIONS so child processes are not gated. */
function detachFromChildren() {
  const raw = process.env.NODE_OPTIONS
  if (raw === undefined) return
  const kept = []
  const parts = raw.split(/\s+/).filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part === '--import' && parts[i + 1] !== undefined && matchesSelf(parts[i + 1])) { i++; continue }
    if (part.startsWith('--import=') && matchesSelf(part.slice('--import='.length))) continue
    kept.push(part)
  }
  if (kept.length === 0) delete process.env.NODE_OPTIONS
  else process.env.NODE_OPTIONS = kept.join(' ')
}

function matchesSelf(value) {
  const plain = value.startsWith('file://') ? fileURLToPath(value) : value
  return plain === SELF || plain.endsWith('/deploy/vesta/egress-gate.mjs')
}

/** Parse "a.b.c.d/n" or "x::/n" into a matcher over a 128-bit view; IPv4 is mapped into ::ffff:0:0/96. */
function cidr(text) {
  const [addr, bitsText] = text.split('/')
  const v4 = isIPv4(addr)
  const bits = BigInt(bitsText === undefined ? (v4 ? 32 : 128) : Number(bitsText)) + (v4 ? 96n : 0n)
  const base = toBig(addr)
  const mask = bits === 0n ? 0n : ((1n << bits) - 1n) << (128n - bits)
  return (ip) => ((ip ^ base) & mask) === 0n
}

/** An IPv4 or IPv6 literal as a 128-bit integer; IPv4 and IPv4-mapped IPv6 share one value. */
function toBig(addr) {
  let a = addr
  const zone = a.indexOf('%')
  if (zone !== -1) a = a.slice(0, zone)
  if (isIPv4(a)) {
    const [p, q, r, s] = a.split('.').map(Number)
    return (0xffffn << 32n) | BigInt(((p << 24) | (q << 16) | (r << 8) | s) >>> 0)
  }
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped) return toBig(mapped[1])
  const [head, tail = ''] = a.split('::')
  const hs = head === '' ? [] : head.split(':')
  const ts = tail === '' ? [] : tail.split(':')
  const groups = [...hs, ...new Array(8 - hs.length - ts.length).fill('0'), ...ts]
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g || '0', 16)), 0n)
}

function build() {
  const extra = (process.env.VESTA_EGRESS_ALLOW ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const hosts = [...DEFAULT_HOSTS]
  const ranges = [...DEFAULT_CIDRS]
  for (const item of extra) (item.includes('/') || isIPv4(item) || isIPv6(item) ? ranges : hosts).push(item)
  const matchers = ranges.map(cidr)
  return { hosts, ranges, matchers }
}

const policy = build()

/**
 * Whether a destination host (hostname or IP literal) may be connected to.
 * @param {string} host
 * @returns {boolean}
 */
export function isAllowed(host) {
  if (typeof host !== 'string' || host.length === 0) return false
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (isIPv4(h) || isIPv6(h)) {
    const ip = toBig(h)
    return policy.matchers.some((m) => m(ip))
  }
  const name = h.endsWith('.') ? h.slice(0, -1) : h
  return policy.hosts.some((rule) => rule.startsWith('.') ? name.endsWith(rule) || name === rule.slice(1) : name === rule)
}

/** host/port from the many shapes of net.Socket#connect arguments; null for a unix socket path. */
function destination(args) {
  // net.createConnection() hands Socket#connect its already-normalized [options, callback] array.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0]
  if (first !== null && typeof first === 'object') {
    if (typeof first.path === 'string') return null
    return { host: first.host ?? 'localhost', port: Number(first.port) }
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return null
  const host = typeof args[1] === 'string' ? args[1] : 'localhost'
  return { host, port: Number(first) }
}

const recent = new Map()
let denied = 0

function logDenied(host, port) {
  denied++
  const key = `${host}:${port}`
  const now = Date.now()
  const last = recent.get(key) ?? 0
  if (now - last < 60_000) return
  recent.set(key, now)
  const frame = (new Error().stack ?? '').split('\n').slice(3)
    .find((l) => !l.includes('egress-gate.mjs') && !l.includes('node:')) ?? ''
  process.stderr.write(`${TAG}: denied ${key} (${denied} so far)${frame ? ` at${frame.trim().replace(/^at/, '')}` : ''}\n`)
}

function install() {
  const original = net.Socket.prototype.connect
  net.Socket.prototype.connect = function gatedConnect(...args) {
    const dest = destination(args)
    if (dest !== null && !isAllowed(dest.host)) {
      logDenied(dest.host, dest.port)
      const err = new Error(`${TAG}: connection to ${dest.host}:${dest.port} refused by the Vesta egress policy`)
      err.code = 'EGRESS_DENIED'
      err.syscall = 'connect'
      err.address = dest.host
      err.port = dest.port
      process.nextTick(() => this.destroy(err))
      return this
    }
    return original.apply(this, args)
  }
}

detachFromChildren()
if (process.env.VESTA_EGRESS_GATE === 'off') {
  process.stderr.write(`${TAG}: OFF by VESTA_EGRESS_GATE=off\n`)
} else {
  install()
  process.stderr.write(`${TAG}: active (hosts ${policy.hosts.length}, ranges ${policy.ranges.length}); child processes not gated\n`)
}
