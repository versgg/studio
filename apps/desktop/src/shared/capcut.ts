// CapCut projects, as Studio imports them. CapCut keeps each project as a folder of JSON
// (draft_content.json: the timeline; draft_meta_info.json: its name and size; draft_cover.jpg)
// under %LOCALAPPDATA%\CapCut\User Data\Projects\com.lveditor.draft (on a Mac, ~/Movies/CapCut/…).
// The main process reads one into this shape (src/main/capcut.ts), with CapCut's own resources
// (fonts, stickers, filter colour tables) copied into the new Studio project; the page builds the
// timeline from it (renderer/capcutImport.ts). Times are µs; positions are CapCut's: x and y in
// half the frame from its middle, y up.

/** A project in CapCut's list. */
export type CcDraft = { dir: string; name: string; cover: string | null; durationUs: number; bytes: number; modified: number; readable: boolean }

/** Where a picture sits: CapCut's transform, scale, turn, opacity and flips. */
export type CcPlace = { x: number; y: number; scale: number; rotation: number; alpha: number; flipH: boolean; flipV: boolean }

/** Keyframes of one setting, by Studio's name for it, at times from the clip's start. */
export type CcKeys = Record<string, { atUs: number; value: number }[]>

/** An animation of a text or sticker: in, out or loop, by Studio's name. */
export type CcAnim = { in?: { name: string; durationUs: number }; out?: { name: string; durationUs: number }; loop?: { name: string; periodUs: number } }

/** A video, photo or sound on the timeline. */
export type CcClip = {
  path: string
  kind: 'video' | 'photo' | 'audio'
  startUs: number
  durationUs: number
  inUs: number
  speed: number
  reverse: boolean
  volume: number
  fadeInUs: number
  fadeOutUs: number
  place?: CcPlace
  /** Fractions of the source frame. */
  crop?: { x: number; y: number; w: number; h: number }
  keys?: CcKeys
  /** A filter on the clip itself: its colour table and strength 0–100. */
  lut?: { path: string; strength: number; name: string; grain?: number }
  /** The transition from this clip into the next (main track), by Studio's name. */
  transition?: { name: string; durationUs: number; from: string }
  anim?: CcAnim
  /** CapCut's Polaroid Zoom on a photo: the photo is already set in the card (path); the fly-in lasts motionUs. */
  polaroid?: { motionUs: number }
}

/** A text's look, from CapCut's own settings. Sizes are CapCut's; the page turns them into pixels with the font's own measurements. */
export type CcStyle = {
  /** A bundled family ("Metropolis" for CapCut's System font) or a font file copied into the project. */
  font: string
  fontFile?: string
  weight: number
  /** The font's line height (ascent + descent) per em, from its own file. */
  lineRatio: number
  /** CapCut's size: the font's line height is size × ~6.1 px on a 1080-wide frame. */
  size: number
  color: string
  alpha: number
  align: 'left' | 'center' | 'right'
  lineSpacing: number
  letterSpacing: number
  italic: boolean
  underline: boolean
  bold: number
  stroke: { color: string; width: number } | null
  background: { color: string; alpha: number; radius: number; width: number; height: number; style: number } | null
  shadow: { color: string; alpha: number; blur: number; distance: number; angle: number } | null
}

export type CcText = { text: string; style: CcStyle; startUs: number; durationUs: number; place: CcPlace; keys?: CcKeys; anim?: CcAnim; caption: boolean }

export type CcSticker = { path: string; startUs: number; durationUs: number; place: CcPlace; keys?: CcKeys; anim?: CcAnim; name: string }

/** A filter over everything below it for a while (CapCut's filter track). */
export type CcFilter = { lut: string; strength: number; name: string; grain?: number; startUs: number; durationUs: number }

export type CcTrack =
  | { kind: 'video'; main: boolean; clips: CcClip[]; hidden: boolean; muted: boolean }
  | { kind: 'audio'; clips: CcClip[]; muted: boolean }
  | { kind: 'text'; texts: CcText[]; captions: boolean; hidden: boolean }
  | { kind: 'sticker'; stickers: CcSticker[]; hidden: boolean }
  | { kind: 'filter'; filters: CcFilter[] }

export type CcProject = {
  name: string
  width: number
  height: number
  fps: number
  durationUs: number
  /** CapCut's tracks, bottom to top. */
  tracks: CcTrack[]
  /** What didn't come over, or came over as Studio's nearest. */
  notes: string[]
  /** Media CapCut points at that isn't on this computer any more. */
  missing: string[]
}
