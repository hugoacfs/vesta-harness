#!/usr/bin/env node
// vesta-migrate-sessions — bring rc.7 (format v0) sessions into the Vesta Harness home.
//
// For every session directory under <source-root>/<workspace>/ that is not yet in
// <target-root>/<workspace>/, copy it (the v0 file stays untouched as the retained
// generation) and open it through the real JSONL persistence provider, which
// publishes the current-format generation (session.v2.jsonl.zstd) next to it.
// Pre-migrating here keeps the web process's session index from doing a
// multi-second migration inside a search request (which aborts the search).
//
// Forks (headers with parentSession/seedLength, whose own events are numbered
// from seq 0 in rc.7) are skipped unless --include-forks is given: the released
// v0 → v1 edge treats seq < seedLength as inherited, so they do not migrate cleanly.
//
// Runs from anywhere inside the built checkout (it resolves the provider package relative to itself):
//   node ~/code/vesta-harness/deploy/vesta/bin/vesta-migrate-sessions.mjs ~/.dsh/sessions ~/.vesta-harness/sessions
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const providerDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/session/session-persistence-jsonl')
const require = createRequire(join(providerDir, 'package.json'))
const { Context } = await import(require.resolve('@deepseek-ai/cordis'))
const Provider = (await import(join(providerDir, 'lib/index.js'))).default

const args = process.argv.slice(2)
const includeForks = args.includes('--include-forks')
const dryRun = args.includes('--dry-run')
const [sourceRoot, targetRoot] = args.filter(a => !a.startsWith('--'))
if (!sourceRoot || !targetRoot) {
  console.error('usage: vesta-migrate-sessions.mjs [--dry-run] [--include-forks] <source sessions root> <target sessions root>')
  process.exit(64)
}

const provider = new Provider(new Context(), { root: targetRoot, compression: 'zstd' })

function headerOf(dir) {
  const zstd = join(dir, 'session.jsonl.zstd')
  const plain = join(dir, 'session.jsonl')
  const first = existsSync(zstd)
    ? execFileSync('zstd', ['-dc', '--', zstd], { maxBuffer: 1 << 30 }).toString().split('\n', 1)[0]
    : existsSync(plain) ? readFileSync(plain, 'utf8').split('\n', 1)[0] : undefined
  if (first === undefined) return undefined
  try { return JSON.parse(first) } catch { return undefined }
}

const summary = { copied: 0, migrated: 0, skippedPresent: 0, skippedForks: 0, failed: 0 }
for (const workspace of readdirSync(sourceRoot)) {
  const sourceWs = join(sourceRoot, workspace)
  if (!statSync(sourceWs).isDirectory()) continue
  const targetWs = join(targetRoot, workspace)
  for (const name of readdirSync(sourceWs)) {
    if (!name.startsWith('session-')) continue
    const sourceDir = join(sourceWs, name)
    const targetDir = join(targetWs, name)
    const header = headerOf(sourceDir)
    if (header === undefined) { console.log(`skip ${name}: no readable header`); continue }
    if (existsSync(targetDir)) { summary.skippedPresent += 1; continue }
    if (header.parentSession !== undefined && !includeForks) {
      summary.skippedForks += 1
      console.log(`skip ${name}: fork of ${header.parentSession} (seedLength ${header.seedLength}); use --include-forks to try`)
      continue
    }
    if (dryRun) { console.log(`would migrate ${workspace}/${name}`); continue }
    mkdirSync(targetWs, { recursive: true, mode: 0o700 })
    cpSync(sourceDir, targetDir, { recursive: true, preserveTimestamps: true })
    summary.copied += 1
    const t0 = Date.now()
    try {
      const handle = await provider.open(header.id, 'read')
      const events = await handle.read(0, undefined)
      await handle.close()
      summary.migrated += 1
      console.log(`migrated ${name}: ${events.length} events in ${Date.now() - t0} ms`)
    } catch (error) {
      summary.failed += 1
      console.log(`FAILED ${name}: ${String(error?.message ?? error).slice(0, 300)}`)
      rmSync(targetDir, { recursive: true, force: true })
      console.log(`  removed ${targetDir} again (a refused log would break the session index)`)
    }
  }
}
console.log(JSON.stringify(summary))
process.exit(summary.failed > 0 ? 1 : 0)
