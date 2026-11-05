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
