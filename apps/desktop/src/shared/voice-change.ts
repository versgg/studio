// Change voice (right-click on sound clips): which way a recording gets its new voice, and how
// the selected clips are grouped into the stretches of their files that are made again.
//
// ElevenLabs' voice changer (`eleven_multilingual_sts_v2`, the only multilingual one) keeps the
// recording's own delivery and timing, but knows 29 languages: Swedish, Danish and Finnish yes,
// Norwegian no (elevenlabs.io/docs/models, read 2026-11-19). Any other language is said again
// instead: the words heard, spoken in the new voice in that language (Eleven v4, 90+ languages)
// and each sentence put back at its moment, as a translation does.

/** The languages the voice changer knows (ISO 639-1, as the transcript server names them). */
export const CHANGER_LANGS = new Set(['en', 'ja', 'zh', 'de', 'hi', 'fr', 'ko', 'pt', 'it', 'es', 'id', 'nl', 'tr', 'fil', 'tl', 'pl', 'sv', 'bg', 'ro', 'ar', 'cs', 'el', 'fi', 'hr', 'ms', 'sk', 'da', 'ta', 'uk', 'ru'])

/** Whether the voice changer takes this language ('' = not known: it does, as before). */
export const changerKnows = (lang: string) => !lang || CHANGER_LANGS.has(lang.toLowerCase())

/** The voice changer takes up to 5 minutes at a time; a stretch stays under it. */
export const MOST_SECONDS = 290

/** A selected clip: the stretch of its file it plays, in seconds into the file. */
export type VcClip = { id: string; file: string; inS: number; endS: number }
/** A stretch of one file made again in one go, and the clips that play from it. */
export type VcRun = { file: string; inS: number; endS: number; clips: VcClip[] }

/**
 * The clips grouped by file into stretches: pieces of one recording cut apart on the timeline
 * (or overlapping) go together when less than `gap` seconds apart and the stretch stays under
 * the limit, so the new voice runs on across the cuts as it was said.
 */
export function runsOf(clips: VcClip[], gap = 2, most = MOST_SECONDS): VcRun[] {
  const runs: VcRun[] = []
  const byFile = new Map<string, VcClip[]>()
  for (const c of clips) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c])
  for (const [file, list] of byFile) {
    let run: VcRun | null = null
    for (const c of [...list].sort((a, b) => a.inS - b.inS)) {
      if (run && c.inS <= run.endS + gap && Math.max(run.endS, c.endS) - run.inS <= most) {
        run.endS = Math.max(run.endS, c.endS)
        run.clips.push(c)
      } else {
        run = { file, inS: c.inS, endS: c.endS, clips: [c] }
        runs.push(run)
      }
    }
  }
  return runs
}

type Word = { text: string; start: number; end: number }
type Sentence = Word & { words?: Word[] }
/** A sentence, or the part of one a clip plays, in seconds from the clip's in-point. */
export type VcPiece = { id: string; text: string; start: number; end: number }

/**
 * What each clip of a stretch says: the heard sentences' words that fall in it (by their middle),
 * a sentence a cut runs through split there, so the new voice says only what's heard on the
 * timeline, piece by piece, each placed within its own clip.
 */
export function piecesOf(sentences: Sentence[], run: VcRun): { clip: VcClip; pieces: VcPiece[] }[] {
  let n = 0
  return run.clips.map((clip) => {
    const inside = (w: Word) => {
      const mid = (w.start + w.end) / 2
      return mid >= clip.inS && mid < clip.endS
    }
    const pieces: VcPiece[] = []
    for (const s of sentences) {
      const words = (s.words?.length ? s.words : [s]).filter(inside)
      if (!words.length) continue
      pieces.push({ id: `p${++n}`, text: words.map((w) => w.text).join(' '), start: words[0].start - clip.inS, end: words[words.length - 1].end - clip.inS })
    }
    return { clip, pieces }
  })
}
