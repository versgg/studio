// Import from CapCut (Home's tile, File › Import from CapCut…): CapCut's projects as CapCut
// lists them, each with its cover, then the one picked built as a new Studio project behind
// this window, then what came over. It sits outside the store's `dialog`, which a new project
// clears, so it stays up while the import makes one.

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { CcDraft } from '../shared/capcut'
import { importCapcut, listCapcut, type ImportReport } from './capcutImport'
import { fileUrl, setState, toast } from './store'
import './project-dialogs.css'
import './capcut-dialog.css'

type Phase =
  | { at: 'closed' }
  | { at: 'pick' }
  | { at: 'importing'; draft: CcDraft; stage: string; fraction: number }
  | { at: 'done'; draft: CcDraft; report: ImportReport }
  | { at: 'failed'; draft: CcDraft; error: string; made: boolean }

let phase: Phase = { at: 'closed' }
const subs = new Set<() => void>()
const set = (p: Phase) => {
  phase = p
  subs.forEach((f) => f())
}
const subscribe = (f: () => void) => {
  subs.add(f)
  return () => subs.delete(f)
}

/** Opens the list of CapCut's projects (does nothing while one is being imported). */
export function openCapcut() {
  if (phase.at !== 'importing') set({ at: 'pick' })
}
const close = () => {
  if (phase.at !== 'importing') set({ at: 'closed' })
}

// Which CapCut projects were brought in before, and when (this computer only).
const SEEN_KEY = 'studio.capcutImported'
function imported(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}')
  } catch {
    return {}
  }
}
function markImported(dir: string) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify({ ...imported(), [dir]: Date.now() }))
  } catch {}
}

async function run(draft: CcDraft) {
  set({ at: 'importing', draft, stage: 'Starting', fraction: 0 })
  try {
    const report = await importCapcut(draft, (stage, fraction) => phase.at === 'importing' && set({ ...phase, stage, fraction }))
    markImported(draft.dir)
    setState({ page: 'edit' })
    set({ at: 'done', draft, report })
  } catch (e) {
    // Past "Making the project", what was built so far is the open project.
    const made = phase.at === 'importing' && phase.fraction > 0.02
    set({ at: 'failed', draft, error: (e as Error).message, made })
  }
}

const mb = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`)
const len = (us: number) => {
  const s = Math.round(us / 1e6)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const day = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function CapcutDialog() {
  const p = useSyncExternalStore(subscribe, () => phase)
  useEffect(() => {
    if (p.at === 'closed') return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [p.at])
  if (p.at === 'closed') return null
  const busy = p.at === 'importing'
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className={`pd cc-dialog${p.at === 'pick' ? ' cc-wide' : ''}`} role="dialog" aria-modal="true" aria-label="Import from CapCut">
        <div className="pd-head">
          <h2>{p.at === 'done' ? 'Imported from CapCut' : p.at === 'failed' ? 'Couldn’t import it' : 'Import from CapCut'}</h2>
          {!busy && (
            <button type="button" className="pd-x" aria-label="Close" onClick={close}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                <path d="M3.5 3.5l9 9 M12.5 3.5l-9 9" />
              </svg>
            </button>
          )}
        </div>
        {p.at === 'pick' && <Picker />}
        {p.at === 'importing' && <Importing draft={p.draft} stage={p.stage} fraction={p.fraction} />}
        {p.at === 'done' && <Done draft={p.draft} report={p.report} />}
        {p.at === 'failed' && <Failed draft={p.draft} error={p.error} made={p.made} />}
      </div>
    </div>
  )
}

function Cover({ draft, className = '' }: { draft: CcDraft; className?: string }) {
  const [wide, setWide] = useState(false)
  return (
    <span className={`cc-cover ${className}`}>
      {draft.cover ? (
        <img src={fileUrl(draft.cover)} alt="" draggable={false} className={wide ? 'wide' : ''} onLoad={(e) => setWide(e.currentTarget.naturalWidth > e.currentTarget.naturalHeight)} />
      ) : (
        <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
          <path d="M2.5 3.5h11v9h-11z M6.5 6v4l3.5-2z" />
        </svg>
      )}
    </span>
  )
}

function Picker() {
  const [drafts, setDrafts] = useState<CcDraft[] | null>(null)
  const [error, setError] = useState('')
  const [root, setRoot] = useState('')
  const [query, setQuery] = useState('')
  const seen = useMemo(imported, [])
  const load = () => {
    setDrafts(null)
    setError('')
    window.studio.services.capcutRoot().then(setRoot)
    listCapcut().then((r) => ('error' in r ? setError(r.error) : setDrafts(r)))
  }
  useEffect(load, [])
  // CapCut's projects can be anywhere (on Linux there's no CapCut, only a copy of its projects).
  const choose = async () => {
    const dir = await window.studio.app.chooseFolder(root || undefined, 'Where are your CapCut projects?')
    if (!dir) return
    const r = await window.studio.services.capcutSetRoot(dir)
    if (typeof r !== 'string') return toast(r.error, 'error')
    load()
  }
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (drafts ?? []).filter((d) => !q || d.name.toLowerCase().includes(q))
  }, [drafts, query])
  return (
    <>
      <div className="cc-bar">
        <span className="pd-note">{drafts ? `${plural(drafts.length, 'project')} in CapCut, newest first. Pick one to make it a Studio project; CapCut's own stays as it is.` : ''}</span>
        <button type="button" className="pd-btn" onClick={choose} title={root ? `Looking in ${root}` : undefined}>
          Folder…
        </button>
        <input className="pd-input cc-search" type="search" placeholder="Search" aria-label="Search CapCut projects" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} autoFocus />
      </div>
      <div className="pd-body cc-body">
        {error && <p className="pd-text">{error}</p>}
        {!error && drafts === null && <p className="pd-note">Looking for CapCut’s projects…</p>}
        {drafts?.length === 0 && (
          <div className="cc-empty">
            <p className="pd-text">
              {root
                ? `No CapCut projects in ${root}, where CapCut keeps them on this computer. If they’re somewhere else, choose that folder, or a copy of CapCut’s projects.`
                : 'CapCut isn’t made for this system, so there’s no CapCut folder here. Choose a copy of CapCut’s projects folder.'}
            </p>
            <button type="button" className="pd-btn primary" onClick={choose}>
              Choose folder…
            </button>
          </div>
        )}
        {drafts !== null && drafts.length > 0 && shown.length === 0 && <p className="pd-note">No project matches that.</p>}
        <div className="cc-grid">
          {shown.map((d) => (
            <button
              key={d.dir}
              type="button"
              className="cc-card"
              disabled={!d.readable}
              onClick={() => run(d)}
              title={d.readable ? `${d.name}\nEdited ${new Date(d.modified).toLocaleString('en-GB')}` : 'This project is saved locked (newer CapCut versions encrypt their projects), so Studio can’t read it.'}
            >
              <span className="cc-thumb">
                <Cover draft={d} />
                {d.durationUs > 0 && <span className="cc-dur">{len(d.durationUs)}</span>}
                {seen[d.dir] && <span className="cc-tag">Imported {day(seen[d.dir])}</span>}
              </span>
              <span className="cc-name">{d.name}</span>
              <span className="cc-sub">{d.readable ? `${mb(d.bytes)} · ${day(d.modified)}` : 'Saved locked'}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  )
}

function Importing({ draft, stage, fraction }: { draft: CcDraft; stage: string; fraction: number }) {
  const pct = Math.round(fraction * 100)
  return (
    <>
      <div className="pd-body">
        <div className="cc-head">
          <Cover draft={draft} className="small" />
          <div className="cc-head-text">
            <strong>{draft.name}</strong>
            <span className="cc-stage">{stage}</span>
            <div className="cc-bar-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
              <div style={{ width: `${pct}%` }} />
            </div>
            <span className="cc-pct">{pct} %</span>
          </div>
        </div>
      </div>
      <div className="pd-foot">
        <span className="pd-note">It’s being built on the timeline behind this window.</span>
      </div>
    </>
  )
}

function Done({ draft, report }: { draft: CcDraft; report: ImportReport }) {
  const counts = [
    [report.clips, 'clip'],
    [report.captions, 'caption line'],
    [report.texts, 'text'],
    [report.sounds, 'sound'],
    [report.stickers, 'sticker'],
    [report.filters, 'filter'],
  ].filter(([n]) => (n as number) > 0) as [number, string][]
  return (
    <>
      <div className="pd-body">
        <div className="cc-head">
          <Cover draft={draft} className="small" />
          <div className="cc-head-text">
            <strong>{report.name}</strong>
            <span className="cc-stage">{counts.map(([n, w]) => plural(n, w)).join(' · ') || 'An empty project'}</span>
            <span className="pd-note">Open on the timeline now, and listed on Home.</span>
          </div>
        </div>
        {report.notes.length > 0 && (
          <div className="cc-section">
            <h3>Came over differently</h3>
            <ul className="cc-list">
              {report.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </div>
        )}
        {report.missing.length > 0 && (
          <div className="cc-section">
            <h3>Not on this computer any more</h3>
            <ul className="cc-list mono">
              {report.missing.map((m) => (
                <li key={m} title={m}>
                  {m}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="pd-foot">
        <span className="pd-note" />
        <button type="button" className="pd-btn" onClick={() => set({ at: 'pick' })}>
          Import another
        </button>
        <button type="button" className="pd-btn primary" onClick={close} autoFocus>
          Done
        </button>
      </div>
    </>
  )
}

function Failed({ draft, error, made }: { draft: CcDraft; error: string; made: boolean }) {
  return (
    <>
      <div className="pd-body">
        <div className="cc-head">
          <Cover draft={draft} className="small" />
          <div className="cc-head-text">
            <strong>{draft.name}</strong>
            <span className="pd-text">{error}</span>
            {made && <span className="pd-note">What was built before it stopped is open on the timeline.</span>}
          </div>
        </div>
      </div>
      <div className="pd-foot">
        <span className="pd-note" />
        <button type="button" className="pd-btn" onClick={() => set({ at: 'pick' })}>
          Back to the list
        </button>
        <button type="button" className="pd-btn primary" onClick={close} autoFocus>
          Close
        </button>
      </div>
    </>
  )
}
