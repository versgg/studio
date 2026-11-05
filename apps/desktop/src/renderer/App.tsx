import { Mark } from '@studio/ui/Mark'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { EngineStatus } from '../shared/api'
import { AudioPage } from './AudioPage'
import { ContextMenu } from './ContextMenu'
import { Dialogs, Toasts } from './dialogs'
import { CapcutDialog } from './CapcutDialog'
import { Home } from './Home'
import { hideAreas } from './layout-areas'
import { ApprovalPrompt } from './ProjectDialogs'
import { InspectorPanel } from './Inspector'
import { LibraryPanel } from './Library'
import { MenuBar } from './Menus'
import { PlayerPanel } from './Player'
import { installShortcuts } from './shortcuts'
import { call, closeProject, importPaths, setLayout, setState, startStore, useStore, type Layout } from './store'
import { initDub } from './dub'
import { MEDIA_MIME } from './LibraryBlocks'
import { TEXT_MIME } from './LibraryTabs'
import { initTranslate } from './translate'
import { initCapcut } from './capcutImport'
import { TimelinePanel } from './Timeline'

/** The arrangements from the canvas (Main.dc.html and Workspaces.dc.html). */
const LAYOUTS: Record<Layout, { name: string; keys: string; areas: string; glyphCols: string; left: number; right: number; top: number }> = {
  ads: { name: 'Ads', keys: 'Alt+1', areas: '"lib insp player" "tl tl player"', glyphCols: '1fr 1fr 1fr', left: 480, right: 480, top: 470 / 860 },
  standard: { name: 'Standard', keys: 'Alt+2', areas: '"lib player insp" "tl tl tl"', glyphCols: '1fr 1.4fr 0.8fr', left: 480, right: 320, top: 500 / 860 },
  review: { name: 'Review', keys: 'Alt+3', areas: '"player player insp" "lib tl tl"', glyphCols: '1fr 1fr 0.8fr', left: 480, right: 320, top: 0.65 },
}
const ASPECT_NAMES: [string, number, number][] = [
  ['9:16', 1080, 1920],
  ['4:5', 1080, 1350],
  ['1:1', 1080, 1080],
  ['16:9', 1920, 1080],
]

interface Sizes {
  left: number
  right: number
  top: number
}
const sizesKey = (l: Layout) => `studio.sizes.v1.${l}`
function loadSizes(l: Layout): Sizes {
  const d = LAYOUTS[l]
  try {
    return { left: d.left, right: d.right, top: d.top, ...JSON.parse(localStorage.getItem(sizesKey(l)) ?? '{}') }
  } catch {
    return { left: d.left, right: d.right, top: d.top }
  }
}

/** Minimise, maximise/restore and close, drawn in the app's own style. */
function WindowControls() {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    window.studio.window.isMaximized().then(setMaximized)
    return window.studio.window.onMaximized(setMaximized)
  }, [])
  const glyph = (d: string) => (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true" shapeRendering="crispEdges">
      <path d={d} />
    </svg>
  )
  return (
    <div className="win-controls">
      <button type="button" className="win-btn" title="Minimise" aria-label="Minimise" onClick={() => window.studio.window.minimize()}>
        {glyph('M0 5.5h10')}
      </button>
      <button type="button" className="win-btn" title={maximized ? 'Restore' : 'Maximise'} aria-label={maximized ? 'Restore' : 'Maximise'} onClick={() => window.studio.window.toggleMaximize()}>
        {maximized ? glyph('M2.5 2.5V.5h7v7h-2 M.5 2.5h7v7h-7z') : glyph('M.5.5h9v9h-9z')}
      </button>
      <button type="button" className="win-btn close" title="Close" aria-label="Close" onClick={() => window.studio.window.close()}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
          <path d="M.5.5l9 9 M9.5.5l-9 9" />
        </svg>
      </button>
    </div>
  )
}

function engineTone(s: EngineStatus): { tone: 'ok' | 'warn' | 'bad'; text: string } {
  if (s.process?.state === 'failed') return { tone: 'bad', text: s.process.error ?? 'The engine failed' }
  if (s.link === 'connected') return { tone: 'ok', text: 'The engine is running. The MCP server will live in it (step 4 of the plan); it isn’t built yet.' }
  if (s.process?.state === 'restarting') return { tone: 'warn', text: 'The engine is restarting…' }
  return { tone: 'warn', text: 'Connecting to the engine…' }
}

/** The editor: four panels in the layout's grid, with draggable gaps. */
function EditorGrid() {
  const layout = useStore((s) => s.layout)
  const fullPlayer = useStore((s) => s.fullPlayer)
  const locked = useStore((s) => s.layoutLocked)
  const hidden = useStore((s) => s.hiddenPanels)
  const tick = useStore((s) => s.workspaceTick)
  const [sizes, setSizes] = useState<Sizes>(() => loadSizes(layout))
  // Sizes belong to a layout: switching (or applying a saved workspace) loads that layout's.
  const [sizesFor, setSizesFor] = useState(`${layout}:${tick}`)
  if (sizesFor !== `${layout}:${tick}`) {
    setSizesFor(`${layout}:${tick}`)
    setSizes(loadSizes(layout))
  }
  const persist = (next: Sizes) => {
    try {
      localStorage.setItem(sizesKey(layout), JSON.stringify(next))
    } catch {}
  }
  const [box, setBox] = useState({ w: 1200, h: 800 })
  const [dragging, setDragging] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const def = LAYOUTS[layout]

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const sizesRef = useRef(sizes)
  sizesRef.current = sizes

  const left = Math.min(sizes.left, box.w * 0.45)
  const right = Math.min(sizes.right, box.w * 0.45)
  const topPx = Math.round(box.h * sizes.top)
  const cols = layout === 'review' ? `minmax(0, 1fr) minmax(0, 1fr) ${right}px` : `${left}px minmax(0, 1fr) ${right}px`
  const areas = hidden.length ? hideAreas(def.areas, hidden) : def.areas
  const shown = (p: string) => areas.includes(p)
  const style = { gridTemplateColumns: cols, gridTemplateRows: `${topPx}px minmax(0, 1fr)`, gridTemplateAreas: areas }

  // Dragging a gap: the side columns' widths and the top row's share of the height.
  const drag = (which: 'left' | 'right' | 'top') => (e: React.PointerEvent) => {
    e.preventDefault()
    const el = ref.current!
    const r = el.getBoundingClientRect()
    setDragging(which)
    const move = (ev: PointerEvent) => {
      setSizes((s) => {
        if (which === 'left') return { ...s, left: Math.max(260, Math.min(r.width * 0.45, ev.clientX - r.left)) }
        if (which === 'right') return { ...s, right: Math.max(260, Math.min(r.width * 0.45, r.right - ev.clientX)) }
        return { ...s, top: Math.max(0.25, Math.min(0.8, (ev.clientY - r.top) / r.height)) }
      })
    }
    const up = () => {
      setDragging(null)
      persist(sizesRef.current)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  // Where the gaps are, per layout (some panels span two cells).
  const gutters: { key: 'left' | 'right' | 'top'; kind: 'col' | 'row'; style: React.CSSProperties }[] =
    layout === 'ads'
      ? [
          { key: 'left', kind: 'col', style: { left: left, top: 0, height: topPx } },
          { key: 'right', kind: 'col', style: { left: box.w - right, top: 0, bottom: 0 } },
          { key: 'top', kind: 'row', style: { top: topPx, left: 0, width: box.w - right } },
        ]
      : layout === 'standard'
        ? [
            { key: 'left', kind: 'col', style: { left: left, top: 0, height: topPx } },
            { key: 'right', kind: 'col', style: { left: box.w - right, top: 0, height: topPx } },
            { key: 'top', kind: 'row', style: { top: topPx, left: 0, right: 0 } },
          ]
        : [
            { key: 'right', kind: 'col', style: { left: box.w - right, top: 0, height: topPx } },
            { key: 'top', kind: 'row', style: { top: topPx, left: 0, right: 0 } },
          ]

  return (
    <main className="editor-grid" ref={ref} style={style}>
      {shown('lib') && (
        <div className="area area-lib" style={{ gridArea: 'lib' }}>
          <LibraryPanel />
        </div>
      )}
      {shown('insp') && (
        <div className="area area-insp" style={{ gridArea: 'insp' }}>
          <InspectorPanel />
        </div>
      )}
      {(shown('player') || fullPlayer) && (
        <section className={`area area-player${fullPlayer ? ' full-player' : ''}`} style={{ gridArea: shown('player') ? 'player' : undefined }} aria-label="Player">
          <PlayerPanel />
        </section>
      )}
      {shown('tl') && (
        <section className="area area-tl" style={{ gridArea: 'tl' }} aria-label="Timeline">
          <TimelinePanel />
        </section>
      )}
      {/* With panels hidden, only the gap above the timeline still means the same thing. */}
      {!locked &&
        gutters
          .filter((g) => !hidden.length || (g.key === 'top' && shown('tl')))
          .map((g) => (
            <div
              key={g.key}
              className={`gutter ${g.kind}${dragging === g.key ? ' dragging' : ''}`}
              style={g.style}
              onPointerDown={drag(g.key)}
              onDoubleClick={() => {
                const reset = { left: def.left, right: def.right, top: def.top }
                setSizes(reset)
                persist(reset)
              }}
              title="Drag to resize; double-click to reset"
            />
          ))}
    </main>
  )
}

export function App() {
  const [engine, setEngine] = useState<EngineStatus>({ link: 'connecting' })
  const project = useStore((s) => s.snap?.project)
  const page = useStore((s) => s.page)
  const layout = useStore((s) => s.layout)
  const exporting = useStore((s) => s.exports).filter((j) => j.state === 'running' || j.state === 'queued')
  const tasks = useStore((s) => s.tasks)
  const task = tasks.find((t) => t.state === 'running') ?? tasks[tasks.length - 1]

  useEffect(() => {
    startStore()
    initDub()
    initTranslate()
    initCapcut()
    return installShortcuts()
  }, [])
  useEffect(() => window.studio.engine.onStatus(setEngine), [])
  // The taskbar shows the window title, now that there's no title bar to show it.
  useEffect(() => {
    document.title = project ? `${project.name} – Studio` : 'Studio'
  }, [project?.name])

  // Files and folders dropped where no panel takes them itself (the player, the Inspector, the
  // tab bars, the Audio page) go into the library. The library, the timeline and the Audio tab
  // handle their own drops and say so with preventDefault; Home starts a project. The title bar
  // moves the window, so Chromium never hands drags over it to the page.
  const [fileDrag, setFileDrag] = useState(false)
  const dragGone = useRef(0)
  const takesFiles = (e: React.DragEvent) => page !== 'home' && !!project && e.dataTransfer.types.includes('Files')
  const onFileDragOver = (e: React.DragEvent) => {
    if (!takesFiles(e)) return
    // Drag events stop when the pointer leaves the window, so the hint goes when they do.
    window.clearTimeout(dragGone.current)
    dragGone.current = window.setTimeout(() => setFileDrag(false), 250)
    if (e.isDefaultPrevented()) return setFileDrag(false)
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setFileDrag(true)
  }
  // Drags of files and of Studio's own clips and text are let in wherever they enter an element;
  // each dragover still says whether they may drop. Blink answers a move into a new element with
  // its dragenter alone, and on Wayland the last move before letting go decides the drop, so files
  // let go just past an edge (text, an icon) were cancelled. Windows asks again while the pointer
  // rests, which hid it.
  const onDragEnter = (e: React.DragEvent) => {
    const types = e.dataTransfer.types
    if (types.includes('Files') || types.includes(MEDIA_MIME) || types.includes(TEXT_MIME)) e.preventDefault()
  }
  const onFileDrop = (e: React.DragEvent) => {
    setFileDrag(false)
    if (!takesFiles(e) || e.isDefaultPrevented()) return
    e.preventDefault()
    void importPaths([...e.dataTransfer.files].map((f) => window.studio.app.pathForFile(f)).filter(Boolean))
  }

  const status = engineTone(engine)
  const aspect = project && ASPECT_NAMES.find(([, w, h]) => w === project.width && h === project.height)?.[0]
  const progress = exporting.length ? exporting.reduce((a, j) => a + j.fraction, 0) / exporting.length : 0
  return (
    <div className="studio-root" onDragEnter={onDragEnter} onDragOver={onFileDragOver} onDrop={onFileDrop}>
      <header className="titlebar">
        <button type="button" className="titlebar-mark" aria-label="Home" title="Home: your projects" onClick={() => void closeProject()}>
          <Mark />
        </button>
        <MenuBar />
        <div className="titlebar-center">
          {project && (
            <>
              <ProjectName name={project.name} />
              <span className="project-meta">
                {aspect ? `${aspect} · ` : ''}
                {project.width} × {project.height} · {project.fps} fps
              </span>
            </>
          )}
        </div>
        {task && (
          <span className={`task-pill state-${task.state}`} title={task.error ?? `${task.label}: ${task.stage}`}>
            <span className="task-bar" style={{ width: `${Math.round(task.fraction * 100)}%` }} />
            {task.state === 'failed' ? 'Failed: ' : ''}
            {task.label} · {task.state === 'running' ? `${Math.round(task.fraction * 100)} %` : task.stage}
          </span>
        )}
        {exporting.length > 0 && (
          <button type="button" className="export-pill" onClick={() => setState({ dialog: 'export' })}>
            Exporting {Math.round(progress * 100)} %
          </button>
        )}
        <div className="layouts" role="group" aria-label="Layout">
          {(['ads', 'standard'] as Layout[]).map((l) => (
            <button key={l} type="button" className={`layout-button${page === 'edit' && layout === l ? ' on' : ''}`} aria-label={`${LAYOUTS[l].name} layout`} title={`${LAYOUTS[l].name} layout  ${LAYOUTS[l].keys}`} aria-pressed={page === 'edit' && layout === l} onClick={() => setLayout(l)}>
              <span className="layout-glyph" aria-hidden="true" style={{ gridTemplateColumns: LAYOUTS[l].glyphCols, gridTemplateAreas: LAYOUTS[l].areas }}>
                <span />
              </span>
            </button>
          ))}
        </div>
        <div className="page-switch" role="group" aria-label="Page">
          <button type="button" className={page === 'edit' ? 'on' : ''} aria-pressed={page === 'edit'} onClick={() => setState({ page: 'edit' })}>
            Edit
          </button>
          <button type="button" className={page === 'audio' ? 'on' : ''} aria-pressed={page === 'audio'} onClick={() => setState({ page: 'audio' })}>
            Audio
          </button>
        </div>
        <button type="button" className={`mcp-button tone-${status.tone}`} title={status.text}>
          <span className="dot" aria-hidden="true" />
          MCP
        </button>
        <button type="button" className="export-button" onClick={() => setState({ dialog: 'export' })} disabled={!project}>
          Export
        </button>
        {window.studio.platform !== 'darwin' && <WindowControls />}
      </header>
      {page === 'audio' ? <AudioPage /> : page === 'home' ? <Home /> : <EditorGrid />}
      {fileDrag && (
        <div className="window-drop" aria-hidden="true">
          <span>Drop to add to the library</span>
        </div>
      )}
      <Dialogs />
      <CapcutDialog />
      <ApprovalPrompt />
      <ContextMenu />
      <Toasts />
    </div>
  )
}

/**
 * The project's name in the title bar. Double-click it to type a new one, as in CapCut: Enter or
 * clicking away keeps it, Esc leaves it as it was. Saved with the project, not an undo step.
 */
function ProjectName({ name }: { name: string }) {
  const [text, setText] = useState<string | null>(null)
  const open = useRef(false)
  const field = useRef<HTMLInputElement>(null)
  // The whole name selected to type over (not left to the focus event, which waits for the window's focus).
  const editing = text !== null
  useLayoutEffect(() => {
    if (editing) field.current?.select()
  }, [editing])
  const finish = (keep: boolean) => {
    if (!open.current) return
    open.current = false
    const next = text?.trim()
    setText(null)
    if (keep && next && next !== name) void call('project.setOptions', { name: next })
  }
  if (text === null)
    return (
      <span
        className="project-name"
        title="Double-click to rename"
        onDoubleClick={() => {
          open.current = true
          setText(name)
        }}
      >
        {name}
      </span>
    )
  return (
    <input
      ref={field}
      className="project-name-edit"
      autoFocus
      value={text}
      maxLength={120}
      size={Math.max(12, text.length + 2)}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(true)
        if (e.key === 'Escape') finish(false)
      }}
      onBlur={() => finish(true)}
      spellCheck={false}
      aria-label="Project name"
    />
  )
}
