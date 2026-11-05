// The Home page (the canvas's Home.dc.html): start a project in a format, or open one.
// File › Close project and the logo bring you here.

import type { DubJob } from '../shared/dub'
import { dubStatus } from './dub'
import type { TrJob } from '../shared/translate'
import { translationStatus } from './translate'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import type { ProjectInfo } from '../shared/api'
import { FORMATS } from './format'
import { openMenu } from './ContextMenu'
import { openCapcut } from './CapcutDialog'
import { askNewProject, fileUrl, forgetProject, freeProjectName, getState, newProject, openProjectAt, recentProjects, setState, toast, useStore } from './store'
import { useBoxSelect } from './boxSelect'
import { Slider } from './Slider'
import './project-dialogs.css'
import { startFromTemplate, TEMPLATE_CATEGORIES, TEMPLATES, type Template } from './templates'
import './home.css'

const WHERE: Record<string, string> = { '9:16': 'Reels, TikTok, Shorts', '4:5': 'Feed ads', '1:1': 'Square posts', '16:9': 'YouTube' }
const GLYPH: Record<string, [number, number]> = { '9:16': [18, 32], '4:5': [26, 32], '1:1': [30, 30], '16:9': [40, 23] }

/** How the projects are shown, kept between sessions: a list (thumbnail height) or a grid (cards per row). */
type HomeView = { view: 'list' | 'grid'; perRow: number; thumb: number }
const VIEW_KEY = 'studio.home.view'
const VIEW: HomeView = { view: 'list', perRow: 5, thumb: 52 }
function loadView(): HomeView {
  try {
    return { ...VIEW, ...JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') }
  } catch {
    return VIEW
  }
}
function keepView(v: HomeView) {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(v))
  } catch {}
  return v
}
const GRID_GAP = 16

const len = (us: number) => {
  const s = Math.round(us / 1e6)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
function ago(ms: number) {
  const m = Math.round((Date.now() - ms) / 60000)
  if (m < 1) return 'Just now'
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`
  const d = Math.round(h / 24)
  if (d === 1) return 'Yesterday'
  if (d < 7) return `${d} days ago`
  return new Date(ms).toLocaleDateString('sv-SE')
}
const formatOf = (p: ProjectInfo) => FORMATS.find(([, w, h]) => w === p.width && h === p.height)?.[0] ?? `${p.width}×${p.height}`

/** The headline as the tile shows it: the template's type at tile size (a sixth of 1080 wide). */
function sampleCss(t: Template): CSSProperties {
  const x = t.text
  return {
    fontFamily: `'${x.font ?? 'Bricolage Grotesque'}', sans-serif`,
    fontWeight: x.weight ?? 800,
    fontStyle: x.italic ? 'italic' : 'normal',
    fontSize: (x.size ?? 96) / 6,
    lineHeight: x.lineHeight ?? 1,
    letterSpacing: (x.letterSpacing ?? 0) / 6,
    color: x.color ?? '#FFFFFF',
    whiteSpace: 'pre',
  }
}

export function Home() {
  const current = useStore((s) => s.snap?.dir)
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'edited' | 'name'>('edited')
  const [over, setOver] = useState(false)
  const [cat, setCat] = useState('All')
  const [busy, setBusy] = useState<string | null>(null)
  const [view, setView] = useState(loadView)
  const setLook = (patch: Partial<HomeView>) => setView((v) => keepView({ ...v, ...patch }))
  const grid = view.view === 'grid'
  const useTemplate = async (t: Template) => {
    setBusy(t.name)
    try {
      await startFromTemplate(t)
      setState({ page: 'edit' })
    } catch (e) {
      toast(`Couldn't start “${t.name}”: ${(e as Error).message}`, 'error')
    }
    setBusy(null)
  }
  useEffect(() => {
    window.studio.app.projects(recentProjects()).then(setProjects)
  }, [])
  // Each project's dubs (running, waiting for picks, ready, stopped), kept up to date as they go.
  const [dubs, setDubs] = useState<Record<string, DubJob[]>>({})
  const norm = (d: string) => d.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
  useEffect(() => {
    if (!projects?.length) return
    window.studio.services.dubSummary(projects.map((p) => p.dir)).then((r) => setDubs(Object.fromEntries(Object.entries(r).map(([k, v]) => [norm(k), v]))))
    return window.studio.services.onDubJob((j) =>
      setDubs((d) => {
        const k = norm(j.project)
        return { ...d, [k]: [...(d[k] ?? []).filter((x) => x.id !== j.id && x.clipId !== j.clipId), j] }
      }),
    )
  }, [projects])
  // And their translations: as the project translated, or as a language's own copy.
  const [trs, setTrs] = useState<Record<string, TrJob[]>>({})
  useEffect(() => {
    if (!projects?.length) return
    window.studio.services.translateSummary(projects.map((p) => p.dir)).then((r) => setTrs(Object.fromEntries(Object.entries(r).map(([k, v]) => [norm(k), v]))))
    return window.studio.services.onTranslateJob((j) =>
      setTrs((d) => {
        const next = { ...d }
        for (const k of new Set([norm(j.source), norm(j.project)])) next[k] = [...(d[k] ?? []).filter((x) => x.id !== j.id), j]
        return next
      }),
    )
  }, [projects])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = (projects ?? []).filter((p) => !q || p.name.toLowerCase().includes(q))
    return sort === 'name' ? [...list].sort((a, b) => a.name.localeCompare(b.name, 'sv')) : list
  }, [projects, query, sort])

  // Each asks what to call the project first.
  const start = (aspect: string) => void askNewProject(aspect)
  const open = async (dir: string) => {
    if (dir !== current) await openProjectAt(dir)
    setState({ page: 'edit' })
  }
  const reload = () => window.studio.app.projects(recentProjects()).then(setProjects)

  // Picked projects: Ctrl+click, Shift+click, or a box dragged anywhere from the Projects
  // heading down (it holds on to what it passed while the page scrolls).
  const [picked, setPicked] = useState<string[]>([])
  const pickedShown = shown.filter((p) => picked.includes(p.dir))
  const anchorRef = useRef<string | null>(null)
  const homeRef = useRef<HTMLDivElement>(null)
  const projRef = useRef<HTMLElement>(null)
  const { box, start: startBox, drew } = useBoxSelect({
    scroller: homeRef,
    items: () => homeRef.current?.querySelectorAll<HTMLElement>('[data-project]') ?? [],
    idOf: (el) => el.dataset.project,
    onPick: setPicked,
    topInset: 48,
  })
  const onHomeDown = (e: React.PointerEvent) => {
    const el = homeRef.current
    const sec = projRef.current
    const t = e.target as HTMLElement
    if (e.button !== 0 || !el || !sec || e.clientY < sec.getBoundingClientRect().top) return
    // Not on a control, or on the page's scrollbar.
    if (t.closest('button, input, select, textarea, a, .home-tools, .modal-backdrop') || e.clientX >= el.getBoundingClientRect().left + el.clientWidth) return
    const add = e.shiftKey || e.ctrlKey || e.metaKey
    if (!add && !t.closest('[data-project]')) setPicked([])
    startBox(e, add ? picked : [])
  }
  // A click opens a project; Ctrl+click picks it or not, Shift+click picks the run from the last one.
  const clickProject = (e: React.MouseEvent, p: ProjectInfo) => {
    if (drew.current || renaming?.dir === p.dir) return
    if (e.shiftKey && anchorRef.current) {
      const dirs = shown.map((x) => x.dir)
      const [a, b] = [dirs.indexOf(anchorRef.current), dirs.indexOf(p.dir)]
      if (a >= 0 && b >= 0) return setPicked([...new Set([...picked, ...dirs.slice(Math.min(a, b), Math.max(a, b) + 1)])])
    }
    anchorRef.current = p.dir
    if (e.ctrlKey || e.metaKey) setPicked(picked.includes(p.dir) ? picked.filter((d) => d !== p.dir) : [...picked, p.dir])
    else open(p.dir)
  }

  // Right-click a project: open, rename, duplicate, show it, or delete it for good.
  const [renaming, setRenaming] = useState<{ dir: string; text: string } | null>(null)
  const [confirm, setConfirm] = useState<{ list: ProjectInfo[]; bytes: number; made: Record<string, number> } | null>(null)
  const askDelete = async (list: ProjectInfo[]) => {
    if (!list.length) return
    const sizes = await Promise.all(list.map((p) => window.studio.app.projectSize(p.dir)))
    const made: Record<string, number> = {}
    for (const s of sizes) for (const [k, n] of Object.entries(s?.made ?? {})) made[k] = (made[k] ?? 0) + n
    setConfirm({ list, bytes: sizes.reduce((a, s) => a + (s?.bytes ?? 0), 0), made })
  }
  const duplicate = async (list: ProjectInfo[]) => {
    for (const p of list) await window.studio.app.saveProjectAs(p.dir, `${p.name} copy`, false)
    reload()
  }
  const menuFor = (e: React.MouseEvent, p: ProjectInfo) => {
    e.preventDefault()
    // Right-click on one of several picked: for them all.
    if (picked.includes(p.dir) && pickedShown.length > 1) {
      const list = pickedShown
      openMenu(e.clientX, e.clientY, [
        { label: `Duplicate ${list.length} projects`, run: () => duplicate(list) },
        'sep',
        { label: `Delete ${list.length} projects…`, run: () => askDelete(list) },
      ])
      return
    }
    setPicked([p.dir])
    anchorRef.current = p.dir
    openMenu(e.clientX, e.clientY, [
      { label: 'Open', run: () => open(p.dir) },
      { label: 'Rename…', run: () => setRenaming({ dir: p.dir, text: p.name }) },
      { label: 'Duplicate', run: () => duplicate([p]) },
      { label: 'Show in folder', run: () => window.studio.app.showItem(p.dir) },
      'sep',
      { label: 'Delete…', run: () => askDelete([p]) },
    ])
  }
  const rename = async () => {
    if (!renaming) return
    const name = renaming.text.trim()
    setRenaming(null)
    if (!name) return
    await window.studio.app.renameProject(renaming.dir, name)
    // The open project is held by the engine: open it again so the new name sticks.
    if (renaming.dir === current) await openProjectAt(renaming.dir)
    reload()
  }
  const remove = async () => {
    if (!confirm) return
    const { list, bytes } = confirm
    setConfirm(null)
    setPicked([])
    const gone = new Set(list.map((p) => p.dir))
    const what = list.length === 1 ? `“${list[0].name}”` : `${list.length} projects`
    try {
      // The open project goes first: Studio moves to the next one (or a new one) before deleting.
      if (current && gone.has(current)) {
        const next = (projects ?? []).find((x) => !gone.has(x.dir))
        if (next) await openProjectAt(next.dir)
        else await newProject(freeProjectName([]), '9:16')
        setState({ page: 'home' })
      }
      let left = 0
      for (const p of list) {
        if (!(await window.studio.app.deleteProject(p.dir))) left++
        forgetProject(p.dir)
      }
      toast(!left ? `Deleted ${what} for good (${mb(bytes)} freed)` : `${what} ${list.length === 1 ? 'is' : 'are'} mostly gone; a file was still in use. Try again in a moment.`, left ? 'error' : 'info')
    } catch (e) {
      toast(`Couldn't delete ${what}: ${(e as Error).message}`, 'error')
    }
    reload()
  }

  // Keys on Home (before the editor's): Ctrl+A picks every project shown, Delete deletes the
  // picked ones (after asking), Enter opens the one picked, Escape lets go.
  const keysRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keysRef.current = (e: KeyboardEvent) => {
    const el = e.target instanceof HTMLElement ? e.target : null
    if ((el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) || getState().dialog || getState().menu || confirm) return
    const stop = () => {
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      stop()
      setPicked(shown.map((p) => p.dir))
    } else if (pickedShown.length && (e.key === 'Delete' || e.key === 'Backspace')) {
      stop()
      askDelete(pickedShown)
    } else if (pickedShown.length === 1 && e.key === 'Enter' && !el?.closest('button, [role="button"]')) {
      stop()
      open(pickedShown[0].dir)
    } else if (picked.length && e.key === 'Escape') {
      stop()
      setPicked([])
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keysRef.current(e)
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Grid cards bigger than the 360 px posters get a sharper still.
  const gridRef = useRef<HTMLDivElement>(null)
  const [gridW, setGridW] = useState(0)
  useEffect(() => {
    const el = gridRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setGridW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [grid, projects === null])
  const sharp = grid && (((gridW - GRID_GAP * (view.perRow - 1)) / view.perRow) * 16) / 9 * devicePixelRatio > 400

  /** The project's name, or the field renaming it. */
  const nameOf = (p: ProjectInfo) =>
    renaming?.dir === p.dir ? (
      <input
        className="home-rename"
        autoFocus
        value={renaming.text}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setRenaming({ ...renaming, text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') rename()
          if (e.key === 'Escape') setRenaming(null)
        }}
        onBlur={rename}
        spellCheck={false}
        aria-label="Project name"
      />
    ) : (
      <span className="title">{p.name}</span>
    )
  // Clips dropped anywhere on Home start a 9:16 project (once it's named) with them on the
  // timeline; "New project" lights up while they're over the page.
  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setOver(true)
  }
  const onDrop = async (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    setOver(false)
    await askNewProject('9:16', [...e.dataTransfer.files].map((f) => window.studio.app.pathForFile(f)).filter(Boolean))
  }

  return (
    <div
      className="home"
      ref={homeRef}
      onPointerDown={onHomeDown}
      onDragOver={onDragOver}
      onDragLeave={(e) => !homeRef.current?.contains(e.relatedTarget as Node | null) && setOver(false)}
      onDrop={onDrop}
    >
      <div className="home-bar">
        <div className="home-search">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <path d="M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10z M14 14l-3.5-3.5" />
          </svg>
          <input type="search" aria-label="Search projects" placeholder="Search projects" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
        </div>
      </div>
      <main className="home-wrap">
        <section aria-labelledby="create-h" className="home-section">
          <h1 id="create-h">Create a project</h1>
          <div className="home-create">
            <button
              type="button"
              className={`home-tile new${over ? ' over' : ''}`}
              onClick={() => start('9:16')}
            >
              <span className="home-plus" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                  <path d="M8 3v10 M3 8h10" />
                </svg>
              </span>
              <span className="home-tile-text">
                <span className="big">New project</span>
                <span className="sub">Drop clips here, or start empty</span>
              </span>
            </button>
            {FORMATS.map(([f]) => (
              <button key={f} type="button" className="home-tile" onClick={() => start(f)}>
                <span className="home-glyph" aria-hidden="true" style={{ width: GLYPH[f][0], height: GLYPH[f][1] }} />
                <span className="home-tile-text">
                  <span className="name">{f}</span>
                  <span className="sub">{WHERE[f]}</span>
                </span>
              </button>
            ))}
            <button type="button" className="home-tile" onClick={openCapcut} title="Make a Studio project from one of your CapCut projects">
              <span className="home-capcut" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 2.5v7 M5 6.5l3 3 3-3 M3 11v2.5h10V11" />
                </svg>
              </span>
              <span className="home-tile-text">
                <span className="name">From CapCut</span>
                <span className="sub">Import a CapCut project</span>
              </span>
            </button>
          </div>
        </section>

        <section aria-labelledby="tpl-h" className="home-section">
          <div className="home-head tpl">
            <h2 id="tpl-h">Templates</h2>
            <div className="home-cats" role="group" aria-label="Template categories">
              {TEMPLATE_CATEGORIES.map((c) => (
                <button key={c} type="button" className={c === cat ? 'on' : ''} aria-pressed={c === cat} onClick={() => setCat(c)}>
                  {c}
                </button>
              ))}
            </div>
          </div>
          <div className="home-tpl">
            {TEMPLATES.filter((t) => cat === 'All' || t.category === cat).map((t) => (
              <button key={t.name} type="button" className="home-tpl-item" onClick={() => useTemplate(t)} disabled={!!busy} title={`Start a 9:16 project with the “${t.name}” opening card`}>
                <span className="home-tpl-art" style={{ background: t.bg }}>
                  <svg width="100%" height="100%" viewBox="0 0 180 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
                    {t.shapes.map((s, i) => (
                      <path key={i} d={s.d} fill={s.fill} transform={`translate(${s.at[0]} ${s.at[1]}) scale(${s.at[2]}) rotate(${s.at[3]})`} />
                    ))}
                  </svg>
                  <span className="home-tpl-text">
                    <span style={sampleCss(t)}>{t.text.content}</span>
                  </span>
                  <span className="home-tpl-dur">{busy === t.name ? '…' : '0:03'}</span>
                </span>
                <span className="home-tile-text">
                  <span className="name">{t.name}</span>
                  <span className="sub">Opening card, then your clips</span>
                </span>
              </button>
            ))}
          </div>
        </section>

        <section aria-labelledby="proj-h" className="home-section" ref={projRef}>
          <div className="home-head">
            <h2 id="proj-h">Projects</h2>
            <div className="home-tools">
              {pickedShown.length > 0 && (
                <span className="home-picked" role="status">
                  {pickedShown.length} selected
                  <button type="button" className="home-sort" onClick={() => askDelete(pickedShown)}>
                    Delete…
                  </button>
                  <button type="button" className="home-sort" onClick={() => setPicked([])}>
                    Clear
                  </button>
                </span>
              )}
              <span className="home-size">
                {grid ? 'Per row' : 'Size'}
                {grid ? (
                  <Slider key="per-row" label="Projects per row" value={view.perRow} min={2} max={10} step={1} reset={VIEW.perRow} format={(v) => String(v)} onChange={(v) => setLook({ perRow: v })} onCommit={(v) => setLook({ perRow: v })} />
                ) : (
                  <Slider key="size" label="Thumbnail size" value={view.thumb} min={52} max={200} step={4} reset={VIEW.thumb} format={(v) => `${v} px`} onChange={(v) => setLook({ thumb: v })} onCommit={(v) => setLook({ thumb: v })} />
                )}
              </span>
              <span className="home-view" role="group" aria-label="Show projects as">
                <button type="button" className={grid ? '' : 'on'} aria-pressed={!grid} aria-label="List" title="List" onClick={() => setLook({ view: 'list' })}>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
                    <path d="M2.5 4h11 M2.5 8h11 M2.5 12h11" />
                  </svg>
                </button>
                <button type="button" className={grid ? 'on' : ''} aria-pressed={grid} aria-label="Grid" title="Grid" onClick={() => setLook({ view: 'grid' })}>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
                    <path d="M2.5 2.5h4.5v4.5H2.5z M9 2.5h4.5v4.5H9z M2.5 9h4.5v4.5H2.5z M9 9h4.5v4.5H9z" />
                  </svg>
                </button>
              </span>
              <button type="button" className="home-sort" onClick={() => setSort(sort === 'edited' ? 'name' : 'edited')} title="Change the order">
                {sort === 'edited' ? 'Last edited' : 'Name'}
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 6l4 4 4-4" />
                </svg>
              </button>
            </div>
          </div>
          {grid ? (
            projects === null || shown.length === 0 ? (
              <p className="home-note">{projects === null ? 'Loading…' : query ? 'No project matches that.' : 'No projects yet. Start one above.'}</p>
            ) : (
              <div className="home-grid" ref={gridRef} style={{ gridTemplateColumns: `repeat(${view.perRow}, minmax(0, 1fr))`, columnGap: GRID_GAP }}>
                {shown.map((p) => (
                  <div
                    key={p.dir}
                    data-project={p.dir}
                    role="button"
                    tabIndex={0}
                    aria-pressed={picked.includes(p.dir)}
                    className={`home-card${p.dir === current ? ' current' : ''}${picked.includes(p.dir) ? ' picked' : ''}`}
                    onClick={(e) => clickProject(e, p)}
                    onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && open(p.dir)}
                    onContextMenu={(e) => menuFor(e, p)}
                    title={p.dir}
                  >
                    <span className="home-card-art">
                      <ProjectPic p={p} sharp={sharp} />
                      <span className="home-tpl-dur">{len(p.durationUs)}</span>
                    </span>
                    <span className="home-card-text">
                      {nameOf(p)}
                      <span className="sub">
                        {formatOf(p)} · {p.clips} {p.clips === 1 ? 'clip' : 'clips'} · {p.dir === current ? 'open now' : ago(p.modified)}
                      </span>
                      <DubLine status={dubStatus(dubs[norm(p.dir)])} />
                      <DubLine status={translationStatus(p.dir, trs[norm(p.dir)])} />
                    </span>
                  </div>
                ))}
              </div>
            )
          ) : (
            <div className="home-table-wrap">
              <table className="home-table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Made by</th>
                    <th scope="col" className="w90">Format</th>
                    <th scope="col" className="w90">Length</th>
                    <th scope="col" className="w140">Edited</th>
                  </tr>
                </thead>
                <tbody>
                  {projects === null && (
                    <tr>
                      <td colSpan={5} className="home-note">
                        Loading…
                      </td>
                    </tr>
                  )}
                  {projects !== null && shown.length === 0 && (
                    <tr>
                      <td colSpan={5} className="home-note">
                        {query ? 'No project matches that.' : 'No projects yet. Start one above.'}
                      </td>
                    </tr>
                  )}
                  {shown.map((p) => {
                    const w = Math.round((view.thumb * p.width) / p.height)
                    return (
                      <tr
                        key={p.dir}
                        data-project={p.dir}
                        aria-selected={picked.includes(p.dir)}
                        className={`home-row${p.dir === current ? ' current' : ''}${picked.includes(p.dir) ? ' picked' : ''}`}
                        style={{ height: Math.max(64, view.thumb + 12) }}
                        onClick={(e) => clickProject(e, p)}
                        onContextMenu={(e) => menuFor(e, p)}
                        title={p.dir}
                      >
                        <td>
                          <span className="home-name">
                            {p.poster ? <img src={fileUrl(p.poster)} alt="" draggable={false} style={{ width: w, height: view.thumb, flexBasis: w }} /> : <span className="home-poster" style={{ width: w, height: view.thumb, flexBasis: w }} />}
                            <span>
                              {nameOf(p)}
                              <span className="sub">
                                {p.clips} {p.clips === 1 ? 'clip' : 'clips'}
                                {p.dir === current ? ' · open now' : ''}
                              </span>
                              <DubLine status={dubStatus(dubs[norm(p.dir)])} />
                              <DubLine status={translationStatus(p.dir, trs[norm(p.dir)])} />
                            </span>
                          </span>
                        </td>
                        <td className="dim">
                          <span className="home-by">
                            {p.byAgent && (
                              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#A9B6FF" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M5 2v3 M11 2v3 M3.5 5h9v2.5a4.5 4.5 0 0 1-9 0z M8 12v2.5" />
                              </svg>
                            )}
                            {p.byAgent ? (p.byYou ? 'Claude, via MCP · edited by you' : 'Claude, via MCP') : 'You'}
                          </span>
                        </td>
                        <td className="mono">{formatOf(p)}</td>
                        <td className="mono">{len(p.durationUs)}</td>
                        <td className="dim">{ago(p.modified)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
      {box && <div className="home-box" style={box} />}
      {confirm && (
        <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setConfirm(null)}>
          <div className="pd" role="alertdialog" aria-modal="true" aria-label="Delete the project">
            <div className="pd-head">
              <h2>{confirm.list.length === 1 ? `Delete “${confirm.list[0].name}” for good?` : `Delete ${confirm.list.length} projects for good?`}</h2>
            </div>
            <div className="pd-body">
              <p className="pd-text">
                {confirm.list.length === 1 ? 'This removes the project from this computer: its edit, history and caches' : 'This removes them from this computer: their edits, histories and caches'} ({mb(confirm.bytes)}).
                {madeText(confirm.made) && ` It also deletes ${madeText(confirm.made)} made in Studio.`} Your own media files stay where they are.
              </p>
              <p className="pd-note">It can't be undone.</p>
            </div>
            <div className="pd-foot">
              <span className="pd-note" />
              <button type="button" className="pd-btn" onClick={() => setConfirm(null)} autoFocus>
                Keep it
              </button>
              <button type="button" className="pd-btn danger" onClick={remove}>
                Delete for good
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const mb = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`)
const MADE: Record<string, string> = { voiceovers: 'voiceover', recordings: 'recording', compounds: 'compound clip', freeze: 'freeze frame', edits: 'edited sound', text: 'text drawing', captions: 'caption file', mattes: 'background matte' }
/** "3 voiceovers and 2 recordings": what Studio made inside the project, by kind. */
function madeText(made: Record<string, number>) {
  const parts = Object.entries(made)
    .filter(([k, n]) => MADE[k] && n > 0)
    .map(([k, n]) => `${n} ${MADE[k]}${n === 1 ? '' : 's'}`)
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? '')
}

/** Sharper stills asked for this session, by project and poster (a new first clip is a new poster). */
const stills = new Map<string, Promise<string | null>>()
function stillFor(p: ProjectInfo) {
  const key = `${p.dir}|${p.poster}`
  let s = stills.get(key)
  if (!s) stills.set(key, (s = window.studio.app.projectStill(p.dir).catch(() => null)))
  return s
}

/** A grid card's picture in the project's own format; big cards swap the 360 px poster for a sharper still. */
function ProjectPic({ p, sharp }: { p: ProjectInfo; sharp: boolean }) {
  const [still, setStill] = useState<string | null>(null)
  useEffect(() => {
    if (!sharp || !p.poster) return
    let live = true
    stillFor(p).then((s) => live && setStill(s))
    return () => {
      live = false
    }
  }, [sharp, p.dir, p.poster])
  const src = sharp && still ? still : p.poster
  return <span className="home-card-pic" style={{ aspectRatio: `${p.width} / ${p.height}` }}>{src && <img src={fileUrl(src)} alt="" draggable={false} />}</span>
}

/** A project's dub, under its name: a spinner while it runs, or what it's waiting for. */
function DubLine({ status }: { status: ReturnType<typeof dubStatus> }) {
  if (!status) return null
  return (
    <span className={`home-dub ${status.tone}`} title={status.text}>
      {status.tone === 'busy' && <span className="busy-spin" aria-hidden="true" />}
      {status.text}
    </span>
  )
}
