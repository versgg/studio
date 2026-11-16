#!/usr/bin/env node
// A numbers-only report for a GitHub issue about Studio on a Mac (or any computer): the system,
// FFmpeg, the dub and translation timings Studio writes (`timing.json`), and clip drags traced
// with STUDIO_DEBUG_DRAG=1. It prints no names, paths, words, keys, ids or project content, so
// its output can be pasted into a public issue as it is. See docs/MAC-INVESTIGATION.md.
//
//   node scripts/mac-report.mjs [--projects <folder>] [--logs <folder>] [--days 7]
//
// --projects  where Studio's projects are (default: ~/Documents/Studio Projects)
// --logs      Studio's log folder (default: the app's data folder's `logs`)
// --days      how far back to look (default: 7)

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const appData = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : process.platform === 'win32' ? (process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')) : (process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'))
const projectsDir = arg('projects', process.env.STUDIO_PROJECTS_DIR ?? path.join(os.homedir(), 'Documents', 'Studio Projects'))
const logsDir = arg('logs', path.join(process.env.STUDIO_USER_DATA ?? path.join(appData, '@studio', 'desktop'), 'logs'))
const days = Number(arg('days', '7')) || 7
const since = Date.now() - days * 86_400_000

const out = []
const say = (s = '') => out.push(s)
const r2 = (x) => (x == null || Number.isNaN(x) ? '' : Math.round(x * 100) / 100)

// 1. The system and the tools.
const run = (cmd, a) => {
  try {
    return execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })
  } catch {
    return ''
  }
}
const ff = run('ffmpeg', ['-hide_banner', '-version'])
const ffVersion = /ffmpeg version (\S+)/.exec(ff)?.[1] ?? 'not found'
const has = (flag) => (ff.includes(`--enable-${flag}`) ? 'yes' : 'no')
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const commit = run('git', ['-C', repo, 'rev-parse', '--short', 'HEAD']).trim() || 'unknown'
const changed = run('git', ['-C', repo, 'status', '--porcelain']).split('\n').filter(Boolean).length
const macVersion = process.platform === 'darwin' ? run('sw_vers', ['-productVersion']).trim() : ''

say('### System')
say()
say('| | |')
say('|---|---|')
say(`| OS | ${process.platform} ${macVersion || os.release()} (${os.arch()}) |`)
say(`| CPU cores, memory | ${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GB |`)
say(`| Node | ${process.version} |`)
say(`| Studio commit | ${commit}${changed ? ` (${changed} files changed locally)` : ''} |`)
say(`| FFmpeg | ${ffVersion} · libmp3lame ${has('libmp3lame')} · libx264 ${has('libx264')} · videotoolbox ${has('videotoolbox')} |`)
say(`| ffprobe | ${run('ffprobe', ['-hide_banner', '-version']) ? 'found' : 'not found'} |`)
say()

// 2. Dub and translation timings: every timing.json in the projects, newest first, numbered.
const timings = []
const walk = (dir, depth) => {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const f = path.join(dir, e.name)
    if (e.isDirectory() && depth > 0 && e.name !== 'cache' && e.name !== 'node_modules') walk(f, depth - 1)
    else if (e.isFile() && e.name === 'timing.json') {
      const st = fs.statSync(f)
      if (st.mtimeMs >= since) timings.push({ f, at: st.mtimeMs })
    }
  }
}
walk(projectsDir, 4)
timings.sort((a, b) => b.at - a.at)

say('### Dub and translation timing')
say()
if (!timings.length) say(`No timing files from the last ${days} days (they're written by dubs and translations made with this version).`), say()
const lineTable = (lines) => {
  say('| # | said from | to | room | take | placed at | moved | tempo | length | gap after |')
  say('|---|---|---|---|---|---|---|---|---|---|')
  for (const l of lines) say(`| ${l.n} | ${r2(l.saidStart)} | ${r2(l.saidEnd)} | ${r2(l.room)} | ${r2(l.take)} | ${r2(l.at)} | ${r2(l.moved)} | ${r2(l.tempo)} | ${r2(l.length)} | ${r2(l.gapAfter)} |`)
}
const sumUp = (lines) => {
  const gaps = lines.map((l) => l.gapAfter).filter((g) => g != null)
  const big = gaps.filter((g) => g > 0.5)
  const over = lines.filter((l) => l.take > l.room + 0.05).length
  const moved = lines.map((l) => Math.abs(l.moved))
  return `${lines.length} lines · gaps over 0.5 s: ${big.length} (largest ${r2(Math.max(0, ...gaps))} s, all gaps ${r2(gaps.reduce((a, b) => a + Math.max(0, b), 0))} s) · takes longer than their room: ${over} · moved up to ${r2(Math.max(0, ...moved))} s · tempo ${r2(Math.min(...lines.map((l) => l.tempo)))}–${r2(Math.max(...lines.map((l) => l.tempo)))}`
}
timings.forEach((t, i) => {
  let j
  try {
    j = JSON.parse(fs.readFileSync(t.f, 'utf8'))
  } catch {
    return
  }
  const when = new Date(t.at).toISOString().slice(0, 16).replace('T', ' ')
  if (j.kind === 'dub') {
    say(`**Dub ${i + 1}** (${when} UTC, language ${String(j.lang).slice(0, 5)}, part ${r2(j.partEnd)} s): ${sumUp(j.lines ?? [])}`)
    say()
    lineTable(j.lines ?? [])
  } else {
    say(`**Translation ${i + 1}** (${when} UTC, language ${String(j.lang).slice(0, 5)}, timeline ${r2(j.end)} s)`)
    for (const [k, v] of (j.voices ?? []).entries()) {
      say()
      say(`Voice ${k + 1}: ${sumUp(v.lines ?? [])}`)
      say()
      lineTable(v.lines ?? [])
    }
  }
  say()
})

// 3. Clip drags traced with STUDIO_DEBUG_DRAG=1: one drag is the steps less than a second apart.
const drags = []
let logFiles = []
try {
  logFiles = fs.readdirSync(logsDir).filter((f) => /^studio-\d{4}-\d{2}-\d{2}\.log$/.test(f)).map((f) => path.join(logsDir, f))
} catch {
  /* no logs */
}
for (const f of logFiles.sort()) {
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = /^(\S+) page\.drag (\{.*\})$/.exec(line)
    if (!m) continue
    const at = Date.parse(m[1])
    if (!(at >= since)) continue
    let o
    try {
      o = JSON.parse(m[2])
    } catch {
      continue
    }
    const last = drags[drags.length - 1]
    if (!last || at - last.end > 1000) drags.push({ start: at, end: at, steps: [] })
    const d = drags[drags.length - 1]
    d.end = at
    d.steps.push(o)
  }
}
say('### Clip drags (STUDIO_DEBUG_DRAG=1)')
say()
if (!drags.length) say('No traced drags. Start Studio with STUDIO_DEBUG_DRAG=1 and drag a sound clip next to another on its row.')
else {
  say('| drag | steps | row changes | new-track lines shown | tracks top moved (px) | pointer y range (px) | snapped steps | screen scale |')
  say('|---|---|---|---|---|---|---|---|')
  drags.slice(-20).forEach((d, i) => {
    let changes = 0
    for (let k = 1; k < d.steps.length; k++) if (d.steps[k].rowId !== d.steps[k - 1].rowId || d.steps[k].newAt !== d.steps[k - 1].newAt) changes++
    const tops = d.steps.map((s) => s.tracksTop).filter((x) => typeof x === 'number')
    const ys = d.steps.map((s) => s.y)
    const lines = d.steps.filter((s) => s.line != null || s.newAt != null).length
    const snapped = d.steps.filter((s) => s.snapUs != null).length
    say(`| ${i + 1} | ${d.steps.length} | ${changes} | ${lines} | ${tops.length ? r2(Math.max(...tops) - Math.min(...tops)) : ''} | ${r2(Math.min(...ys))}–${r2(Math.max(...ys))} | ${snapped} | ${d.steps[0].dpr ?? ''} |`)
  })
}
say()

process.stdout.write(`${out.join('\n')}\n`)
