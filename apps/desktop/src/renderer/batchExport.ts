// Home › several projects › Export: each picked project rendered from its folder (it isn't
// opened, and the open one stays as it is), one project after another so they don't fight over
// the graphics card, with the Export window's settings; with its text as .txt too, if asked
// (what's on screen and what's said, as the Export window's Save .txt writes it). The run lives
// here, not in the dialog, so it carries on with the dialog closed, on Home or in another project.

import { useSyncExternalStore } from 'react'
import { call, getState, setState, startExport, subscribeStore, toast, type ExportJob, type Snapshot } from './store'
import { textFile, textOf, type TextWhat } from './textExport'

export type BatchItem = {
  dir: string
  name: string
  /** The files it makes: formats ("9:16", "mp3") and their names without the extension. */
  formats: string[]
  names: Record<string, string>
  /** The .txt's name without " (on screen)" and the extension: the first file's. */
  textName: string
  state: 'waiting' | 'exporting' | 'done' | 'failed' | 'cancelled'
  jobIds: string[]
  error?: string
  /** Its text: saved (`out`), nothing to save (`none`), or why it couldn't be. */
  text?: { out?: string; none?: boolean; error?: string }
}
export type BatchRun = { folder: string; quality: string; bitrateMbps: number; fps?: number; openFolder: boolean; text: TextWhat | null; items: BatchItem[] }

let run: BatchRun | null = null
/** The run's export jobs as last seen (the store lets finished ones go when another export starts). */
let jobs: Record<string, ExportJob> = {}
let view: { run: BatchRun | null; jobs: Record<string, ExportJob> } = { run, jobs }
const listeners = new Set<() => void>()
const emit = () => {
  view = { run: run && { ...run, items: run.items.map((i) => ({ ...i })) }, jobs: { ...jobs } }
  for (const l of listeners) l()
}

/** The run as the dialog shows it. */
export const useBatchExport = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => view,
  )

export const batchRunning = () => !!run?.items.some((i) => i.state === 'waiting' || i.state === 'exporting')

const finished = (j: ExportJob | undefined) => !!j && (j.state === 'done' || j.state === 'failed' || j.state === 'cancelled')

subscribeStore(() => {
  if (!run) return
  const ids = new Set(run.items.flatMap((i) => i.jobIds))
  let changed = false
  for (const j of getState().exports)
    if (ids.has(j.jobId) && jobs[j.jobId] !== j) {
      jobs[j.jobId] = j
      changed = true
    }
  if (changed) settle()
})

/** The project being made: when all its files are, the next one starts. */
function settle() {
  const item = run?.items.find((i) => i.state === 'exporting')
  if (item?.jobIds.length && item.jobIds.every((id) => finished(jobs[id]))) {
    const states = item.jobIds.map((id) => jobs[id].state)
    item.state = states.every((s) => s === 'cancelled') ? 'cancelled' : states.some((s) => s === 'failed') ? 'failed' : 'done'
    if (item.state === 'failed') item.error = item.jobIds.map((id) => jobs[id].error).find(Boolean)
    void next()
  }
  emit()
}

async function next() {
  if (!run) return
  const r = run
  const item = r.items.find((i) => i.state === 'waiting')
  if (!item) {
    const done = r.items.filter((i) => i.state === 'done').length
    const failed = r.items.filter((i) => i.state === 'failed').length
    if (done || failed) toast(`${done} of ${r.items.length} projects exported${failed ? `, ${failed} failed` : ''}.`, failed ? 'error' : undefined)
    if (done && r.openFolder) window.studio.app.openFolder(r.folder)
    return emit()
  }
  item.state = 'exporting'
  emit()
  if (r.text) {
    item.text = await saveText(item, r.folder, r.text)
    emit()
  }
  // Only its text was asked for.
  if (!item.formats.length) {
    item.state = item.text?.error ? 'failed' : 'done'
    if (item.text?.error) item.error = item.text.error
    emit()
    return void next()
  }
  try {
    const ids = await startExport(item.formats, r.quality, r.folder, item.name, null, { names: item.names, bitrateMbps: r.bitrateMbps, ...(r.fps ? { fps: r.fps } : {}), projectDir: item.dir, throwErrors: true })
    if (!ids?.length) throw new Error('Nothing to make.')
    item.jobIds = ids
    for (const j of getState().exports) if (ids.includes(j.jobId)) jobs[j.jobId] = j
    settle()
  } catch (e) {
    item.state = 'failed'
    item.error = (e as Error).message
    emit()
    void next()
  }
}

/** A project's text as .txt next to its video, read from its folder as saved. */
async function saveText(item: BatchItem, folder: string, what: TextWhat): Promise<NonNullable<BatchItem['text']>> {
  try {
    const project = await window.studio.app.readProject(item.dir)
    if (!project) throw new Error('the project couldn’t be read')
    const body = textFile(await textOf({ dir: item.dir, project } as unknown as Snapshot), what)
    if (!body.trim()) return { none: true }
    const tag = what === 'screen' ? ' (on screen)' : what === 'said' ? ' (said)' : ''
    const r = await window.studio.files.writeText(`${folder.replace(/[\\/]$/, '')}${folder.includes('\\') ? '\\' : '/'}${item.textName}${tag}.txt`, body)
    return 'error' in r ? { error: r.error } : { out: r.out }
  } catch (e) {
    return { error: `Its text couldn’t be saved: ${(e as Error).message}` }
  }
}

/** The projects Export was asked for on Home, for the dialog to set up. */
let asked: { dir: string; name: string; width: number; height: number }[] = []
export const askedProjects = () => asked
export function exportProjects(list: { dir: string; name: string; width: number; height: number }[]) {
  asked = list
  // A finished run's list goes; a running one stays on show (another can start once it's done).
  if (!batchRunning()) clearBatchExport()
  setState({ dialog: 'exportProjects' })
}

/** Starts a run; false while another one is still going. */
export function startBatchExport(o: Omit<BatchRun, 'items'>, items: Omit<BatchItem, 'state' | 'jobIds' | 'text'>[]): boolean {
  if (batchRunning()) return false
  run = { ...o, items: items.map((i) => ({ ...i, state: 'waiting', jobIds: [] })) }
  jobs = {}
  void next()
  return true
}

/** Stops the run: the project being made stops, the ones waiting don't start. */
export function cancelBatchExport() {
  if (!run) return
  for (const i of run.items) if (i.state === 'waiting') i.state = 'cancelled'
  for (const i of run.items.filter((x) => x.state === 'exporting')) for (const id of i.jobIds) if (!finished(jobs[id])) void call('export.cancel', { jobId: id })
  emit()
}

/** Forgets a finished run (the dialog shows the setup again). */
export function clearBatchExport() {
  if (batchRunning()) return
  run = null
  jobs = {}
  emit()
}
