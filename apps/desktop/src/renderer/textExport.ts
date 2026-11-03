// The Export window's text: what's on screen and what's said in the edit, saved next to the
// video as plain text (no times, one line each) or as .srt.
//   - On screen: every text clip (not captions; stickers have no letters), and overlay text a dub
//     left in the picture as filmed (the same in the new language) unless a text clip covers it
//     there, in the order they appear (top to bottom when together). Lines the layout wrapped
//     are joined; a text that shows again straight after at the same place counts once.
//   - Said: the sentences a voice Studio made speaks (a dub's, a translation's, a voiceover with
//     its script) where their clips are, and what a dub heard in a clip whose own sound plays when
//     it's in the edit's language (a TikTok sound in English under a Swedish ad isn't what she
//     says); with none of those, the captions.
// With both, each part is headed "-- On-screen text" / "-- What she says", as the user writes them.

import { captionTracks } from './captions'
import { mediaById, type Clip, type Snapshot } from './store'

export type TextCue = { startUs: number; endUs: number; text: string }
export type EditText = { screen: TextCue[]; said: TextCue[]; saidLang: string; fromCaptions: boolean }
export type TextWhat = 'both' | 'screen' | 'said'

const letters = /\p{L}/u
const same = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()
const lower = (p: string) => p.replace(/\//g, '\\').toLowerCase()

/** A span of a clip's source on the timeline, where the clip plays it. */
function onTimeline(c: Clip, fromUs: number, toUs: number): [number, number] | null {
  const speed = c.speed ?? 1
  const a = c.inUs, b = c.inUs + c.durationUs * speed
  const lo = Math.max(a, fromUs), hi = Math.min(b, toUs)
  return hi - lo > 100_000 ? [c.startUs + (lo - a) / speed, c.startUs + (hi - a) / speed] : null
}

export async function textOf(snap: Snapshot): Promise<EditText> {
  const p = snap.project
  const path = (c: Clip) => mediaById(snap, c.mediaId)?.path ?? ''
  // Clips whose sound is heard: on sound tracks not muted, and main-track clips with their own sound on.
  const audible = p.tracks.flatMap((t) => (t.mute ? [] : t.kind === 'audio' ? t.clips : t.main ? t.clips.filter((c) => !c.detached) : [])).filter((c) => c.volume > 0)
  const ctx = await window.studio.services.translateContext(snap.dir, [...new Set(audible.map(path).filter(Boolean))])
  if ('error' in ctx) throw new Error(ctx.error)

  // On screen.
  type Placed = TextCue & { y: number; x: number; clip: boolean }
  const placed: Placed[] = []
  for (const t of p.tracks) {
    if (t.kind !== 'video' || t.main || t.hidden || t.role === 'captions') continue
    for (const c of t.clips) {
      const text = c.text?.content ?? ''
      if (c.caption || !letters.test(text)) continue
      placed.push({ startUs: c.startUs, endUs: c.startUs + c.durationUs, text, y: c.posY ?? 0, x: c.posX ?? 0, clip: true })
    }
  }
  const main = p.tracks.find((t) => t.main)?.clips ?? []
  for (const f of ctx.filmed)
    for (const c of main.filter((m) => lower(path(m)).includes(f.dir.toLowerCase()))) {
      const span = onTimeline(c, f.startUs, f.endUs)
      if (span) placed.push({ startUs: span[0], endUs: span[1], text: f.text, y: (f.box.y + f.box.h / 2 - 0.5) * p.height, x: (f.box.x + f.box.w / 2 - 0.5) * p.width, clip: false })
    }
  const near = 150 * (p.height / 1920)
  const covered = (i: Placed) => placed.some((c) => c.clip && c.startUs < i.endUs && i.startUs < c.endUs && Math.abs(c.y - i.y) < near)
  const order = (a: Placed, b: Placed) => Math.round(a.startUs / 1e5) - Math.round(b.startUs / 1e5) || Math.round(a.y / 120) - Math.round(b.y / 120) || a.x - b.x
  const screen: Placed[] = []
  for (const i of placed.filter((x) => x.clip || !covered(x)).sort(order)) {
    const twin = screen.find((m) => same(m.text, i.text) && Math.abs(m.y - i.y) < near && i.startUs - m.endUs < 1_000_000)
    if (twin) twin.endUs = Math.max(twin.endUs, i.endUs)
    else screen.push({ ...i })
  }

  // Said.
  let said: TextCue[] = []
  let saidLang = ''
  for (const c of audible) {
    const s = ctx.sounds[path(c)]
    if (s?.text && letters.test(s.text)) said.push({ startUs: c.startUs, endUs: c.startUs + c.durationUs, text: s.text })
  }
  for (const h of ctx.heard.filter((x) => !ctx.lang || x.language === ctx.lang))
    for (const c of audible.filter((x) => lower(path(x)) === lower(h.source)))
      for (const l of h.lines) {
        const span = onTimeline(c, l.start * 1e6, l.end * 1e6)
        if (span) {
          said.push({ startUs: span[0], endUs: span[1], text: l.text })
          saidLang = h.language
        }
      }
  let fromCaptions = false
  if (!said.length) {
    const rows = captionTracks(snap).filter((t) => t.lines.length)
    const lang = (rows.find((t) => !t.track.hidden) ?? rows[0])?.lang
    said = rows.filter((t) => t.lang === lang).flatMap((t) => t.lines.map((c) => ({ startUs: c.startUs, endUs: c.startUs + c.durationUs, text: c.text?.content ?? '' }))).filter((c) => letters.test(c.text))
    fromCaptions = said.length > 0
  }
  said.sort((a, b) => a.startUs - b.startUs)
  return { screen: screen.map(({ startUs, endUs, text }) => ({ startUs, endUs, text })), said, saidLang, fromCaptions }
}

const JOINERS = ['+', '&', ',', '/']

/** A text's lines as they read: lines the layout wrapped joined, real breaks (a heading and its line) kept. */
export function readLines(text: string): string[] {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const all = [...text].filter((c) => /\p{L}/u.test(c))
  const caps = all.length > 0 && all.every((c) => c === c.toLocaleUpperCase() && c !== c.toLocaleLowerCase())
  const out: string[] = []
  for (const l of lines) {
    const prev = out[out.length - 1]
    if (prev != null && (caps || /^\p{Ll}/u.test(l) || JOINERS.includes(l[0]) || JOINERS.some((j) => prev.endsWith(j)))) out[out.length - 1] = `${prev} ${l}`
    else out.push(l)
  }
  return out
}

/** What's said as sentences: pieces that run on (after a comma, or starting in lower case) joined, each ending in a stop. */
export function sentencesOf(cues: TextCue[]): string[] {
  const out: string[] = []
  for (const c of cues) {
    const t = c.text.replace(/\s+/g, ' ').trim()
    if (!t) continue
    if (out.length && (/[,;:–-]$/.test(out[out.length - 1]) || /^\p{Ll}/u.test(t))) out[out.length - 1] += ` ${t}`
    else out.push(t)
  }
  return out.map((s) => (/[.!?…]["”»]?$/.test(s) ? s : `${s}.`))
}


/** Plain text, no times: each on-screen text on its line, then what's said as sentences (titled when both are there). */
export function textFile(t: EditText, what: TextWhat): string {
  const screen = what === 'said' ? [] : t.screen.flatMap((c) => readLines(c.text))
  const said = what === 'screen' ? [] : sentencesOf(t.said)
  const body = screen.length && said.length ? ['-- On-screen text', ...screen, '', '-- What she says', ...said] : [...screen, ...said]
  return body.length ? `${body.join('\n')}\n` : ''
}

const srtTime = (us: number) => {
  const ms = Math.max(0, Math.round(us / 1000))
  const n = (x: number, w = 2) => String(x).padStart(w, '0')
  return `${n(Math.floor(ms / 3_600_000))}:${n(Math.floor(ms / 60_000) % 60)}:${n(Math.floor(ms / 1000) % 60)},${n(ms % 1000, 3)}`
}

/** .srt: each on-screen text and each spoken line when it's there, in time order. */
export function srtFile(t: EditText, what: TextWhat): string {
  const cues = [...(what === 'said' ? [] : t.screen.map((c) => ({ ...c, text: readLines(c.text).join('\n') }))), ...(what === 'screen' ? [] : t.said)].sort((a, b) => a.startUs - b.startUs)
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.startUs)} --> ${srtTime(c.endUs)}\n${c.text.trim()}\n`).join('\n')
}
