// Voices and voiceovers (ElevenLabs, on the user's own key) and microphone recordings.

import { useSyncExternalStore } from 'react'
import type { Voice } from '../shared/api'
import { basename } from './format'
import { alreadyRunning, bringInFor, endTask, findClip, freshName, getState, mediaById, patchTask, projectChanged, projectScope, setState, startTask, toast, togglePlay } from './store'

/** The voice list's sections, in order: the user's own clones first. */
export const VOICE_GROUPS: [string, string][] = [
  ['recent', 'Used lately'],
  ['cloned', 'Your voice clones'],
  ['professional', 'Professional clones'],
  ['generated', 'Designed voices'],
  ['famous', 'Iconic voices'],
  ['high_quality', 'High quality'],
  ['premade', 'ElevenLabs defaults (available until 31 Dec 2026)'],
  ['library', 'Voice Library'],
]

const VOICE_KEY = 'studio.voice.v1'

export function savedVoice(): Voice | null {
  try {
    return JSON.parse(localStorage.getItem(VOICE_KEY) ?? 'null')
  } catch {
    return null
  }
}

export function chooseVoice(voice: Voice) {
  setState({ voice })
  try {
    localStorage.setItem(VOICE_KEY, JSON.stringify(voice))
  } catch {}
}

const isError = (r: unknown): r is { error: string; auth?: boolean } => !!r && typeof r === 'object' && 'error' in r

/** Without "Models (Read)" the key can still speak; v4 is offered then. */
const FALLBACK_MODELS = [{ id: 'eleven_v4', name: 'Eleven v4', maxChars: 0, languages: [] as string[] }]

/**
 * Checks the saved key and loads the account, models and voices. What ElevenLabs sent last is
 * shown at once and each answer lands as it comes, so a slow or silent one never holds up a
 * voiceover (2026-11-18: ElevenLabs went silent on one account's voices and details for minutes
 * while it still spoke). A refused key asks for a new one; a key that isn't allowed one of
 * these keeps working for the rest, with the reason shown.
 */
let loading: Promise<void> | null = null
export function loadEleven() {
  loading ??= loadElevenNow().finally(() => (loading = null))
  return loading
}

const when = (t?: number) => (t ? new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '')

async function loadElevenNow() {
  const keys = await window.studio.services.keys()
  if (!keys.elevenlabs) return setState({ eleven: { hasKey: false } })
  const kept = await window.studio.services.elevenKept()
  const saved = savedVoice()
  const now = getState().eleven
  const first = now.voices ?? kept.voices ?? (saved ? [saved] : undefined)
  setState({ eleven: { hasKey: true, account: now.account ?? kept.account, models: now.models ?? kept.models, voices: first, stale: !now.voices && !!first, note: now.note, error: undefined } })
  const land = (patch: Partial<ReturnType<typeof getState>['eleven']>) => setState({ eleven: { ...getState().eleven, ...patch } })
  let refused: string | null = null
  const errors: string[] = []
  const take = async <T,>(p: Promise<T | { error: string; auth?: boolean }>, ok: (v: T) => void, quiet = false) => {
    const r = await p
    if (isError(r)) {
      if (r.auth) refused = r.error
      else if (!quiet || !/didn’t answer/.test(r.error)) errors.push(r.error)
      return false
    }
    ok(r)
    return true
  }
  const [, , listed] = await Promise.all([
    take(window.studio.services.elevenModels(), (models) => land({ models })),
    // The credits line just waits if ElevenLabs is slow with them.
    take(window.studio.services.elevenAccount(), (account) => land({ account }), true),
    take(window.studio.services.elevenVoices(), (voices) => land({ voices, stale: false, note: undefined }), true),
  ])
  if (refused) return setState({ eleven: { hasKey: false, error: refused } })
  const e = getState().eleven
  if (!e.models?.length) land({ models: FALLBACK_MODELS })
  if (!listed) {
    // No list this time: the one kept from before, else the voices spoken with lately (the history still answers).
    let list = kept.voices
    let why = list?.length ? `These are your voices as of ${when(kept.voicesAt)}.` : ''
    if (!list?.length) {
      const recent = await window.studio.services.elevenRecent()
      if (!isError(recent) && recent.length) {
        list = recent
        why = 'These are the voices you used lately; they still speak.'
      }
    }
    if (!list?.length && saved) {
      list = [saved]
      why = `${saved.name}, your last voice, still speaks.`
    }
    land({ voices: list ?? [], stale: true, note: `ElevenLabs didn’t send your voice list just now.${why ? ` ${why}` : ''}` })
    // Asked again in a minute, quietly.
    setTimeout(() => void window.studio.services.elevenVoices().then((v) => !isError(v) && getState().eleven.hasKey && land({ voices: v, stale: false, note: undefined })), 60_000)
  }
  land({ error: errors.length ? [...new Set(errors)].join(' ') : undefined })
  const list = getState().eleven.voices ?? []
  if (!getState().voice && list.length) {
    const first = VOICE_GROUPS.map(([g]) => list.find((v) => v.category === g)).find(Boolean)
    chooseVoice(saved ?? first ?? list[0])
  }
}

// The line under a key field after saving: whether the key works and what it isn't allowed.

export interface KeyCheck {
  ok: boolean
  text: string
}
const checks: Record<'elevenlabs', KeyCheck | null> = { elevenlabs: null }
const checkListeners = new Set<() => void>()
export function useKeyCheck(name: 'elevenlabs'): KeyCheck | null {
  return useSyncExternalStore(
    (l) => {
      checkListeners.add(l)
      return () => checkListeners.delete(l)
    },
    () => checks[name],
  )
}
function setCheck(name: 'elevenlabs', c: KeyCheck | null) {
  checks[name] = c
  for (const l of checkListeners) l()
}

/** User, Voices (read) and Models: the checks that spend nothing and change nothing. */
export async function checkElevenKey() {
  const r = await window.studio.services.elevenCheckKey()
  if (!r.works) return setCheck('elevenlabs', { ok: false, text: r.error ?? 'ElevenLabs refused that key.' })
  const n = r.notAllowed
  const silent = r.silent?.length ? ` ElevenLabs didn’t answer for ${r.silent.join(' and ')} just now; that’s on their side, not the key.` : ''
  setCheck('elevenlabs', n.length ? { ok: false, text: `Key works. Not allowed: ${n.join(', ')}. Edit the key on elevenlabs.io to turn ${n.length === 1 ? 'it' : 'them'} on.${silent}` } : { ok: true, text: `Key works.${silent}` })
}

export async function saveElevenKey(key: string) {
  const r = await window.studio.services.setKey('elevenlabs', key)
  if (r.error) return toast(r.error, 'error')
  if (r.stored === false) toast('This computer can’t encrypt saved keys, so the key is kept until Studio closes.')
  setCheck('elevenlabs', null)
  await Promise.all([checkElevenKey(), loadEleven()])
}

export async function forgetElevenKey() {
  await window.studio.services.clearKey('elevenlabs')
  setState({ eleven: { hasKey: false } })
}

async function refreshCredits() {
  const a = await window.studio.services.elevenAccount()
  if (!isError(a)) setState({ eleven: { ...getState().eleven, account: a } })
}


/** A voiceover from text, saved in the project's `voiceovers` folder. */
export async function generateVoiceover(o: { voice: Voice; text: string; modelId: string; stability: number; similarity: number; speed?: number; languageCode?: string; atPlayhead: boolean }) {
  const words = o.text.replace(/\[[^\]]*\]/g, ' ').trim().split(/\s+/).slice(0, 5).join(' ')
  const scope = projectScope()
  const out = scope.path('voiceovers', freshName(`${o.voice.name} - ${words}`, '.mp3'))
  if (alreadyRunning('voiceover')) return
  const at = o.atPlayhead ? getState().positionUs : null
  const id = startTask(`Voiceover: ${o.voice.name}`, 'voiceover')
  // ElevenLabs gives no progress while it speaks: the button shows the time it's taking.
  patchTask(id, { stage: 'ElevenLabs is speaking', fraction: 0.3, waiting: true })
  const r = await window.studio.services.elevenSpeak({ voice: o.voice, text: o.text, modelId: o.modelId, stability: o.stability, similarity: o.similarity, speed: o.speed, languageCode: o.languageCode, out })
  if (isError(r)) return endTask(id, r.error)
  // A Voice Library voice is in the account now; remember it as such.
  if (o.voice.category === 'library' && r.voiceId !== o.voice.id) {
    chooseVoice({ ...o.voice, id: r.voiceId, category: 'professional', ownerId: undefined })
    loadEleven()
  }
  patchTask(id, { stage: 'Adding it', fraction: 0.9, waiting: false })
  try {
    await bringInFor(scope, r.out, at, `The voiceover "${basename(r.out)}"`)
    endTask(id)
  } catch (e) {
    endTask(id, (e as Error).message)
  }
  refreshCredits()
}

/** The voice changer: a recording (or the part a clip uses) spoken again in `voice`. */
export async function changeVoice(target: { mediaId: string; clipId?: string }, voice: Voice, removeNoise = true) {
  const media = mediaById(getState().snap, target.mediaId)
  if (!media) return
  if (voice.category === 'library') return toast('Use a voice from your account for the voice changer (generate one voiceover with it first to add it).', 'error')
  const clip = target.clipId ? findClip(getState().snap, target.clipId)?.clip : undefined
  const length = clip?.durationUs ?? media.durationUs
  if (length > 5 * 60_000_000) return toast('The voice changer takes up to 5 minutes at a time. Split the clip first.', 'error')
  const stem = media.name.replace(/\.[^.]+$/, '')
  if (alreadyRunning('voice-changer', target.clipId ?? target.mediaId)) return
  const id = startTask(`Voice changer: ${voice.name}`, 'voice-changer', target.clipId ?? target.mediaId)
  const scope = projectScope()
  try {
    let input = media.path
    if (clip || media.kind !== 'audio') {
      patchTask(id, { stage: 'Cutting out the sound', fraction: 0.05 })
      const r = await scope.engine('media.extractRange', { mediaId: media.id, inUs: clip?.inUs ?? 0, durationUs: length, out: scope.path('voiceovers', `${stem}-${id}-part.m4a`) })
      input = r.out
    }
    patchTask(id, { stage: 'ElevenLabs is changing the voice', fraction: 0.3, waiting: true })
    const out = scope.path('voiceovers', freshName(`${stem} as ${voice.name}`, '.mp3'))
    const r = await window.studio.services.elevenChangeVoice({ voiceId: voice.id, input, out, removeNoise })
    if (isError(r)) throw new Error(r.error)
    patchTask(id, { stage: 'Adding it', fraction: 0.9 })
    refreshCredits()
    // Another project open by now: the new voice waits for this one, in its library.
    const newId = await bringInFor(scope, r.out, null, `"${basename(r.out)}"`)
    if (!newId) return endTask(id)
    if (clip && findClip(await scope.latest(), clip.id)) await scope.call('clip.replaceMedia', { clipId: clip.id, mediaId: newId, label: 'Change voice' })
    endTask(id)
    toast(clip ? `The clip now speaks as ${voice.name} (Ctrl+Z goes back).` : `"${basename(r.out)}" is in the library.`)
  } catch (e) {
    endTask(id, projectChanged(e) ? undefined : (e as Error).message)
  }
}

/** An instant voice clone from recordings in the library. */
export async function cloneVoice(name: string, mediaIds: string[], removeNoise: boolean) {
  const files = mediaIds.map((m) => mediaById(getState().snap, m)?.path).filter((p): p is string => !!p)
  if (alreadyRunning('clone')) return
  const id = startTask(`Cloning a voice: ${name}`, 'clone')
  patchTask(id, { stage: 'Uploading the recordings', fraction: 0.3, waiting: true })
  const r = await window.studio.services.elevenClone({ name, files, removeNoise })
  if (isError(r)) return endTask(id, r.error)
  endTask(id)
  await loadEleven()
  const v = getState().eleven.voices?.find((x) => x.id === r.voiceId)
  if (v) chooseVoice(v)
  toast(`"${name}" is ready in Your voice clones.`)
}

/** Voice Design, one round: three voices from a description (ElevenLabs credits for the preview text). */
export const designVoices = (description: string, text: string, model: string) => window.studio.services.elevenDesign({ description, text: text.trim() || undefined, model })

/** Keeps a designed voice in the account and makes it the voice for voiceovers; returns what went wrong, if anything. */
export async function keepDesignedVoice(name: string, description: string, previewId: string, heard: string[]): Promise<string | null> {
  const r = await window.studio.services.elevenSaveDesigned({ name, description, previewId, heard })
  if (isError(r)) return r.error
  await loadEleven()
  const v = getState().eleven.voices?.find((x) => x.id === r.voiceId)
  if (v) chooseVoice(v)
  toast(`"${name}" is ready in Designed voices.`)
  return null
}

// Recording

export interface Recorder {
  stop(): void
  /** 0–1, for the level meter. */
  level(): number
  startedAt: number
}

/**
 * Records from a microphone into the project's `recordings` folder. With `alongTimeline`,
 * the timeline plays while you speak and the recording lands where the playhead started.
 */
export async function startRecording(deviceId: string | undefined, alongTimeline: boolean, onDone: () => void): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
  const ctx = new AudioContext()
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  ctx.createMediaStreamSource(stream).connect(analyser)
  const samples = new Float32Array(analyser.fftSize)
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
  const rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 192_000 })
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  const at = getState().positionUs
  const playing = alongTimeline && !!getState().snap?.durationUs && !getState().playing
  // A recording belongs to the project it was made in, even if another is opened before it stops.
  const scope = projectScope()
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop())
    ctx.close()
    if (playing && getState().playing) togglePlay()
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.')
    const name = freshName(`Recording ${stamp}`, '.m4a')
    const raw = scope.path('recordings', name.replace(/\.m4a$/, '.webm'))
    try {
      const r = await window.studio.services.saveRecording(raw, await new Blob(chunks, { type: mime }).arrayBuffer())
      if ('error' in r) throw new Error(r.error)
      // The recorder's WebM has no length in it; the engine re-saves it as an .m4a that does.
      const m = await window.studio.engine.call('media.toAudio', { input: r.out, out: scope.path('recordings', name) })
      await bringInFor(scope, m.out, alongTimeline || !scope.live() ? at : getState().positionUs, `The recording "${name}"`)
    } catch (e) {
      toast(`The recording couldn’t be saved: ${(e as Error).message}`, 'error')
    }
    onDone()
  }
  rec.start(250)
  if (playing) togglePlay()
  return {
    startedAt: performance.now(),
    stop: () => rec.state !== 'inactive' && rec.stop(),
    level() {
      analyser.getFloatTimeDomainData(samples)
      let peak = 0
      for (const s of samples) peak = Math.max(peak, Math.abs(s))
      return Math.min(1, peak)
    },
  }
}
