// Translations: a finished project (an edited ad, or a dub) made again in other languages, one
// project per language. Shared by the main process (copies, Claude, the voice) and the page (the
// Translations tab, and putting a finished language on its project's timeline).

/** What the timeline says, as the Translations tab collects it from the project. */
export type TrItem = {
  /** `t:<clipId>` a text clip, `c:<clipId>` a caption line, `v:<clipId>` a spoken sentence's sound clip, `v:<clipId>~<n>` the nth sentence of a voiceover heard sentence by sentence. */
  id: string
  kind: 'text' | 'caption' | 'line'
  /** What it says now, in the project's language. */
  text: string
  /** What it was before a dub translated it (the original language), when known: Claude's reference. */
  original?: string
  /** On the timeline. */
  startUs: number
  endUs: number
  /** A spoken sentence's voice: the dub's clone or a voiceover's voice, with how it was spoken. */
  voice?: { voiceId: string; model: string; speed: number; name: string }
}

/** Claude's translation of one item, with what it says back in the project's language (to check meaning). */
export type TrText = { id: string; translation: string; back: string }

export type TrVoice = 'same' | 'text'

export type TrState = 'copying' | 'reading' | 'review' | 'voicing' | 'ready' | 'applied' | 'failed' | 'cancelled'

/** One language of a translation: its own project (a copy of the source), worked on in the background. */
export type TrJob = {
  id: string
  /** The languages started together share one review. */
  batch: string
  /** The project translated, and the copy this language goes into. */
  source: string
  project: string
  /** Its name ("Spring promo · Norsk"). */
  name: string
  from: string
  lang: string
  voice: TrVoice
  /** Captions made from the new voice's words (else each line translated where it is). */
  captionsFromVoice: boolean
  state: TrState
  stage: string
  fraction: number
  startedAt: number
  /** Ids the review kept (the rest stay as they are); set by `go`. */
  picks?: string[]
  reason?: string
  notes?: string[]
  needsClaude?: boolean
  /** When the copy was made (its project.json's mtime): a cancelled one still like this is removed. */
  copied?: number
  /** This job's folder in the copy: items.json, translation.json, the takes and voice.json. */
  dir: string
}

/** A finished sentence as it plays in the copy, with its words' times for captions. */
export type TrLine = { id: string; file: string; atUs: number; dur: number; tempo: number; text: string; words: { text: string; start: number; end: number }[] }

export const trRunning = (j: TrJob) => j.state === 'copying' || j.state === 'reading' || j.state === 'review' || j.state === 'voicing'

/** The languages offered, with the name a project in that language is given. */
export const TR_LANGS: { code: string; name: string; own: string }[] = [
  { code: 'sv', name: 'Swedish', own: 'Svenska' },
  { code: 'no', name: 'Norwegian', own: 'Norsk' },
  { code: 'da', name: 'Danish', own: 'Dansk' },
  { code: 'fi', name: 'Finnish', own: 'Suomi' },
  { code: 'de', name: 'German', own: 'Deutsch' },
  { code: 'en', name: 'English', own: 'English' },
  { code: 'nl', name: 'Dutch', own: 'Nederlands' },
  { code: 'fr', name: 'French', own: 'Français' },
  { code: 'es', name: 'Spanish', own: 'Español' },
  { code: 'it', name: 'Italian', own: 'Italiano' },
  { code: 'pt', name: 'Portuguese', own: 'Português' },
  { code: 'pl', name: 'Polish', own: 'Polski' },
]
export const trLangName = (code: string) => TR_LANGS.find((l) => l.code === code)?.name ?? code

/**
 * The copy's name: the project's name with its language swapped ("Spring promo · Svenska" →
 * "Spring promo · Norsk"), or the language added when it names none.
 */
export function trProjectName(name: string, lang: string) {
  const own = TR_LANGS.find((l) => l.code === lang)?.own ?? lang
  const base = name.replace(/\s+copy(\s+\d+)?$/i, '')
  const m = /^(.*?)\s*·\s*([^·]+)$/.exec(base)
  const named = m && TR_LANGS.some((l) => [l.own, l.name].some((n) => n.toLowerCase() === m[2].trim().toLowerCase()))
  return named ? `${m![1]} · ${own}` : `${base} · ${own}`
}
