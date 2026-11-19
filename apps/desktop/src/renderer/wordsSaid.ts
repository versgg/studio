// Change words said (right-click on a sentence a translation or a dub spoke): its words in the
// language it's said in, to change; the same voice then says the new words where it is, made the
// way the translation (or dub) made it: its voice, language, model and speed, fitted before the
// next sentence. The captions under it follow the new words.

import { recaption } from './captions'
import { dubbedLines, rerollLines } from './dub'
import { endTask, findClip, getState, mediaById, patchTask, projectChanged, projectScope, startTask, toast } from './store'
import type { DubJob } from '../shared/dub'

export type SpokenLine = { id: string; text: string; original: string; lang: string; from: string; dur: number; dub?: DubJob }

const isError = (r: unknown): r is { error: string } => !!r && typeof r === 'object' && 'error' in r
const samePath = (a: string, b: string) => (window.studio.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

/** Whether a clip plays a sentence a translation said (its file is in the copy's translation folder). */
export function isTranslatedLine(clipId: string): boolean {
  const snap = getState().snap
  const clip = findClip(snap, clipId)?.clip
  const path = (clip && mediaById(snap, clip.mediaId)?.path) ?? ''
  const name = path.split(/[\\/]/).pop() ?? ''
  const folder = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))
  return !!snap && /^line-/.test(name) && samePath(folder, [snap.dir, 'translation'].join(snap.dir.includes('\\') ? '\\' : '/'))
}

/** The sentence a clip plays and what it says now (null: not one a translation or a dub spoke). */
export async function spokenLineOf(clipId: string): Promise<SpokenLine | null> {
  const snap = getState().snap
  const clip = findClip(snap, clipId)?.clip
  const path = clip && mediaById(snap, clip.mediaId)?.path
  if (!snap || !clip || !path) return null
  const dubbed = dubbedLines(snap, [clipId])[0]
  if (dubbed) {
    const r = await window.studio.services.dubResult(dubbed.job.id)
    if (isError(r)) return null
    const id = dubbed.lineIds[0]
    const l = r.voice?.lines.find((x) => x.id === id)
    if (!l) return null
    // The words of the take the clip plays (Ctrl+Z may have put an earlier one back).
    const text = l.takes?.find((t) => samePath(t.file, path))?.text ?? l.text
    return { id, text, original: r.said.find((x) => x.id === id)?.text ?? '', lang: dubbed.job.lang, from: r.speech?.language ?? '', dur: l.dur, dub: dubbed.job }
  }
  const r = await window.studio.services.translateSpoken(snap.dir)
  if (isError(r)) return null
  const l = r.lines.find((x) => samePath(x.file, path))
  return l ? { id: l.id, text: l.text, original: l.original, lang: r.lang, from: r.from, dur: l.dur } : null
}

/** The sentence said again with `text`, swapped in where its clip is, its captions following. */
export async function changeWordsSaid(clipId: string, line: SpokenLine, text: string) {
  if (line.dub) return void rerollLines(line.dub, [line.id], { [line.id]: text })
  const scope = projectScope()
  const task = startTask('Change words said', 'respeak', clipId)
  patchTask(task, { stage: 'ElevenLabs is saying it', fraction: 0.3, waiting: true })
  const r = await window.studio.services.translateRespeak(scope.dir, { [line.id]: text })
  if (isError(r)) return endTask(task, r.error)
  const l = r[0]
  if (!l) return endTask(task, 'Nothing was said again.')
  patchTask(task, { stage: 'Putting it in', fraction: 0.9, waiting: false })
  try {
    const label = 'Change words said'
    const gesture = `${label} ${Date.now().toString(36)}`
    const imp = await scope.engine<{ imported: string[] }>('media.import', { paths: [l.file], gesture, label })
    const mediaId = imp?.imported?.[0]
    const clip = findClip(await scope.latest(), clipId)?.clip
    if (!mediaId || !clip) throw new Error('its clip is gone')
    await scope.engine('clip.replaceMedia', { clipId, mediaId, whole: true, gesture, label })
    const speed = clip.speed ?? 1
    const time = (s: number) => clip.startUs + Math.round((s * 1e6) / speed)
    await recaption(line.lang, [{ fromUs: clip.startUs, toUs: Math.max(time(l.dur), clip.startUs + clip.durationUs), words: l.words.map((w) => ({ text: w.text, start: time(w.start), end: time(w.end) })) }], gesture, scope)
    endTask(task)
    toast(`Said again: “${text}”${l.tempo > 1.001 ? ' (a little faster, to fit before the next sentence)' : ''}. Ctrl+Z goes back.`)
  } catch (e) {
    endTask(task, projectChanged(e) ? undefined : `Couldn’t put it in: ${(e as Error).message}`)
  }
}
