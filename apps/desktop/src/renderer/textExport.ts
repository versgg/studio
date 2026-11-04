// The Export window's text: what's on screen and what's said in the edit, saved next to the
// video as plain text (no times, one line each) or as .srt.
//   - On screen: every text clip (not captions; stickers have no letters), and overlay text a dub
//     left in the picture as filmed (the same in the new language) unless a text clip covers it
//     there, in the order they appear (top to bottom when together). Lines the layout wrapped
//     are joined; a text that shows again straight after at the same place counts once.
//   - Said: the sentences a voice Studio made speaks (a dub's, a translation's, a voiceover with
//     its script) where their clips are, and what a dub heard in a clip whose own sound plays when
//     it's in the edit's language (a TikTok sound in English under a Swedish ad isn't what she
//     says); with none of those, the captions. Each sentence once, where it's heard, however many
//     pieces its sound is cut into: a script has no times of its own, so its sentences are shared
//     out over the file by length, then set to where the captions heard their words when they did.
// With both, each part is headed "-- On-screen text" / "-- What she says", as the user writes them.

import { captionTracks, wordsOfTrack, type CaptionInfo } from './captions'
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

/**
 * Where a stretch of a file is heard in the edit, through the clips that play it: a piece that
 * carries on from the one before (further into the file, close after it) joins it, so a sentence
 * a cut runs through is there once; a stretch played twice is there twice.
 */
export function heardAt(clips: Clip[], fromUs: number, toUs: number): [number, number][] {
  const parts = clips.flatMap((c) => {
    const span = onTimeline(c, fromUs, toUs)
    return span ? [{ span, at: Math.max(c.inUs, fromUs) }] : []
  })
  parts.sort((a, b) => a.span[0] - b.span[0])
  const out: typeof parts = []
  for (const p of parts) {
    const last = out[out.length - 1]
    if (last && p.at >= last.at && p.span[0] - last.span[1] < 1_000_000) {
      last.span[1] = Math.max(last.span[1], p.span[1])
      last.at = p.at
    } else out.push({ span: [...p.span], at: p.at })
  }
  return out.map((p) => p.span)
}

/** A script's sentences: at its line breaks, and after . ! ? … where the next one starts with a capital or a number. */
export function scriptSentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((l) => l.replace(/\s+/g, ' ').trim().split(/(?<=[.!?…]["”»]?) (?=[\p{Lu}\p{N}"“«])/u))
    .filter((s) => letters.test(s))
}

/** Sentences shared out over a file of `lengthUs` by their length (a space counts as a letter), in its own time. */
function shareOut(sentences: string[], lengthUs: number) {
  const total = sentences.reduce((n, s) => n + s.length + 1, 0)
  let at = 0
  return sentences.map((text) => {
    const start = (at * lengthUs) / total
    at += text.length + 1
    return { text, start, end: (at * lengthUs) / total }
  })
}

const token = (w: string) => w.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

/** The longest run of `a` found in order in `b`: the pairs of indexes that match. */
function inOrder(a: string[], b: string[]): [number, number][] {
  const w = b.length + 1
  const t = new Uint16Array((a.length + 1) * w)
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1])
  const pairs: [number, number][] = []
  for (let i = 0, j = 0; i < a.length && j < b.length; )
    if (a[i] === b[j]) pairs.push([i++, j++])
    else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++
    else j++
  return pairs
}

/**
 * Sentences timed only by their length, set to where a captions track heard their words: each from
 * the first of its words the captions have to the last. The track with most of them, and only when
 * it has most of them (captions in another language, or of another voice, leave the times be).
 */
function timeByCaptions(cues: (TextCue & { shared?: boolean })[], tracks: CaptionInfo[]) {
  const shared = cues.filter((c) => c.shared).sort((a, b) => a.startUs - b.startUs)
  const mine = shared.flatMap((c, n) => c.text.split(/\s+/).map(token).filter(Boolean).map((w) => ({ w, n })))
  let best: { pairs: [number, number][]; words: { start: number; end: number }[] } | null = null
  for (const t of tracks) {
    const words = (wordsOfTrack(t) ?? []).map((x) => ({ ...x, w: token(x.text) })).filter((x) => x.w).sort((a, b) => a.start - b.start)
    if (!words.length || mine.length * words.length > 4_000_000) continue
    const pairs = inOrder(mine.map((m) => m.w), words.map((x) => x.w))
    if (!best || pairs.length > best.pairs.length) best = { pairs, words }
  }
  if (!best || best.pairs.length < mine.length * 0.6) return
  const span = new Map<number, [number, number]>()
  for (const [i, j] of best.pairs) {
    const n = mine[i].n, x = best.words[j], s = span.get(n)
    span.set(n, s ? [Math.min(s[0], x.start), Math.max(s[1], x.end)] : [x.start, x.end])
  }
  for (const [n, [startUs, endUs]] of span) Object.assign(shared[n], { startUs, endUs })
  // A sentence the captions didn't hear keeps its time, between the ones around it.
  shared.forEach((c, n) => {
    if (span.has(n)) return
    const startUs = Math.max(c.startUs, shared[n - 1]?.endUs ?? 0), endUs = Math.min(c.endUs, shared[n + 1]?.startUs ?? Infinity)
    if (endUs > startUs) Object.assign(c, { startUs, endUs })
  })
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

  // Said: each sound file once, however many clips it's cut into.
  let said: (TextCue & { shared?: boolean })[] = []
  let saidLang = ''
  const files = new Map<string, Clip[]>()
  for (const c of audible) files.set(path(c), [...(files.get(path(c)) ?? []), c])
  for (const [file, clips] of files) {
    const s = ctx.sounds[file]
    if (!s?.text || !letters.test(s.text)) continue
    // Its sentences in its own time: as heard (a voiceover Studio didn't make), else the script's shared out over it.
    const length = Math.max(mediaById(snap, clips[0].mediaId)?.durationUs ?? 0, ...clips.map((c) => c.inUs + c.durationUs * (c.speed ?? 1)))
    const lines = s.read?.sentences.length ? s.read.sentences.map((x) => ({ text: x.text, start: x.start * 1e6, end: x.end * 1e6 })) : shareOut(scriptSentences(s.text), length)
    for (const l of lines) for (const [startUs, endUs] of heardAt(clips, l.start, l.end)) said.push({ startUs, endUs, text: l.text, shared: !s.read?.sentences.length })
  }
  if (said.some((c) => c.shared)) timeByCaptions(said, captionTracks(snap))
  for (const h of ctx.heard.filter((x) => !ctx.lang || x.language === ctx.lang)) {
    const clips = audible.filter((x) => lower(path(x)) === lower(h.source))
    for (const l of h.lines)
      for (const [startUs, endUs] of heardAt(clips, l.start * 1e6, l.end * 1e6)) {
        said.push({ startUs, endUs, text: l.text })
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
  const cue = ({ startUs, endUs, text }: TextCue) => ({ startUs, endUs, text })
  return { screen: screen.map(cue), said: said.map(cue), saidLang, fromCaptions }
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
