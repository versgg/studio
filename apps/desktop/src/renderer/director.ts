// Send to Director (the hand-over itself is src/main/director.ts): a voice from the timeline goes
// to Director, a separate app that turns a voiceover into a video ad. What goes is the voice as it
// plays on its track: the sound clips of the chosen clip's track (only the selected ones when
// several on it are), rendered by the engine's own sound export to voice.wav, from the first
// clip's start to the last one's end, gaps kept as silence. Each clip is one phrase.
// From a sound clip's menu (the timeline's right-click, the Audio page's "…"), File › Send voice
// to Director… and its key (keymap.ts).

import { getUi as audioUi, roleOf, trackName } from './audioState'
import { exportSound, findClip, getState, mediaById, setState, toast, type Clip, type Snapshot, type Track } from './store'

export interface DirectorVoice {
  track: Track
  /** In timeline order. */
  clips: Clip[]
  name: string
  /** From the first clip's start to the last one's end. */
  lengthUs: number
}

/** A track Director can take a voice from: a sound track (not the main track) with clips. */
const voiceTrack = (t: Track | undefined): t is Track => !!t && t.kind === 'audio' && !t.main && t.clips.length > 0

/** The voice a target stands for now (null once its track or clips are gone). */
export function voiceOf(snap: Snapshot | null, target: { trackId: string; clipIds: string[] | null } | null): DirectorVoice | null {
  const track = snap?.project.tracks.find((t) => t.id === target?.trackId)
  if (!voiceTrack(track) || !target) return null
  const picked = target.clipIds
  const clips = track.clips.filter((c) => !c.busy && (!picked || picked.includes(c.id))).sort((a, b) => a.startUs - b.startUs)
  if (!clips.length) return null
  const lengthUs = Math.max(...clips.map((c) => c.startUs + c.durationUs)) - clips[0].startUs
  return { track, clips, name: trackName(track, snap), lengthUs }
}

/**
 * What to send: the chosen clip's track (only the selected clips on it when there are several),
 * else the sound clip selected, the track picked on the Audio page, or the first voice track.
 */
export function directorTarget(clipId?: string): { trackId: string; clipIds: string[] | null } | null {
  const s = getState()
  const snap = s.snap
  const chosen = [clipId, ...s.selection].map((id) => id && findClip(snap, id)).find((f) => f && voiceTrack(f.track))
  if (chosen) {
    const onTrack = s.selection.filter((id) => chosen.track.clips.some((c) => c.id === id))
    return { trackId: chosen.track.id, clipIds: onTrack.length > 1 ? onTrack : null }
  }
  const tracks = snap?.project.tracks.filter(voiceTrack) ?? []
  const track = tracks.find((t) => t.id === audioUi().trackId) ?? tracks.find((t) => roleOf(t, snap) === 'voice') ?? tracks[0]
  return track ? { trackId: track.id, clipIds: null } : null
}

/** Whether there's a voice on the timeline to send (File › Send voice to Director…). */
export const hasVoice = (snap: Snapshot | null) => !!snap?.project.tracks.some(voiceTrack)

/** Opens Send to Director for that clip's voice (or the one directorTarget picks). */
export function askDirector(clipId?: string) {
  const target = directorTarget(clipId)
  if (!target) return toast('There’s no voice on the timeline to send. Add one on a sound track first.')
  setState({ dialog: 'director', directorTarget: target })
}

/** 24.6 s, 1:05.3 */
export function lengthText(us: number): string {
  const s = Math.max(0, us) / 1e6
  if (s < 60) return `${s.toFixed(1)} s`
  const r = s % 60
  return `${Math.floor(s / 60)}:${r < 10 ? '0' : ''}${r.toFixed(1)}`
}

/**
 * Sends the voice: a package folder in Director's inbox, the voice rendered into it by the
 * engine, then send.json written and the folder handed over (and Director opened, if asked).
 * Says how it went in a toast; true when it was sent.
 */
export async function sendToDirector(voice: DirectorVoice, o: { script: string | null; open: boolean }): Promise<boolean> {
  const snap = getState().snap
  const studio = window.studio.services
  const paths = voice.clips.map((c) => mediaById(snap, c.mediaId)?.path ?? '')
  const about = await studio.directorAbout(paths)
  const begun = await studio.directorBegin(voice.name)
  if ('error' in begun) {
    toast(`Couldn’t send to Director: ${begun.error}`, 'error')
    return false
  }
  // voice.wav, as Export › Sound only makes a selection's sound.
  const wav = await exportSound(
    voice.clips.map((c) => c.id),
    begun.dir,
    'voice',
  )
  if ('error' in wav) {
    await studio.directorDiscard(begun.dir)
    toast(`Couldn’t send to Director: ${wav.error}`, 'error')
    return false
  }
  const done = await studio.directorFinish({
    dir: begun.dir,
    name: voice.name,
    clips: voice.clips.map((c) => ({ startUs: c.startUs, durationUs: c.durationUs })),
    labels: (snap?.project.labels ?? []).map((l) => ({ startUs: l.startUs, endUs: l.endUs, text: l.text })),
    // The voiceover's own script when Studio knows it, else one pasted in the dialog.
    script: about.script ?? (o.script?.trim() || null),
    language: about.language,
    open: o.open,
  })
  if ('error' in done) {
    toast(`Couldn’t send to Director: ${done.error}`, 'error')
    return false
  }
  if (o.open && !done.opened) toast('Sent. Open Director to use it.')
  else toast(`Sent to Director: ${done.phrases} phrase${done.phrases === 1 ? '' : 's'}, ${lengthText(done.duration * 1e6)}.`)
  return true
}
