// Media › Download on the page: the open project's downloads (main/download.ts does the work),
// and each one saved goes into its project's library: at once when that project is open, else
// the next time it is. With "Remove the on-screen text with Vmake" ticked, the clip then goes
// through the library's Vmake flow (`removeText`), as Remove text with Vmake… would.

import { useSyncExternalStore } from 'react'
import type { DownloadJob } from '../shared/api'
import { getState, onProjectSwitch, projectChanged, projectScope, removeText, sameFolder, toast } from './store'

let jobs: Record<string, DownloadJob> = {}
const listeners = new Set<() => void>()
const set = (next: Record<string, DownloadJob>) => {
  jobs = next
  for (const l of listeners) l()
}
export function useDownloads(): DownloadJob[] {
  const all = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
    () => jobs,
  )
  return Object.values(all).sort((a, b) => a.startedAt - b.startedAt)
}

const bringing = new Set<string>()

/** A saved download into its project's library (when that's the open one), then Vmake if it was asked for. */
async function bringIn(job: DownloadJob) {
  if (job.state !== 'saved' || job.imported || !job.file || bringing.has(job.id)) return
  const scope = projectScope(job.project)
  if (!scope.live()) return
  bringing.add(job.id)
  try {
    const r = await scope.engine<{ imported: string[] }>('media.import', { paths: [job.file] })
    const mediaId = r.imported?.[0]
    await window.studio.services.downloadImported(job.id)
    if (!mediaId) return
    if (job.vmake) {
      // Vmake works from the store's copy of the project: once the new file is in it.
      for (let i = 0; i < 60 && !getState().snap?.project.media.some((m) => m.id === mediaId); i++) await new Promise((r) => setTimeout(r, 50))
      await removeText({ mediaId }, job.vmake)
      toast(`“${job.title}” is in the library; Vmake is taking its text out.`)
    } else toast(`“${job.title}” is in the library.`)
  } catch (e) {
    if (!projectChanged(e)) toast(`“${job.title}” couldn’t come into the library: ${(e as Error).message}`, 'error')
  } finally {
    bringing.delete(job.id)
  }
}

function onJob(job: DownloadJob) {
  const dir = getState().snap?.dir ?? ''
  if (!sameFolder(job.project, dir)) return
  set({ ...jobs, [job.id]: job })
  if (job.state === 'failed' && job.error) toast(`“${job.title}” didn’t download: ${job.error}`, 'error')
  void bringIn(job)
}

/** Follows downloads: each change, and a project's own whenever it's opened. */
export function initDownloads() {
  window.studio.services.onDownloadJob(onJob)
  onProjectSwitch((_from, to) => {
    set({})
    void window.studio.services.downloadList(to).then((list) => {
      if (!sameFolder(getState().snap?.dir ?? '', to)) return
      set(Object.fromEntries(list.map((j) => [j.id, j])))
      for (const j of list) void bringIn(j)
    })
  })
}

/** Starts the picks as downloads into the open project. */
export async function startDownloads(picks: Parameters<typeof window.studio.services.downloadStart>[1]) {
  const dir = getState().snap?.dir
  if (!dir || !picks.length) return
  const r = await window.studio.services.downloadStart(dir, picks)
  if ('error' in r) return void toast(`Couldn’t start the download: ${r.error}`, 'error')
  set({ ...jobs, ...Object.fromEntries(r.map((j) => [j.id, j])) })
}

export const cancelDownload = (id: string) => window.studio.services.downloadCancel(id)
