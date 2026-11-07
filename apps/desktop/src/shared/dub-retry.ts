// Try again on a stopped dub uses what the Dub tab shows now (the user's rule: "when I've
// obviously chosen another voice it should forget the old one and go with the new parameters").
// The tab starts from the stopped dub's own settings, so whatever differs was changed on purpose.
// No imports: node --test runs this file as it is (scripts/dub-retry.test.mjs).

export type DubSettings = {
  lang: string
  text: boolean
  removeText?: boolean
  /** Vmake's model, or 'skip' (also when the text isn't dubbed). */
  model: string
  voice: 'clone' | 'voice' | 'keep'
  /** For `voice`: the voice chosen in Audio (a clone's id once it's made). */
  voiceId?: string
  voiceName?: string
  /** Her clone stays in the ElevenLabs account (else it's deleted after each use). */
  keepClone?: boolean
  captions: boolean
}

export type DubChange = Partial<DubSettings>

/** What the tab shows that the stopped dub didn't use (empty when they match). */
export function settingsChange(job: DubSettings, want: DubSettings): DubChange {
  const c: DubChange = {}
  if (want.lang !== job.lang) c.lang = want.lang
  if (want.text !== job.text || !!want.removeText !== !!job.removeText) Object.assign(c, { text: want.text, removeText: !!want.removeText })
  if (want.model !== job.model) c.model = want.model
  // A clone's id isn't the user's pick, so only a chosen voice's id counts.
  if (want.voice !== job.voice || (want.voice === 'voice' && want.voiceId !== job.voiceId)) Object.assign(c, { voice: want.voice, voiceId: want.voiceId, voiceName: want.voiceName })
  if (want.captions !== job.captions) c.captions = want.captions
  if (want.voice === 'clone' && !!want.keepClone !== !!job.keepClone) c.keepClone = !!want.keepClone
  return c
}

const MODELS: Record<string, string> = { pro: 'Smart Remove Pro', full: 'Smart Remove', skip: 'no Vmake' }
const onScreen = (s: DubSettings) => (!s.text ? 'left as filmed' : s.removeText ? 'removed' : 'translated')
const who = (s: DubSettings) => (s.voice === 'clone' ? 'her cloned voice' : s.voice === 'keep' ? 'her own voice as filmed' : s.voiceName ?? 'the voice chosen in Audio')

/** The change in words, for the Dub tab ("Calm Narrator instead of her cloned voice"). */
export function describeChange(job: DubSettings, c: DubChange, langName: (code: string) => string): string[] {
  const n = { ...job, ...c }
  const out: string[] = []
  if (c.lang) out.push(`into ${langName(n.lang)} instead of ${langName(job.lang)}`)
  if ('text' in c) out.push(`the on-screen text ${onScreen(n)}, not ${onScreen(job)}`)
  if (c.model && n.text && job.text) out.push(`${MODELS[n.model] ?? n.model} instead of ${MODELS[job.model] ?? job.model}`)
  if (c.voice) out.push(`${who(n)} instead of ${who(job)}`)
  if ('captions' in c) out.push(n.captions ? `${langName(n.lang)} captions` : 'no captions')
  if ('keepClone' in c) out.push(n.keepClone ? 'her clone kept in ElevenLabs' : 'her clone deleted after use')
  return out
}

const translates = (s: DubSettings) => s.text && !s.removeText
const hears = (s: DubSettings) => s.voice !== 'keep' || s.captions

/**
 * How a stopped dub changes before it runs again: its new settings, and which of its kept files
 * no longer hold (`drop`). The rest is kept: the part, Vmake's clean copy, the stems, what was
 * heard, a translation into the same language. The review comes back (`picks` cleared) only when
 * there's something new to pick: another language, texts now translated, sentences now heard.
 * Throws, before anything changes, when the new settings can't make a dub.
 */
export function retryPlan(job: DubSettings & { picks?: unknown }, c: DubChange): { patch: Record<string, unknown>; drop: string[] } {
  const n: DubSettings = { ...job, ...c }
  if (!n.text && n.voice === 'keep' && !n.captions) throw new Error('Pick something to dub: the on-screen text, the voice or captions.')
  if (n.removeText && (!n.text || n.model === 'skip')) throw new Error('Removing the on-screen text needs Vmake: pick Smart Remove Pro or Smart Remove.')
  if (n.voice === 'voice' && !n.voiceId) throw new Error('Choose the voice in the Audio tab first.')
  const lang = n.lang !== job.lang
  const textMode = n.text !== job.text || !!n.removeText !== !!job.removeText
  const voice = n.voice !== job.voice || (n.voice === 'voice' && n.voiceId !== job.voiceId)
  const repick = !!job.picks && (lang || (translates(n) && !translates(job)) || (hears(n) && !hears(job)))
  const drop = new Set<string>()
  if (lang) drop.add('texts.json')
  if (lang || voice || repick) drop.add('voice.json')
  if (textMode || repick) ['looks.json', 'base.mp4'].forEach((f) => drop.add(f))
  const patch: Record<string, unknown> = { ...c, notes: undefined }
  // The old voice is forgotten: a chosen one is used as it is, her own is cloned when it speaks.
  if (voice) Object.assign(patch, { voiceId: n.voice === 'voice' ? n.voiceId : undefined, voiceName: n.voice === 'voice' ? n.voiceName : undefined })
  if (textMode || repick) Object.assign(patch, { base: undefined, redraw: undefined })
  if (repick) patch.picks = undefined
  return { patch, drop: [...drop] }
}
