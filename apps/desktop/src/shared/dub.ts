// Visual dub: a video's on-screen text, read, translated and put back as Studio text clips over
// a copy of the video with the text removed (Vmake). Shared by the main process (scan, reading,
// removal) and the page (the text clips).

import { FONTS } from './fonts'

/** The fonts Claude may name for a text's lettering. */
export const DUB_FONTS = FONTS.map((f) => f.family)

/** Fractions of the frame: x, y of the top-left corner, width and height. */
export type DubBox = { x: number; y: number; w: number; h: number }

/** One line as OCR read it, and where it sits. */
export type DubLine = { text: string; box: DubBox }

/** A piece of text that comes and goes as one: a title, a label, a two-line call to action. */
export type DubBlock = {
  id: string
  /** First frame it shows, and the frame after its last (µs, the source's own time). */
  startUs: number
  endUs: number
  box: DubBox
  /** OCR's reading, line by line, top to bottom: only a first guess (Claude reads the crop). */
  lines: DubLine[]
  /** A moment it's fully on screen; the crop and the frame are taken there. */
  refUs: number
  /** File names in the scan's folder: the block at full resolution, and the whole frame with it outlined. */
  crop: string
  frame: string
}

/** Claude's reading of a block, and its translation. */
export type DubText = {
  id: string
  /** Exactly what's written, line breaks as \n. */
  text: string
  /** Edited in (replaced), filmed (left alone) or a piece of another text. */
  kind: 'edit' | 'scene' | 'part'
  partOf?: string
  translation: string
  category: 'sans' | 'serif' | 'script' | 'display' | 'mono'
  /** The closest of Studio's fonts, as Claude sees it. */
  font?: string
  weight?: number
  italic?: boolean
  uppercase?: boolean
}

/**
 * A text that reads the same in the new language ("SPF 50", "Vitamin C 15%"): left as filmed, as
 * replacing it changes nothing but risks a doubled label where the removal missed it.
 */
export const unchanged = (t: Pick<DubText, 'text' | 'translation'>) => t.text.replace(/\s+/g, ' ').trim() === t.translation.replace(/\s+/g, ' ').trim()

/** A block's look, measured against the clean copy; px are the source's own pixels. */
export type DubLook = {
  id: string
  color: string
  box: { color: string; opacity: number; radius: number; rect: { x: number; y: number; w: number; h: number } } | null
  stroke: { color: string; width: number } | null
  shadow: { color: string; opacity: number; blur: number; x: number; y: number } | null
  /** Each line's letters (OCR's lines, top to bottom). */
  ink: { x: number; y: number; w: number; h: number }[]
  /** The letters as a grey PNG in the dub's folder, and where it sits in the frame. */
  mask: string
  maskRect: { x: number; y: number; w: number; h: number }
}

/** `landed`: done, and put in a new project of its own (`landed`), where its copy is applied. */
export type DubState = 'preparing' | 'scanning' | 'listening' | 'reading' | 'review' | 'removing' | 'voicing' | 'matching' | 'ready' | 'applied' | 'landed' | 'failed' | 'cancelled'

/** What the new voice is: her own, cloned (an instant clone); another voice; or none (her voice stays). */
export type DubVoice = 'clone' | 'voice' | 'keep'

/** A spoken sentence: when it was said (s, in the clip's part), what, and its translation. */
/** What was said, as sentences: who, when (s, in the clip's part), and the words with their times. */
export type DubSpoken = { id: string; speaker: string; start: number; end: number; text: string; words: { text: string; start: number; end: number }[] }

/** One take of a dubbed sentence: its sound file, length (s), how much faster, its words and their times. */
export type DubTake = { file: string; dur: number; tempo: number; text: string; words: { text: string; start: number; end: number }[] }

/**
 * A dubbed sentence on the timeline: where it starts (s, in the part) and the take it plays.
 * Rerolled, every take is kept in `takes` (the first is the dub's own), `take` the one playing.
 */
export type DubVoiceLine = DubTake & { id: string; at: number; own?: boolean; takes?: DubTake[]; take?: number }

export interface DubJob {
  id: string
  /** The project's `.studio` folder. */
  project: string
  clipId: string
  mediaId: string
  /** The file's name, for messages. */
  name: string
  /** The clip's source file, and the stretch of it the clip plays (µs). */
  source: string
  inUs: number
  spanUs: number
  lang: string
  /** Re-make the on-screen text; the voice (see DubVoice); captions in the new language. */
  text: boolean
  /**
   * With `text`: the on-screen text is only taken out (Vmake), nothing drawn back; for videos
   * whose text is only subtitles of what's said, which captions in the new language replace.
   * The text isn't looked for or read at all.
   */
  removeText?: boolean
  voice: DubVoice
  /** For `voice`: the ElevenLabs voice chosen in Audio. A clone's id once it's made. */
  voiceId?: string
  voiceName?: string
  /**
   * Her clone stays in the user's ElevenLabs account. Off (the default), it's deleted after each
   * use (the dub, a Reroll) and made again from the sample kept in the dub's folder when needed.
   */
  keepClone?: boolean
  /** Put on this project's own timeline (Claude, tests), not in a new project of its own. */
  inPlace?: boolean
  /** Done and put in a new project of its own: that project, its name, and the dub's copy there. */
  landed?: { project: string; name: string; id: string }
  /** This dub is the copy of one done in another project (`landed` there), which it came from. */
  from?: { project: string; id: string }
  captions: boolean
  /** Vmake's removal model (vmake.ts MODELS), or 'skip'. */
  model: string
  /** Stop after finding and translating, for the Dub tab to pick what's dubbed (else everything is). */
  review: boolean
  /** What the Dub tab picked: the texts and sentences to dub (the rest stay as they are). */
  picks?: { texts: string[]; lines: string[] }
  /** The dub's folder: the part, scan, crops, readings, speech, voice, looks and the new picture. */
  dir: string
  state: DubState
  stage: string
  fraction: number
  reason?: string
  /** Claude Code isn't signed in: the job waits for a sign-in (Try again) or a texts.json. */
  needsClaude?: boolean
  /** The text removal (vmake-jobs.ts): started first, as its own job, as it takes longest. */
  vmakeJob?: string
  /** How that removal stands, kept here for the Dub tab (it carries on whatever the dub does). */
  removal?: { state: string; stage: string; fraction: number; reason?: string; startedAt: number }
  stemsDir?: string
  /**
   * The clean copy (Vmake's result); the picture the clip gets (the clean copy itself, or with
   * the original put back where a text couldn't be measured); the background without the voice.
   */
  clean?: string
  base?: string
  /** The picture is Vmake's clean copy, so every text edited in is drawn again (those not dubbed as they were). */
  redraw?: boolean
  bed?: string
  /** Problems that didn't stop it (a sentence still a little long, a missing background). */
  notes?: string[]
  startedAt: number
}

export const dubRunning = (j: DubJob) => !['ready', 'applied', 'landed', 'failed', 'cancelled'].includes(j.state)

export type DubScan = {
  version: 1
  source: string
  width: number
  height: number
  fps: number
  durationUs: number
  blocks: DubBlock[]
  /** How long the scan took. */
  ms: number
}
