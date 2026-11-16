// Where spoken sentences begin and end (a voiceover heard sentence by sentence), and where their
// new takes go on the timeline (a dub's or a translation's): shared by main/voice-read.ts,
// main/dub-voice.ts and the tests. No imports: node --test runs this file (scripts/speech-timing.test.mjs).
//
// The gaps (the user, 2026-11-16, from a friend's Mac: "Claude can get the audio positioning
// incorrect and will leave massive gaps"): a sentence heard as one long run (a CapCut voiceover:
// sentences only end at . ! ? or a long pause) kept every pause inside it as its room, and its
// new take, spoken without them, left all that room as one silence; and a shorter translation
// always left (room − its length) after it. Now a heard sentence is at most MAX_LINE long (split
// where it pauses most), a sentence after a short one moves up to MOVE_UP closer, and a short
// line is spoken a little slower (down to SLOWEST) before any gap is left.

/** A heard sentence no longer than this (seconds): a dub's sentences are split the same way. */
export const MAX_LINE = 9
/** How far a sentence may move up after one that came out shorter (seconds). */
export const MOVE_UP = 1.2
/** The slowest a short line is spoken to fill its room (1 = as spoken). */
export const SLOWEST = 0.92
/** The pause a line slowed down still leaves before the next one (seconds). */
const BREATH = 0.3

type Word = { text: string; start: number; end: number }

/**
 * Words into sentences: one ends at . ! ? … or where the voice pauses for most of a second, and
 * one longer than MAX_LINE is split where it pauses most (a comma counting as a pause), never in
 * its first third. A few stray words aren't speech (a breath, a sung line in a jingle): none.
 */
export function sentencesOf(words: Word[]): Word[] {
  const runs: Word[][] = []
  let cur: Word[] = []
  for (const [i, w] of words.entries()) {
    cur.push(w)
    const next = words[i + 1]
    if (/[.!?…]["”»)]*$/.test(w.text) || (next && next.start - w.end > 0.9)) {
      runs.push(cur)
      cur = []
    }
  }
  if (cur.length) runs.push(cur)
  const split = (s: Word[]): Word[][] => {
    if (s.length < 2 || s[s.length - 1].end - s[0].start <= MAX_LINE) return [s]
    let best = -1
    let score = -1
    for (let k = Math.max(1, Math.ceil(s.length / 3)); k < s.length; k++) {
      const gap = s[k].start - s[k - 1].end + (/[,;:]$/.test(s[k - 1].text) ? 0.3 : 0)
      if (gap > score) {
        score = gap
        best = k
      }
    }
    return best > 0 ? [...split(s.slice(0, best)), ...split(s.slice(best))] : [s]
  }
  const out = runs.flatMap(split).map((r) => ({ text: r.map((w) => w.text).join(' '), start: r[0].start, end: r[r.length - 1].end }))
  return out.reduce((n, s) => n + s.text.split(/\s+/).length, 0) >= 3 ? out : []
}

/** A sentence as it was said (seconds, on the timeline or in the part): `start`, `end`. */
type Said = { id: string; start: number; end: number }

/**
 * Places each new take (`cut`: its id and length) at its sentence's moment:
 * - at its original start if it fits before the next sentence starts; after a sentence that came
 *   out shorter than the one said, up to MOVE_UP earlier, keeping the pause that was there;
 * - too long for its room: up to 0.4 s earlier into the pause before it (never over the one
 *   before), then a little faster (up to `maxTempo`, pitch kept);
 * - well short of its room: a little slower (down to SLOWEST), so less of it is silence.
 * Returns each line's place, tempo and length, and the ids that still don't fit.
 */
export function fitLines(cut: { id: string; dur: number }[], spoken: Said[], partEnd: number, maxTempo: number) {
  const placed: { id: string; at: number; tempo: number; dur: number }[] = []
  const long: string[] = []
  let prevEnd = 0
  for (const [i, c] of cut.entries()) {
    const k = spoken.findIndex((x) => x.id === c.id)
    const s = spoken[k]
    const next = spoken[k + 1]
    const nextStart = next ? next.start : partEnd
    const room = nextStart - s.start
    const early = Math.max(0, Math.min(0.4, s.start - (prevEnd + 0.06)))
    // When the sentence before came out shorter than the one said, this one moves up, so the
    // pause between them is about the one that was there, not dead air.
    const before = spoken[k - 1]
    const pause = before ? Math.max(0.1, s.start - before.end) : 0
    let at = i ? Math.min(s.start, Math.max(prevEnd + pause, s.start - MOVE_UP)) : s.start
    let tempo = 1
    if (c.dur > room) {
      at = s.start - Math.min(early, c.dur - room)
      const left = room + (s.start - at)
      if (c.dur > left) tempo = c.dur / left
    } else {
      // Room to spare after it (the next one may still move up into some of it): spoken a little slower.
      const spare = nextStart - at - c.dur - BREATH
      if (spare > 0.2) tempo = Math.max(SLOWEST, c.dur / (c.dur + spare))
    }
    if (tempo > maxTempo) {
      long.push(c.id)
      tempo = maxTempo
    }
    at = Math.max(at, prevEnd + (i ? 0.04 : 0))
    const dur = c.dur / tempo
    placed.push({ id: c.id, at, tempo, dur })
    prevEnd = at + dur
  }
  return { placed, long }
}

/**
 * The timing of every placed line, numbers only (kept as `timing.json` in a dub's or a
 * translation's folder, for reading gaps without the words): when it was said, its room, the
 * take's length, where it went, how far it moved, its tempo, and the gap to the next line.
 */
export function timingOf(placed: { id: string; at: number; tempo: number; dur: number }[], spoken: Said[], cut: { id: string; dur: number }[]) {
  return placed.map((p, i) => {
    const s = spoken.find((x) => x.id === p.id)
    const k = s ? spoken.indexOf(s) : -1
    const next = placed[i + 1]
    const r = (x: number) => Math.round(x * 1000) / 1000
    return {
      n: i + 1,
      saidStart: r(s?.start ?? 0),
      saidEnd: r(s?.end ?? 0),
      room: r((spoken[k + 1]?.start ?? s?.end ?? 0) - (s?.start ?? 0)),
      take: r(cut.find((c) => c.id === p.id)?.dur ?? 0),
      at: r(p.at),
      moved: r(p.at - (s?.start ?? p.at)),
      tempo: r(p.tempo),
      length: r(p.dur),
      gapAfter: next ? r(next.at - (p.at + p.dur)) : null,
    }
  })
}
