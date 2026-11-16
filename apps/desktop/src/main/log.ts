// Studio's log: what went wrong and what ran, one file a day in userData/logs
// (studio-YYYY-MM-DD.log), kept 7 days. Before it, Studio wrote nothing anywhere: opened from
// the Dock or the app grid, every error was lost, and a failure on someone else's computer
// couldn't be read. Share project puts the days a project was touched into its bundle.
//
// Never keys: lines are written through `clean`, which takes out anything that looks like one
// (a long run of letters and digits, a `token`/`key`/`authorization` field's value).

import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const KEEP_DAYS = 7

export const logDir = () => path.join(app.getPath('userData'), 'logs')
const dayOf = (d = new Date()) => d.toISOString().slice(0, 10)
const fileOf = (day: string) => path.join(logDir(), `studio-${day}.log`)

/** Anything that could be a key or token, taken out of a line. */
export function clean(text: string): string {
  return text
    .replace(/("?(?:api[_-]?key|access[_-]?token|token|authorization|xi-api-key|secret|password)"?\s*[:=]\s*)("[^"]*"|[^\s,}]+)/gi, '$1"…"')
    .replace(/\b(sk|pk|xi|key|tok)[-_][A-Za-z0-9_-]{12,}\b/g, '…')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, (m) => (/[a-z]/.test(m) && /[A-Z0-9]/.test(m) ? '…' : m))
}

let started = false
let stream: fs.WriteStream | null = null
let streamDay = ''

function open() {
  const day = dayOf()
  if (stream && streamDay === day) return stream
  stream?.end()
  fs.mkdirSync(logDir(), { recursive: true })
  stream = fs.createWriteStream(fileOf(day), { flags: 'a' })
  stream.on('error', () => {
    stream = null
  })
  streamDay = day
  return stream
}

/** One line: the time, where it's from (main, engine, page, drag, a service), and what. */
export function log(kind: string, what: unknown) {
  try {
    const text = typeof what === 'string' ? what : JSON.stringify(what)
    open()?.write(`${new Date().toISOString()} ${kind} ${clean(text).replace(/\n/g, '\n    ')}\n`)
  } catch {
    /* the log never stops the app */
  }
}

/** The log files of the given days (YYYY-MM-DD) that exist. */
export function logFiles(days: string[]) {
  return [...new Set(days)].map(fileOf).filter((f) => fs.existsSync(f))
}

/**
 * Starts the log (once): the app's version and commit, the system, uncaught errors and promise
 * rejections in the main process; files older than KEEP_DAYS go.
 */
export function startLog() {
  if (started) return
  started = true
  try {
    fs.mkdirSync(logDir(), { recursive: true })
    const cutoff = Date.now() - KEEP_DAYS * 86_400_000
    for (const f of fs.readdirSync(logDir())) {
      const m = /^studio-(\d{4}-\d{2}-\d{2})\.log$/.exec(f)
      if (m && Date.parse(m[1]) < cutoff) fs.rmSync(path.join(logDir(), f), { force: true })
    }
  } catch {
    /* an unreadable folder only means nothing is pruned */
  }
  log('start', { version: app.getVersion(), commit: commitOf(), electron: process.versions.electron, os: `${os.type()} ${os.release()}`, arch: process.arch, platform: process.platform })
  process.on('uncaughtException', (e) => log('main.error', e.stack ?? String(e)))
  process.on('unhandledRejection', (e) => log('main.rejection', e instanceof Error ? (e.stack ?? e.message) : String(e)))
}

/** The git commit the app was built from, when it runs from a checkout (as Studio is installed). */
export function commitOf(): string {
  try {
    const root = path.resolve(app.getAppPath(), '../..')
    const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim()
    if (!head.startsWith('ref: ')) return head.slice(0, 12)
    const ref = head.slice(5)
    const loose = path.join(root, '.git', ref)
    if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf8').trim().slice(0, 12)
    const packed = fs.readFileSync(path.join(root, '.git', 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`))
    return packed ? packed.slice(0, 12) : ''
  } catch {
    return ''
  }
}
