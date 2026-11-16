// Share project and Open shared project, and the path rewriting a moved project needs.
//
// A project keeps absolute paths everywhere (its media, which are mostly outside its folder; its
// cache; its dubs', translations' and stems' job files), so a copied folder still pointed into
// the original (Save As and Duplicate made such copies: deleting the original broke them), and
// one sent to another computer pointed nowhere.
//
// Share project writes `<name>.studio.zip`:
//   <name>.studio/…   the project folder, without what Studio makes again by itself (posters,
//                     filmstrips, waveforms, proxies; `cache/voices` is kept: it cost a transcript)
//   external/…        every file outside the folder it uses (media, a dub's source…), once each
//   logs/…            Studio's log of the days the project was worked on (main/log.ts), for
//                     reading what went wrong; never keys (they're kept out of the log)
//   share.json        what it is: the original folder, where each outside file went, the app's
//                     version and commit, the system
//   report.txt        the same facts as Help › Report a problem
// Never anything else of the app's own (keys, accounts, settings).
//
// Open shared project unzips it into the projects folder and points every path at its new place.

import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { commitOf, log, logFiles } from './log'
import { extractItem, listZip, writeZip, type ZipEntry } from './zip'
import { folderSwap, jsonFiles, rewritePaths, swapStrings } from './moved'
export { folderSwap, rewritePaths }

const inside = (dir: string, p: string) => {
  const rel = path.relative(dir, p)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** The project's files for the bundle: all of it but what Studio makes again (and half-written files). */
function projectEntries(dir: string, root: string): ZipEntry[] {
  const out: ZipEntry[] = []
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      const f = path.join(d, e.name)
      if (e.isDirectory()) {
        if (rel === 'cache' && e.name !== 'voices') continue
        walk(f, r)
      } else if (e.isFile() && !/\.(part|tmp|download)$/i.test(e.name)) out.push({ name: `${root}/${r}`, file: f })
    }
  }
  walk(dir, '')
  return out
}

/** Every file outside the project its JSON files name (media, a dub's source, a picked voice file), once each. */
function outsideFiles(dir: string): string[] {
  const found = new Set<string>()
  for (const f of jsonFiles(dir)) {
    try {
      swapStrings(JSON.parse(fs.readFileSync(f, 'utf8')), (s) => {
        if (s.length < 3 || !path.isAbsolute(s) || inside(dir, s) || found.has(s)) return null
        // A whole folder (a translation's source project, a linked folder) isn't sent: its files are, as used.
        if (fs.statSync(s, { throwIfNoEntry: false })?.isFile()) found.add(s)
        return null
      })
    } catch {
      /* skipped */
    }
  }
  return [...found]
}

/** The days the project was worked on lately (from its history), for its logs. */
function workedDays(dir: string): string[] {
  const days = new Set([new Date().toISOString().slice(0, 10)])
  try {
    const lines = fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8').trim().split('\n').slice(-500)
    for (const l of lines) {
      const t = (JSON.parse(l) as { time?: string }).time
      if (t && Date.now() - Date.parse(t) < 8 * 86_400_000) days.add(t.slice(0, 10))
    }
  } catch {
    /* no history: today's log only */
  }
  return [...days]
}

export interface ShareManifest {
  format: 1
  name: string
  /** The project folder it came from, and its name inside the zip. */
  original: string
  root: string
  /** Each outside file: where it was, and where it is in the zip. */
  files: { from: string; to: string }[]
  studio: { version: string; commit: string }
  system: { platform: string; arch: string; os: string }
  created: string
}

/**
 * The project in `dir` as one zip at `out` (see the top of this file). `report`: the facts the
 * page knows (FFmpeg, encoders, sound device), put in report.txt.
 */
export async function shareProject(dir: string, out: string, report: string, progress?: (done: number, total: number) => void) {
  const name = path.basename(dir).replace(/\.studio$/i, '') || 'Project'
  const root = `${name}.studio`
  const entries = projectEntries(dir, root)
  const files: ShareManifest['files'] = []
  const used = new Set<string>()
  for (const [i, f] of outsideFiles(dir).entries()) {
    let to = `external/${i + 1}-${path.basename(f)}`
    while (used.has(to)) to = `external/${i + 1}-x-${path.basename(f)}`
    used.add(to)
    files.push({ from: f, to })
    entries.push({ name: to, file: f })
  }
  for (const f of logFiles(workedDays(dir))) entries.push({ name: `logs/${path.basename(f)}`, file: f })
  const manifest: ShareManifest = {
    format: 1,
    name,
    original: dir,
    root,
    files,
    studio: { version: app.getVersion(), commit: commitOf() },
    system: { platform: process.platform, arch: process.arch, os: `${os.type()} ${os.release()}` },
    created: new Date().toISOString(),
  }
  entries.push({ name: 'share.json', data: Buffer.from(JSON.stringify(manifest, null, 1)) })
  entries.push({ name: 'report.txt', data: Buffer.from(`${report.trim()}\n\nStudio ${manifest.studio.version}${manifest.studio.commit ? ` (${manifest.studio.commit})` : ''} · ${manifest.system.os} · ${manifest.system.arch}\nShared ${manifest.created}\n`) })
  const r = await writeZip(entries, out, progress)
  log('share', { project: name, files: entries.length, outside: files.length, bytes: r.bytes })
  return { out, bytes: r.bytes, files: entries.length, outside: files.length }
}

/** The project in a shared zip, unzipped into `projectsDir` with every path pointed at its new place. Returns its folder. */
export async function openShared(zip: string, projectsDir: string, freeDir: (parent: string, name: string) => string, progress?: (done: number, total: number) => void) {
  const items = listZip(zip)
  const man = items.find((i) => i.name === 'share.json')
  if (!man) throw new Error('That zip wasn’t made by Share project (it has no share.json).')
  const tmp = path.join(os.tmpdir(), `studio-share-${process.pid}-${Date.now()}.json`)
  await extractItem(zip, man, tmp)
  const m = JSON.parse(fs.readFileSync(tmp, 'utf8')) as ShareManifest
  fs.rmSync(tmp, { force: true })
  if (m.format !== 1 || !m.root) throw new Error('That shared project is from a newer Studio.')
  const to = freeDir(projectsDir, m.name)
  const total = items.reduce((n, i) => n + i.size, 0)
  let done = 0
  const safe = (rel: string) => {
    const p = path.join(to, rel)
    if (!inside(to, p)) throw new Error(`${rel} would land outside the project.`)
    return p
  }
  for (const it of items) {
    if (it.name.endsWith('/')) continue
    let rel: string | null = null
    if (it.name.startsWith(`${m.root}/`)) rel = it.name.slice(m.root.length + 1)
    else if (it.name.startsWith('external/')) rel = it.name
    else if (it.name.startsWith('logs/') || it.name === 'share.json' || it.name === 'report.txt') rel = `shared/${it.name}`
    if (!rel) continue
    await extractItem(zip, it, safe(rel))
    done += it.size
    progress?.(done, total)
  }
  if (!fs.existsSync(path.join(to, 'project.json'))) throw new Error('That shared project has no project.json.')
  // Every path: the original folder → this one; each outside file → its copy in external/.
  const inProject = folderSwap(m.original, to)
  const outside = new Map(m.files.map((f) => [f.from.replace(/\\/g, '/'), path.join(to, ...f.to.split('/'))]))
  rewritePaths(to, (s) => outside.get(s.replace(/\\/g, '/')) ?? inProject(s))
  // Posters, filmstrips, waveforms and proxies weren't sent: cleared, so the engine makes them
  // again as the project opens and the page never asks for a file that isn't there.
  const pj = path.join(to, 'project.json')
  const project = JSON.parse(fs.readFileSync(pj, 'utf8')) as { media?: Record<string, unknown>[] }
  for (const m of project.media ?? [])
    for (const k of ['poster', 'strip', 'peaks', 'proxy'])
      if (typeof m[k] === 'string' && !fs.existsSync(m[k] as string)) m[k] = null
  fs.writeFileSync(pj, JSON.stringify(project, null, 1))
  log('share.open', { project: m.name, from: m.system.platform, files: items.length })
  return to
}
