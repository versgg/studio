import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { EngineProcess, EngineStatus, StemsJob, StudioApi, VmakeJob } from '../shared/api'
import type { DubJob } from '../shared/dub'
import type { TrJob } from '../shared/translate'
import { EngineClient } from './engine-client'
import { Player } from './player'

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const socketPath = arg('studio-socket')
const ringPath = arg('studio-ring')
if (!socketPath || !ringPath) throw new Error('preload: missing --studio-socket / --studio-ring')

const client = new EngineClient(socketPath)
const player = new Player(ringPath, () => ipcRenderer.send('player:first-frame'))

let processStatus: EngineProcess | undefined
const statusListeners = new Set<(s: EngineStatus) => void>()
const emitStatus = () => {
  const s: EngineStatus = { link: client.state, process: processStatus }
  for (const cb of statusListeners) cb(s)
}
client.onState(emitStatus)
ipcRenderer.on('engine:process', (_e, s: EngineProcess) => {
  processStatus = s
  emitStatus()
})
ipcRenderer.invoke('engine:process').then((s: EngineProcess) => {
  processStatus = s
  emitStatus()
})

const api: StudioApi = {
  platform: process.platform,
  silent: process.env.STUDIO_SILENT === '1',
  engine: {
    call: (method, params) => client.call(method, params),
    onStatus(cb) {
      statusListeners.add(cb)
      cb({ link: client.state, process: processStatus })
      return () => statusListeners.delete(cb)
    },
    onEvent: (cb) => client.onEvent(cb),
  },
  services: {
    keys: () => ipcRenderer.invoke('secrets:status'),
    setKey: (name, value) => ipcRenderer.invoke('secrets:set', name, value),
    clearKey: (name) => ipcRenderer.invoke('secrets:clear', name),
    vmakeAccount: () => ipcRenderer.invoke('vmake:account'),
    vmakeKnown: () => ipcRenderer.invoke('vmake:known'),
    vmakeCreate: (o) => ipcRenderer.invoke('vmake:create', o),
    vmakeStart: (id, o) => ipcRenderer.invoke('vmake:start', id, o),
    vmakeCancel: (id, reason) => ipcRenderer.invoke('vmake:cancel', id, reason),
    vmakeJobs: (project) => ipcRenderer.invoke('vmake:jobs', project),
    vmakeSettled: (id) => ipcRenderer.invoke('vmake:settled', id),
    onVmakeJob(cb) {
      const listener = (_e: unknown, job: VmakeJob) => cb(job)
      ipcRenderer.on('vmake:job', listener)
      return () => ipcRenderer.removeListener('vmake:job', listener)
    },
    elevenAccount: () => ipcRenderer.invoke('eleven:account'),
    elevenCheckKey: () => ipcRenderer.invoke('eleven:checkKey'),
    elevenModels: () => ipcRenderer.invoke('eleven:models'),
    elevenVoices: (search) => ipcRenderer.invoke('eleven:voices', search),
    elevenLibrary: (search) => ipcRenderer.invoke('eleven:library', search),
    elevenSpeak: (o) => ipcRenderer.invoke('eleven:speak', o),
    elevenChangeVoice: (o) => ipcRenderer.invoke('eleven:changeVoice', o),
    elevenClone: (o) => ipcRenderer.invoke('eleven:clone', o),
    elevenDesign: (o) => ipcRenderer.invoke('eleven:design', o),
    elevenSaveDesigned: (o) => ipcRenderer.invoke('eleven:saveDesigned', o),
    transcribeParts: (o) => ipcRenderer.invoke('captions:transcribe', o),
    scriptsFor: (paths) => ipcRenderer.invoke('captions:scripts', paths),
    stemsStart: (o) => ipcRenderer.invoke('stems:start', o),
    stemsJobs: (project) => ipcRenderer.invoke('stems:jobs', project),
    stemsCancel: (dir) => ipcRenderer.invoke('stems:cancel', dir),
    onStemsJob(cb) {
      const listener = (_e: unknown, job: StemsJob) => cb(job)
      ipcRenderer.on('stems:job', listener)
      return () => ipcRenderer.removeListener('stems:job', listener)
    },
    dubStart: (o) => ipcRenderer.invoke('dub:start', o),
    dubJobs: (project) => ipcRenderer.invoke('dub:jobs', project),
    dubSummary: (projects) => ipcRenderer.invoke('dub:summary', projects),
    dubGo: (id, o) => ipcRenderer.invoke('dub:go', id, o),
    dubRetry: (id) => ipcRenderer.invoke('dub:retry', id),
    dubRemoveAgain: (id) => ipcRenderer.invoke('dub:removeAgain', id),
    dubCancel: (id) => ipcRenderer.invoke('dub:cancel', id),
    dubResult: (id) => ipcRenderer.invoke('dub:result', id),
    dubApplied: (id) => ipcRenderer.invoke('dub:applied', id),
    dubReroll: (id, lineIds, edits) => ipcRenderer.invoke('dub:reroll', id, lineIds, edits),
    dubPickTake: (id, lineId, take) => ipcRenderer.invoke('dub:pickTake', id, lineId, take),
    dubFailed: (id, reason) => ipcRenderer.invoke('dub:failed', id, reason),
    onDubJob(cb) {
      const listener = (_e: unknown, job: DubJob) => cb(job)
      ipcRenderer.on('dub:job', listener)
      return () => ipcRenderer.removeListener('dub:job', listener)
    },
    translateContext: (project, paths) => ipcRenderer.invoke('translate:context', project, paths),
    capcutList: () => ipcRenderer.invoke('capcut:list'),
    capcutRead: (dir, into) => ipcRenderer.invoke('capcut:read', dir, into),
    capcutRoot: () => ipcRenderer.invoke('capcut:root'),
    capcutSetRoot: (dir) => ipcRenderer.invoke('capcut:setRoot', dir),
    projectFonts: (project) => ipcRenderer.invoke('fonts:project', project),
    translateStart: (o) => ipcRenderer.invoke('translate:start', o),
    translateReadVoice: (project, file) => ipcRenderer.invoke('translate:readVoice', project, file),
    translatePickVoice: (project, file, voice) => ipcRenderer.invoke('translate:pickVoice', project, file, voice),
    translateVoices: () => ipcRenderer.invoke('translate:voices'),
    translateJobs: (project) => ipcRenderer.invoke('translate:jobs', project),
    translateSummary: (projects) => ipcRenderer.invoke('translate:summary', projects),
    translateGo: (id, o) => ipcRenderer.invoke('translate:go', id, o),
    translateRetry: (id) => ipcRenderer.invoke('translate:retry', id),
    translateCancel: (id) => ipcRenderer.invoke('translate:cancel', id),
    translateResult: (id) => ipcRenderer.invoke('translate:result', id),
    translateApplied: (id) => ipcRenderer.invoke('translate:applied', id),
    translateFailed: (id, reason) => ipcRenderer.invoke('translate:failed', id, reason),
    onTranslateJob(cb) {
      const listener = (_e: unknown, job: TrJob) => cb(job)
      ipcRenderer.on('translate:job', listener)
      return () => ipcRenderer.removeListener('translate:job', listener)
    },
    saveRecording: (file, data) => ipcRenderer.invoke('file:saveRecording', file, data),
    onTaskProgress(cb) {
      const listener = (_e: unknown, p: { taskId: string; stage: string; fraction: number }) => cb(p)
      ipcRenderer.on('task:progress', listener)
      return () => ipcRenderer.removeListener('task:progress', listener)
    },
  },
  files: {
    writeAsset: (path, data) => ipcRenderer.invoke('file:writeAsset', path, data),
    exists: (path) => ipcRenderer.invoke('file:exists', path),
    importSticker: (src, dir) => ipcRenderer.invoke('file:importSticker', src, dir),
    writeSrt: (path, text) => ipcRenderer.invoke('file:writeSrt', path, text),
    writeText: (path, text) => ipcRenderer.invoke('file:writeText', path, text),
    luts: () => ipcRenderer.invoke('luts:list'),
    useLut: (src, dir) => ipcRenderer.invoke('luts:use', src, dir),
    openFrames: (o) => ipcRenderer.invoke('frames:open', o),
    nextFrame: (id) => ipcRenderer.invoke('frames:next', id),
    closeFrames: (id) => ipcRenderer.send('frames:close', id),
    openMatte: (o) => ipcRenderer.invoke('matte:open', o),
    writeMatte: (id, data) => ipcRenderer.invoke('matte:write', id, data),
    closeMatte: (id, cancel) => ipcRenderer.invoke('matte:close', id, cancel),
    finishMatte: (o) => ipcRenderer.invoke('matte:finish', o),
    samples: (o) => ipcRenderer.invoke('audio:samples', o),
  },
  settings: {
    get: (key) => ipcRenderer.invoke('settings:get', key),
    set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  },
  sounds: {
    effects: () => ipcRenderer.invoke('sounds:effects'),
    musicFolder: () => ipcRenderer.invoke('sounds:musicFolder'),
    setMusicFolder: (dir) => ipcRenderer.invoke('sounds:setMusicFolder', dir),
    scanMusic: () => ipcRenderer.invoke('sounds:scanMusic'),
    read: (path) => ipcRenderer.invoke('sounds:read', path),
    intoProject: (path, dir, name) => ipcRenderer.invoke('sounds:intoProject', path, dir, name),
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggleMaximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onMaximized(cb) {
      const listener = (_e: unknown, maximized: boolean) => cb(maximized)
      ipcRenderer.on('window:maximized', listener)
      return () => ipcRenderer.removeListener('window:maximized', listener)
    },
  },
  app: {
    paths: () => ipcRenderer.invoke('app:paths'),
    openMedia: () => ipcRenderer.invoke('dialog:openMedia'),
    chooseFolder: (defaultPath, title) => ipcRenderer.invoke('dialog:chooseFolder', defaultPath, title),
    chooseFile: (o) => ipcRenderer.invoke('dialog:chooseFile', o),
    saveFile: (o) => ipcRenderer.invoke('dialog:saveFile', o),
    openProject: (defaultPath) => ipcRenderer.invoke('dialog:openProject', defaultPath),
    showItem: (path) => ipcRenderer.send('shell:showItem', path),
    openFolder: (path) => ipcRenderer.send('shell:openFolder', path),
    openVideo: (path) => ipcRenderer.send('shell:openVideo', path),
    pathForFile: (file) => webUtils.getPathForFile(file),
    existing: (paths) => ipcRenderer.invoke('fs:existing', paths),
    projects: (extra) => ipcRenderer.invoke('projects:list', extra ?? []),
    projectStill: (dir) => ipcRenderer.invoke('project:still', dir),
    saveProjectAs: (dir, name, pick) => ipcRenderer.invoke('project:saveAs', dir, name, pick),
    renameProject: (dir, name) => ipcRenderer.invoke('project:rename', dir, name),
    projectSize: (dir) => ipcRenderer.invoke('project:size', dir),
    deleteProject: (dir) => ipcRenderer.invoke('project:delete', dir),
    versions: (dir) => ipcRenderer.invoke('project:versions', dir),
    saveVersion: (dir, name) => ipcRenderer.invoke('project:saveVersion', dir, name),
    restoreVersion: (dir, file) => ipcRenderer.invoke('project:restoreVersion', dir, file),
    deleteVersion: (dir, file) => ipcRenderer.invoke('project:deleteVersion', dir, file),
    mcpCommand: () => ipcRenderer.invoke('mcp:command'),
    openExternal: (url) => ipcRenderer.send('shell:openExternal', url),
  },
  player: {
    attach: (id) => player.attach(id),
    detach: () => player.detach(),
    resetStats: () => player.resetStats(),
    onStats: (cb) => player.onStats(cb),
  },
}
contextBridge.exposeInMainWorld('studio', api)

// Bench mode (`electron . --bench=1080x1920@30`): start the preview, warm up,
// measure for 10 s, hand the numbers to the main process, which writes them and quits.
const bench = arg('studio-bench')
if (bench) {
  const m = /^(\d+)x(\d+)@(\d+(?:\.\d+)?)$/.exec(bench)
  if (!m) throw new Error(`bad --bench value ${bench}`)
  const [width, height, fps] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const off = client.onState(async (state) => {
    if (state !== 'connected') return
    off()
    await client.call('preview.start', { width, height, fps })
    await new Promise((r) => setTimeout(r, 2000))
    player.resetStats()
    player.benchHold = true
    const before = await client.call('preview.status')
    ipcRenderer.send('bench:measure-start')
    const seconds = 10
    await new Promise((r) => setTimeout(r, seconds * 1000))
    const stats = player.snapshot()
    const engine = await client.call('preview.status')
    await client.call('preview.stop')
    const engineCpuPercent = engine.cpuMs != null && before.cpuMs != null ? Math.round(((engine.cpuMs - before.cpuMs) / (seconds * 1000)) * 1000) / 10 : null
    ipcRenderer.send('bench:done', { config: { width, height, fps }, player: stats, engine, engineCpuPercent, devicePixelRatio: window.devicePixelRatio, refresh: stats.fpsDraw })
  })
}
