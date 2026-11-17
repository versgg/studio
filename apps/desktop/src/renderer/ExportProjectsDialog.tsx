// Home › several projects › Export (batchExport.ts): the Export window's settings for all of
// them at once (formats, quality, folder, file names), then each project's files as they're made.
// Closed while it runs, the projects carry on.

import './export-projects.css'
import { useMemo, useState } from 'react'
import { FORMATS } from './format'
import { DEFAULT_PATTERN, fileStem, loadPrefs, MBPS, PREFS_KEY, QUALITY, SOUNDS, type Prefs } from './ExportDialog'
import { askedProjects, batchRunning, cancelBatchExport, clearBatchExport, startBatchExport, useBatchExport, type BatchItem } from './batchExport'
import { Pills } from './controls'
import { useStore } from './store'

const OWN = 'own'
const sep = (folder: string) => (folder.includes('\\') ? '\\' : '/')
const formatOf = (p: { width: number; height: number }) => FORMATS.find(([, w, h]) => w === p.width && h === p.height)?.[0] ?? '9:16'

function itemLine(i: BatchItem, jobs: ReturnType<typeof useBatchExport>['jobs']): string {
  if (i.state === 'waiting') return 'Waiting'
  if (i.state === 'cancelled') return 'Stopped'
  if (i.state === 'failed') return `Failed: ${i.error ?? 'unknown error'}`
  const files = i.jobIds.map((id) => jobs[id]).filter(Boolean)
  if (i.state === 'done') return files.length === 1 ? 'Done' : `Done · ${files.length} files`
  const f = files.length ? files.reduce((n, j) => n + (j.state === 'done' ? 1 : j.fraction), 0) / files.length : 0
  return `Exporting · ${Math.round(f * 100)} %`
}

export function ExportProjectsDialog({ close }: { close: () => void }) {
  const paths = useStore((s) => s.paths)
  const caps = useStore((s) => s.caps)
  const { run, jobs } = useBatchExport()
  const projects = useMemo(askedProjects, [])
  const prefs = useMemo(loadPrefs, [])
  // Each project in its own format to start with, and the sound files the Export window was last set to.
  const [formats, setFormats] = useState<string[]>(() => [OWN, ...(prefs.formats ?? []).filter((f) => SOUNDS.some(([s]) => s === f))])
  const [quality, setQuality] = useState(prefs.quality ?? 'balanced')
  const [folder, setFolder] = useState(prefs.folder ?? (paths ? `${paths.videos}${sep(paths.videos)}Studio Exports` : ''))
  const [pattern, setPattern] = useState(prefs.pattern ?? DEFAULT_PATTERN)
  const [openAfter, setOpenAfter] = useState((prefs.after ?? 'Open folder') === 'Open folder')
  const [starting, setStarting] = useState(false)
  const canMp3 = caps?.mp3 !== false

  const toggle = (f: string) =>
    setFormats((now) => {
      if (f === OWN) return [OWN, ...now.filter((x) => SOUNDS.some(([s]) => s === x))]
      const on = now.includes(f) ? now.filter((x) => x !== f) : [...now.filter((x) => x !== OWN || SOUNDS.some(([s]) => s === f)), f]
      return on.length ? on : [OWN]
    })
  const filesOf = (p: { width: number; height: number }) => [...(formats.includes(OWN) ? [formatOf(p)] : []), ...FORMATS.map(([f]) => f).filter((f) => formats.includes(f)), ...SOUNDS.map(([s]) => s).filter((s) => formats.includes(s) && (s !== 'mp3' || canMp3))]
  const isSound = (f: string) => SOUNDS.some(([s]) => s === f)
  const stem = (name: string, f: string, v: number) => fileStem(pattern, name, isSound(f) ? 'audio' : f, v)
  const sample = projects[0] ? `${stem(projects[0].name, filesOf(projects[0])[0] ?? '9:16', 1)}.${isSound(filesOf(projects[0])[0] ?? '') ? filesOf(projects[0])[0] : 'mp4'}` : ''
  const total = projects.reduce((n, p) => n + filesOf(p).length, 0)

  const choose = async () => {
    const f = await window.studio.app.chooseFolder(folder || paths?.videos, 'Export to folder')
    if (f) setFolder(f)
  }
  const start = async () => {
    setStarting(true)
    try {
      // Kept for next time, here and in the Export window (each project's own format isn't a format there).
      try {
        const keep: Prefs = { ...loadPrefs(), quality, folder, pattern, after: openAfter ? 'Open folder' : 'Do nothing', ...(formats.includes(OWN) ? {} : { formats: formats.filter((f) => f !== OWN) }) }
        localStorage.setItem(PREFS_KEY, JSON.stringify(keep))
      } catch {}
      const items = []
      for (const p of projects) {
        const fs = filesOf(p)
        // {version}: the first number none of this project's files in the folder uses yet.
        let v = 1
        if (pattern.includes('{version}'))
          for (; v < 200; v++) {
            const exists = await window.studio.app.existing(fs.map((f) => `${folder}${sep(folder)}${stem(p.name, f, v)}.${isSound(f) ? f : 'mp4'}`))
            if (!exists.some(Boolean)) break
          }
        items.push({ dir: p.dir, name: p.name, formats: fs, names: Object.fromEntries(fs.map((f) => [f, stem(p.name, f, v)])) })
      }
      startBatchExport({ folder, quality, bitrateMbps: prefs.bitrate?.[quality] ?? MBPS[quality], ...(prefs.fps ? { fps: prefs.fps } : {}), openFolder: openAfter }, items)
    } finally {
      setStarting(false)
    }
  }
  const done = () => {
    if (!batchRunning()) clearBatchExport()
    close()
  }

  if (run) {
    const going = run.items.some((i) => i.state === 'waiting' || i.state === 'exporting')
    const ok = run.items.filter((i) => i.state === 'done').length
    return (
      <>
        <div className="modal-body">
          <p className="xp-summary">{going ? `Exporting ${run.items.length} projects, one after another, to ${run.folder}` : `${ok} of ${run.items.length} projects exported to ${run.folder}`}</p>
          <div className="xp-list" aria-label="Projects">
            {run.items.map((i) => {
              const files = i.jobIds.map((id) => jobs[id]).filter(Boolean)
              const f = files.length ? files.reduce((n, j) => n + (j.state === 'done' ? 1 : j.fraction), 0) / files.length : 0
              return (
                <div key={i.dir} className={`xp-item ${i.state}`}>
                  <span className="xp-name" title={i.dir}>
                    {i.name}
                    <span className="xp-files">{i.formats.map((x) => (isSound(x) ? x.toUpperCase() : x)).join(' · ')}</span>
                  </span>
                  <span className="xp-state" title={itemLine(i, jobs)}>
                    {itemLine(i, jobs)}
                  </span>
                  {i.state === 'exporting' && (
                    <span className="xp-bar" aria-hidden="true">
                      <span style={{ width: `${Math.round(f * 100)}%` }} />
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
        <footer>
          <span className="footer-note">{going ? 'Carries on if this is closed.' : ''}</span>
          {going ? (
            <button type="button" className="button" onClick={cancelBatchExport}>
              Stop
            </button>
          ) : (
            <button type="button" className="button" onClick={() => window.studio.app.openFolder(run.folder)}>
              Show folder
            </button>
          )}
          <button type="button" className="button primary" onClick={done}>
            {going ? 'Close' : 'Done'}
          </button>
        </footer>
      </>
    )
  }

  return (
    <>
      <div className="modal-body">
        <p className="xp-summary" title={projects.map((p) => p.name).join('\n')}>
          {projects.length > 4 ? `${projects.slice(0, 3).map((p) => p.name).join(', ')} and ${projects.length - 3} more` : projects.map((p) => p.name).join(', ')}
        </p>
        <div className="field-block">
          <span className="field-label">Formats</span>
          <div role="group" aria-label="Formats" className="pills pills-seg xp-formats">
            {[[OWN, 'Its own'], ...FORMATS.map(([f]) => [f, f]), ...SOUNDS.filter(([s]) => s !== 'mp3' || canMp3).map(([s, label]) => [s, label])].map(([f, label]) => (
              <button key={f} type="button" aria-pressed={formats.includes(f)} className={formats.includes(f) ? 'on' : ''} onClick={() => toggle(f)} title={f === OWN ? 'Each project in the format it’s made in' : undefined}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="field-block">
          <span className="field-label">Quality</span>
          <Pills label="Quality" variant="seg" items={QUALITY.map(([k, l]) => [k, l] as [string, string])} value={quality} onPick={setQuality} />
          <p className="hint">{QUALITY.find(([k]) => k === quality)?.[2]}</p>
        </div>
        <div className="field-block">
          <span className="field-label">Folder</span>
          <div className="folder-row">
            <input className="text-input" style={{ flex: 1 }} value={folder} onChange={(e) => setFolder(e.target.value)} spellCheck={false} aria-label="Folder" />
            <button type="button" className="button" onClick={() => void choose()}>
              Choose…
            </button>
          </div>
        </div>
        <div className="field-block">
          <span className="field-label">File names</span>
          <input className="text-input" value={pattern} onChange={(e) => setPattern(e.target.value)} spellCheck={false} aria-label="File names" />
          <p className="hint">{sample ? `Like ${sample}` : ''}</p>
        </div>
        <label className="check">
          <input type="checkbox" checked={openAfter} onChange={(e) => setOpenAfter(e.target.checked)} />
          Open the folder when they’re done
        </label>
      </div>
      <footer>
        <span className="footer-note" title="One project after another, each from its folder as saved (none is opened). Captions go in as each project shows them.">
          {total} {total === 1 ? 'file' : 'files'}, one project after another
        </span>
        <button type="button" className="button" onClick={close}>
          Cancel
        </button>
        <button type="button" className="button primary" disabled={!projects.length || !folder.trim() || !total || starting} onClick={() => void start()} data-autofocus>
          {projects.length === 1 ? 'Export' : `Export ${projects.length} projects`}
        </button>
      </footer>
    </>
  )
}
