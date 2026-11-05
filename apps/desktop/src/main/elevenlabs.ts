// ElevenLabs on the user's own API key: voices, voiceovers (Eleven v4 by default), the voice
// changer for recordings, instant voice clones and voices designed from a description. REST over https://api.elevenlabs.io with
// the `xi-api-key` header (checked against the live API reference, 2026-10-26; voice speed on
// 2026-10-27). Captions come from the transcript server instead (transcript.ts).

import fs from 'node:fs'
import path from 'node:path'
import { ELEVEN_KEYS_URL, elevenPermissionName } from '../shared/eleven-permissions'
import type { DesignRound } from '../shared/api'

const API = 'https://api.elevenlabs.io'
/** The voice changer can't use v4; this is the multilingual speech-to-speech model. */
export const VOICE_CHANGER_MODEL = 'eleven_multilingual_sts_v2'
/** voice_settings.speed: ElevenLabs allows 0.7–1.2 (1 = normal). */
export const SPEED_RANGE: [number, number] = [0.7, 1.2]

export class ElevenError extends Error {
  constructor(message: string, readonly auth = false, readonly code = '') {
    super(message)
  }
}

export interface Voice {
  id: string
  name: string
  /** cloned, professional, generated, premade, famous, high_quality, or library (shared, not added yet). */
  category: string
  description: string
  labels: Record<string, string>
  previewUrl: string | null
  /** For a Voice Library voice: who shared it (needed to add it). */
  ownerId?: string
}

/** Reads all three of ElevenLabs' error shapes into one message. */
async function failure(r: Response): Promise<ElevenError> {
  let detail: any
  try {
    detail = (await r.json())?.detail
  } catch {
    detail = null
  }
  const code = String(detail?.code ?? detail?.status ?? '')
  const msg = Array.isArray(detail) ? detail.map((d: any) => d.msg).join('; ') : (detail?.message ?? `HTTP ${r.status}`)
  // A working key that isn't allowed this one thing: say which setting to turn on, and keep the key.
  const missing = /permission (\w+)/.exec(String(detail?.message ?? ''))?.[1]
  if (code === 'missing_permissions' || missing)
    return new ElevenError(`Your ElevenLabs key isn't allowed ${missing ? elevenPermissionName(missing) : 'this'}. Edit the key at ${ELEVEN_KEYS_URL} and turn that on; Studio keeps using the same key.`, false, code || 'missing_permissions')
  if (r.status === 401 || code === 'invalid_api_key' || code === 'missing_api_key') return new ElevenError('ElevenLabs refused that API key. Paste a valid one.', true, code)
  if (r.status === 402 || code === 'quota_exceeded' || code === 'insufficient_credits') return new ElevenError('Your ElevenLabs credits have run out.', false, code)
  if (r.status === 429) return new ElevenError('ElevenLabs is busy or the plan’s limit for simultaneous requests is reached. Try again in a moment.', false, code)
  return new ElevenError(`ElevenLabs: ${msg}`, false, code)
}

export class ElevenLabs {
  constructor(private key: string) {
    if (!key?.trim()) throw new ElevenError('Paste your ElevenLabs API key first.', true)
    this.key = key.trim()
  }

  private async req(p: string, init: RequestInit = {}, timeoutMs = 60_000): Promise<Response> {
    let r: Response
    try {
      r = await fetch(API + p, { ...init, headers: { 'xi-api-key': this.key, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      throw new ElevenError(`ElevenLabs did not answer: ${String((e as Error).message).slice(0, 200)}`)
    }
    if (!r.ok) throw await failure(r)
    return r
  }

  private json = async (p: string, init?: RequestInit) => (await this.req(p, init)).json()

  async subscription() {
    const s = await this.json('/v1/user/subscription')
    return { tier: s.tier as string, used: s.character_count as number, limit: s.character_limit as number, canClone: !!s.can_use_instant_voice_cloning, resetsAt: s.next_character_count_reset_unix as number | null }
  }

  /** Text-to-speech models this key can use, newest first as ElevenLabs lists them. */
  async models() {
    const list: any[] = await this.json('/v1/models')
    return list
      .filter((m) => m.can_do_text_to_speech && !m.requires_alpha_access)
      .map((m) => ({ id: m.model_id as string, name: m.name as string, maxChars: (m.maximum_text_length_per_request as number) ?? 0, languages: (m.languages ?? []).map((l: any) => l.language_id as string) }))
  }

  /**
   * What the account has spoken, newest first (up to `pages` × 1000): the text, the voice and
   * model it was spoken with and its speed. Needs the key's "speech history" read permission.
   */
  async history(pages = 3): Promise<{ voiceId: string; voiceName: string; model: string; text: string; speed: number; at: number }[]> {
    const out: { voiceId: string; voiceName: string; model: string; text: string; speed: number; at: number }[] = []
    let after = ''
    for (let page = 0; page < pages; page++) {
      const q = new URLSearchParams({ page_size: '1000', ...(after ? { start_after_history_item_id: after } : {}) })
      const r = await this.json(`/v1/history?${q}`)
      for (const h of r.history ?? []) {
        if (h.voice_id && h.text) out.push({ voiceId: h.voice_id, voiceName: h.voice_name ?? '', model: h.model_id ?? '', text: h.text, speed: h.settings?.speed ?? 1, at: h.date_unix ?? 0 })
      }
      after = r.last_history_item_id ?? ''
      if (!r.has_more || !after) break
    }
    return out
  }

  /** Every voice in the account (all pages), plus any matching `search`. */
  async voices(search = ''): Promise<Voice[]> {
    const out: Voice[] = []
    let token: string | null = null
    for (let page = 0; page < 20; page++) {
      const q = new URLSearchParams({ page_size: '100', include_total_count: 'false', ...(search ? { search } : {}), ...(token ? { next_page_token: token } : {}) })
      const r = await this.json(`/v2/voices?${q}`)
      for (const v of r.voices ?? []) out.push({ id: v.voice_id, name: v.name, category: v.category ?? 'premade', description: v.description ?? '', labels: v.labels ?? {}, previewUrl: v.preview_url ?? null })
      token = r.next_page_token ?? null
      if (!r.has_more || !token) break
    }
    return out
  }

  /** One voice from the account: the cheapest way to check the key may read voices. */
  async voicesPage() {
    await this.json('/v2/voices?page_size=1&include_total_count=false')
  }

  /** The public Voice Library (community voices), searched. */
  async library(search: string): Promise<Voice[]> {
    const q = new URLSearchParams({ page_size: '30', search })
    const r = await this.json(`/v1/shared-voices?${q}`)
    return (r.voices ?? []).map((v: any) => ({
      id: v.voice_id,
      name: v.name,
      category: 'library',
      description: v.description ?? '',
      labels: Object.fromEntries(['accent', 'gender', 'age', 'language', 'use_case', 'descriptive'].filter((k) => v[k]).map((k) => [k, String(v[k])])),
      previewUrl: v.preview_url ?? null,
      ownerId: v.public_owner_id,
    }))
  }

  /** Adds a Voice Library voice to the account so it can speak; returns its id there. */
  async addLibraryVoice(ownerId: string, voiceId: string, name: string): Promise<string> {
    const r = await this.json(`/v1/voices/add/${encodeURIComponent(ownerId)}/${encodeURIComponent(voiceId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ new_name: name }) })
    return r.voice_id
  }

  /** Text to speech, saved as an MP3: stability, similarity and (when not 1) speed. */
  async speak(o: { voiceId: string; text: string; modelId: string; stability: number; similarity: number; speed?: number; languageCode?: string; out: string }) {
    const settings: Record<string, number> = { stability: o.stability, similarity_boost: o.similarity }
    if (o.speed != null && Math.abs(o.speed - 1) > 0.001) settings.speed = Math.min(SPEED_RANGE[1], Math.max(SPEED_RANGE[0], o.speed))
    const body: Record<string, unknown> = { text: o.text, model_id: o.modelId, voice_settings: settings }
    if (o.languageCode) body.language_code = o.languageCode
    const r = await this.req(`/v1/text-to-speech/${encodeURIComponent(o.voiceId)}?output_format=mp3_44100_128`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'audio/mpeg' }, body: JSON.stringify(body) }, 5 * 60_000)
    await write(o.out, r)
  }

  /** The voice changer: a recording spoken again in another voice (Swedish yes, Norwegian no). */
  async changeVoice(o: { voiceId: string; input: string; out: string; removeNoise: boolean }) {
    const form = new FormData()
    form.append('audio', new Blob([fs.readFileSync(o.input)]), path.basename(o.input))
    form.append('model_id', VOICE_CHANGER_MODEL)
    form.append('remove_background_noise', String(o.removeNoise))
    const r = await this.req(`/v1/voice-changer/${encodeURIComponent(o.voiceId)}?output_format=mp3_44100_128`, { method: 'POST', body: form }, 10 * 60_000)
    await write(o.out, r)
  }

  /**
   * Speech to text (Scribe): every word with its time and speaker, and sounds like breaths and
   * laughs as events. `languageCode` forces the language; without it Scribe says which it heard.
   */
  async transcribe(o: { file: string; languageCode?: string; diarize?: boolean; model?: string }): Promise<{ language: string; words: { text: string; start: number; end: number; type: string; speaker: string }[] }> {
    const form = new FormData()
    form.append('model_id', o.model ?? 'scribe_v2')
    form.append('file', new Blob([fs.readFileSync(o.file)]), path.basename(o.file))
    form.append('timestamps_granularity', 'word')
    form.append('tag_audio_events', 'true')
    form.append('diarize', String(o.diarize ?? true))
    if (o.languageCode) form.append('language_code', o.languageCode)
    const r = await (await this.req('/v1/speech-to-text', { method: 'POST', body: form }, 10 * 60_000)).json()
    return {
      language: r.language_code ?? '',
      words: (r.words ?? []).map((w: any) => ({ text: String(w.text ?? ''), start: Number(w.start ?? 0), end: Number(w.end ?? 0), type: String(w.type ?? 'word'), speaker: String(w.speaker_id ?? 'speaker_0') })),
    }
  }

  /**
   * Text to speech with the time of every character, saved as an MP3. `seed` keeps takes alike;
   * `previous`/`next` are the words around it, so a line is spoken as part of its script.
   */
  async speakTimed(o: { voiceId: string; text: string; modelId: string; stability: number; similarity: number; style?: number; speed?: number; languageCode?: string; seed?: number; previous?: string; next?: string; out: string }): Promise<{ chars: string[]; starts: number[]; ends: number[] }> {
    const settings: Record<string, number> = { stability: o.stability, similarity_boost: o.similarity }
    if (o.style != null) settings.style = o.style
    if (o.speed != null && Math.abs(o.speed - 1) > 0.001) settings.speed = Math.min(SPEED_RANGE[1], Math.max(SPEED_RANGE[0], o.speed))
    const body: Record<string, unknown> = { text: o.text, model_id: o.modelId, voice_settings: settings }
    if (o.languageCode) body.language_code = o.languageCode
    if (o.seed != null) body.seed = o.seed
    if (o.previous) body.previous_text = o.previous
    if (o.next) body.next_text = o.next
    const r = await (await this.req(`/v1/text-to-speech/${encodeURIComponent(o.voiceId)}/with-timestamps?output_format=mp3_44100_128`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, 5 * 60_000)).json()
    fs.mkdirSync(path.dirname(o.out), { recursive: true })
    fs.writeFileSync(o.out, Buffer.from(String(r.audio_base64 ?? ''), 'base64'))
    const a = r.alignment ?? r.normalized_alignment ?? {}
    return { chars: a.characters ?? [], starts: a.character_start_times_seconds ?? [], ends: a.character_end_times_seconds ?? [] }
  }

  /** Deletes a voice (a dub's own clone, once the dub is done with it). */
  async deleteVoice(voiceId: string) {
    await this.req(`/v1/voices/${encodeURIComponent(voiceId)}`, { method: 'DELETE' })
  }

  /** An instant voice clone from recordings. The owner's consent is required. */
  async clone(o: { name: string; files: string[]; removeNoise: boolean; description?: string }): Promise<string> {
    const form = new FormData()
    form.append('name', o.name)
    for (const f of o.files) form.append('files', new Blob([fs.readFileSync(f)]), path.basename(f))
    form.append('remove_background_noise', String(o.removeNoise))
    if (o.description) form.append('description', o.description)
    const r = await this.json('/v1/voices/add', { method: 'POST', body: form })
    return r.voice_id
  }

  /**
   * Voice Design (checked against the live API reference, 2026-11-05): three new voices from a
   * description, each saying `text` (100–1000 characters) or, without it, a line ElevenLabs
   * writes to fit. Costs credits for the preview text's length; nothing is kept until `saveDesigned`.
   */
  async design(o: { description: string; text?: string; model: string }): Promise<DesignRound> {
    const own = o.text?.trim()
    const body = { voice_description: o.description.trim(), model_id: o.model, ...(own ? { text: own } : { auto_generate_text: true }) }
    const r = await (await this.req('/v1/text-to-voice/design?output_format=mp3_44100_128', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, 180_000)).json()
    return { text: r.text ?? own ?? '', previews: (r.previews ?? []).map((p: any) => ({ id: p.generated_voice_id, audio: `data:${p.media_type || 'audio/mpeg'};base64,${p.audio_base_64}`, seconds: p.duration_secs ?? 0 })) }
  }

  /** Keeps one of a round's voices in the account (Designed voices); `heard` are the others listened to, which ElevenLabs learns from. */
  async saveDesigned(o: { name: string; description: string; previewId: string; heard?: string[] }): Promise<string> {
    const body = { voice_name: o.name, voice_description: o.description.trim(), generated_voice_id: o.previewId, ...(o.heard?.length ? { played_not_selected_voice_ids: o.heard } : {}) }
    const r = await this.json('/v1/text-to-voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return r.voice_id
  }
}


async function write(out: string, r: Response) {
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()))
}
