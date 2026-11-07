// What an ElevenLabs API key must be allowed to do for every part of Studio to work, as the
// key settings on elevenlabs.io name them. Keys are restricted by default; turn these on
// when you create or edit the key. The ids are ElevenLabs' own permission names, which
// their errors quote ("missing the permission text_to_speech").

export const ELEVEN_KEYS_URL = 'https://elevenlabs.io/app/developers/api-keys'

export interface ElevenPermission {
  /** As the key settings show it. */
  name: string
  /** The level to pick there. */
  level: string
  /** ElevenLabs' permission ids this covers. */
  ids: string[]
  /** What in Studio needs it. */
  why: string
}

export const ELEVEN_PERMISSIONS: ElevenPermission[] = [
  { name: 'Text to Speech', level: 'Access', ids: ['text_to_speech'], why: 'Voiceovers from a script' },
  { name: 'Speech to Speech', level: 'Access', ids: ['speech_to_speech'], why: 'The voice changer (your recording in another voice)' },
  { name: 'Voices', level: 'Write', ids: ['voices_read', 'voices_write'], why: 'Listing your voices, adding Voice Library voices, cloning, keeping a designed voice (Write includes Read)' },
  { name: 'Voice Generation', level: 'Access', ids: ['voice_generation'], why: 'Design a voice from a description' },
  { name: 'Speech to Text', level: 'Access', ids: ['speech_to_text'], why: 'Dubs and translations: hearing what is said, and checking the new voice speaks the language' },
  { name: 'Models', level: 'Read', ids: ['models_read'], why: 'The model list (v4 and the others)' },
  { name: 'User', level: 'Access', ids: ['user_read'], why: 'Your credit balance; Studio checks the key with it' },
  { name: 'History', level: 'Read', ids: ['speech_history_read'], why: 'Finding which of your voices spoke a voiceover, so a translation speaks it in the same voice' },
]

/** Shown separately on some accounts; turn them on if you see them. */
export const ELEVEN_EXTRA: ElevenPermission[] = [
  { name: 'Add voice from Voice Library', level: 'On', ids: ['add_voice_from_voice_library'], why: 'Adding a Voice Library voice to your voices' },
  { name: 'Create instant voice clone', level: 'On', ids: ['create_instant_voice_clone'], why: 'Clone a voice' },
]

/** The setting to turn on for an ElevenLabs permission id, e.g. "text_to_speech" → "Text to Speech (Access)". */
export function elevenPermissionName(id: string): string {
  const p = [...ELEVEN_PERMISSIONS, ...ELEVEN_EXTRA].find((x) => x.ids.includes(id))
  return p ? `${p.name} (${p.level})` : id
}

/**
 * What an ElevenLabs error answer means, from its HTTP status and body. ElevenLabs answers 401
 * for more than a bad key (credits, a credit limit on the key, unusual activity, missing
 * permissions), so only a key it calls invalid (or a 401 that says nothing) counts as refused
 * (`auth`: paste another); anything else is told in ElevenLabs' own words and the key is kept.
 */
export function elevenProblem(status: number, body: unknown): { message: string; auth: boolean; code: string } {
  const detail = (body as { detail?: unknown } | null)?.detail as any
  const code = String(detail?.code ?? detail?.status ?? '')
  const said = (
    Array.isArray(detail) ? detail.map((d: any) => d?.msg ?? '').filter(Boolean).join('; ') : typeof detail === 'string' ? detail : String(detail?.message ?? '')
  )
    .trim()
    // Shown and kept in a dub's record: never anything that looks like a key.
    .replace(/\bsk_[A-Za-z0-9]{6,}/g, 'sk_…')
  // A working key that isn't allowed this one thing: say which setting to turn on, and keep the key.
  const missing = /permission (\w+)/.exec(said)?.[1]
  if (code === 'missing_permissions' || missing)
    return { message: `Your ElevenLabs key isn't allowed ${missing ? elevenPermissionName(missing) : 'this'}. Edit the key at ${ELEVEN_KEYS_URL} and turn that on; Studio keeps using the same key.`, auth: false, code: code || 'missing_permissions' }
  if (code === 'invalid_api_key' || code === 'missing_api_key' || (status === 401 && !code && (!said || /invalid|api key/i.test(said)))) return { message: 'ElevenLabs refused that API key. Paste a valid one.', auth: true, code }
  if (status === 402 || ['quota_exceeded', 'insufficient_credits', 'payment_required'].includes(code)) {
    const onKey = /api key|this key/i.test(said) ? ` That limit is the key's own: raise it at ${ELEVEN_KEYS_URL}; Studio keeps using the same key.` : ''
    return { message: `Not enough ElevenLabs credits for this. ElevenLabs says: ${said || 'the credits have run out.'}${onKey}`, auth: false, code }
  }
  if (status === 429) return { message: 'ElevenLabs is busy or the plan’s limit for simultaneous requests is reached. Try again in a moment.', auth: false, code }
  return { message: `ElevenLabs: ${said || `HTTP ${status}`}${code && !said.includes(code) ? ` (${code})` : ''}`, auth: false, code }
}
