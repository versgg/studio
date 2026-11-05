// The title bar's menus, as drawn on the canvas (Menu.dc.html): the same items, order,
// keys, check marks and submenus. Each item does the real thing where Studio can; the few
// that aren't built yet say so.

import { useEffect, useRef, useState } from 'react'
import { timelineApi } from './Timeline'
import {
  askNewProject,
  closeProject,
  clearRecent,
  copy,
  cut,
  deleteSelection,
  duplicate,
  getState,
  importDialog,
  importFolderDialog,
  openProjectAt,
  openProjectDialog,
  paste,
  pasteAttributes,
  recentProjects,
  redo,
  selectAfterPlayhead,
  selectAll,
  setLayout,
  setState,
  splitAtPlayhead,
  toast,
  toggleLayoutLock,
  togglePanel,
  applyWorkspace,
  workspaces,
  undo,
  useStore,
  type State,
} from './store'
import { basename } from './format'
import { ACTIONS, keysFor } from './keymap'
import { setUi } from './ui-state'
import { openCapcut } from './CapcutDialog'

// Menu items whose keys come from the keymap (and so follow presets and your changes).
const ACTION_IDS = new Set(ACTIONS.map((a) => a.id))

interface Item {
  id: string
  label: string
  keys?: string
  run?: () => unknown
  sub?: string
  checked?: (s: State) => boolean
  enabled?: (s: State) => boolean
}
type Entry = Item | 'sep'

/** The library's History tab, on the Edit page. */
const showHistory = () => {
  setState({ page: 'edit' })
  setUi('lib.cat', 'history')
}
const hasClips = (s: State) => !!s.snap?.durationUs
const hasSel = (s: State) => s.selection.length > 0

function menus(): Record<string, [string, Entry[]]> {
  return {
    file: [
      'File',
      [
        { id: 'new', label: 'New project', keys: 'Ctrl+N', run: () => void askNewProject() },
        { id: 'open', label: 'Open…', keys: 'Ctrl+O', run: openProjectDialog },
        { id: 'recent', label: 'Open recent', sub: 'recent' },
        'sep',
        { id: 'import', label: 'Import media…', keys: 'Ctrl+I', run: importDialog, enabled: (s) => !!s.snap },
        { id: 'importFolder', label: 'Import a folder…', run: importFolderDialog, enabled: (s) => !!s.snap },
        { id: 'importCapcut', label: 'Import from CapCut…', run: openCapcut },
        'sep',
        { id: 'save', label: 'Save', keys: 'Ctrl+S', run: () => toast('Saved. Studio saves every change as you make it.') },
        { id: 'saveAs', label: 'Save as…', run: () => setState({ dialog: 'saveAs' }), enabled: (s) => !!s.snap },
        { id: 'versions', label: 'Versions…', run: () => setState({ dialog: 'versions' }), enabled: (s) => !!s.snap },
        'sep',
        { id: 'settings', label: 'Project settings…', run: () => setState({ selection: [], page: 'edit' }) },
        { id: 'export', label: 'Export…', keys: 'Ctrl+E', run: () => setState({ dialog: 'export' }), enabled: hasClips },
        { id: 'queue', label: 'Export queue', run: () => setState({ dialog: 'export' }) },
        'sep',
        { id: 'mcp', label: 'Agent connection (MCP)…', run: () => setState({ dialog: 'mcp' }) },
        { id: 'close', label: 'Close project', keys: 'Ctrl+W', run: () => void closeProject() },
      ],
    ],
    edit: [
      'Edit',
      [
        { id: 'undo', label: 'Undo', keys: 'Ctrl+Z', run: undo, enabled: (s) => !!s.snap?.canUndo },
        { id: 'redo', label: 'Redo', keys: 'Shift+Ctrl+Z', run: redo, enabled: (s) => !!s.snap?.canRedo },
        { id: 'history', label: 'Show history', keys: 'Alt+H', run: showHistory },
        'sep',
        { id: 'cut', label: 'Cut', keys: 'Ctrl+X', run: cut, enabled: (s) => (s.focus === 'library' ? s.libraryPicked.length : s.selection.length) > 0 },
        { id: 'copy', label: 'Copy', keys: 'Ctrl+C', run: copy, enabled: (s) => (s.focus === 'library' ? s.libraryPicked.length : s.selection.length) > 0 },
        { id: 'paste', label: 'Paste', keys: 'Ctrl+V', run: paste, enabled: (s) => !!s.clipboard },
        { id: 'pasteAttr', label: 'Paste attributes…', keys: 'Shift+Ctrl+V', run: pasteAttributes, enabled: (s) => !!s.attributes && hasSel(s) },
        { id: 'dup', label: 'Duplicate', keys: 'Ctrl+D', run: duplicate, enabled: hasSel },
        'sep',
        { id: 'split', label: 'Split at playhead', keys: 'Ctrl+B', run: splitAtPlayhead, enabled: hasClips },
        { id: 'del', label: 'Delete', keys: 'Del', run: deleteSelection, enabled: hasSel },
        { id: 'ripple', label: 'Ripple delete', keys: 'Shift+Del', run: deleteSelection, enabled: hasSel },
        'sep',
        { id: 'all', label: 'Select all', keys: 'Ctrl+A', run: selectAll, enabled: hasClips },
        { id: 'after', label: 'Select clips after playhead', keys: 'Y', run: selectAfterPlayhead, enabled: hasClips },
        'sep',
        { id: 'keys', label: 'Keyboard shortcuts…', keys: 'Ctrl+K', run: () => setState({ dialog: 'shortcuts' }) },
        { id: 'prefs', label: 'Preferences…', keys: 'Ctrl+,', run: () => setState({ dialog: 'prefs' }) },
      ],
    ],
    view: [
      'View',
      [
        { id: 'workspace', label: 'Workspace', sub: 'workspace' },
        { id: 'panels', label: 'Panels', sub: 'panels' },
        'sep',
        { id: 'trackHeight', label: 'Track height', keys: 'Shift+scroll', sub: 'track' },
        { id: 'zoomIn', label: 'Zoom in', keys: 'Ctrl+=', run: () => timelineApi.zoom(1.4) },
        { id: 'zoomOut', label: 'Zoom out', keys: 'Ctrl+−', run: () => timelineApi.zoom(1 / 1.4) },
        { id: 'fit', label: 'Zoom to fit', keys: 'Shift+Z', run: () => timelineApi.fit(), enabled: hasClips },
        'sep',
        { id: 'waves', label: 'Show waveforms', run: () => setState({ showWaveforms: !getState().showWaveforms }), checked: (s) => s.showWaveforms },
        { id: 'thumbs', label: 'Show thumbnails', run: () => setState({ showThumbnails: !getState().showThumbnails }), checked: (s) => s.showThumbnails },
        { id: 'safe', label: 'Safe zones', run: () => setState({ safeZones: !getState().safeZones }), checked: (s) => s.safeZones },
        'sep',
        { id: 'lock', label: 'Lock panel layout', run: toggleLayoutLock, checked: (s) => s.layoutLocked },
        { id: 'full', label: 'Full-screen player', keys: 'F', run: () => setState({ fullPlayer: !getState().fullPlayer }), checked: (s) => s.fullPlayer },
      ],
    ],
    help: [
      'Help',
      [
        { id: 'shortcuts', label: 'Keyboard shortcuts', keys: 'Ctrl+/', run: () => setState({ dialog: 'shortcuts' }) },
        { id: 'start', label: 'Getting started', run: () => setState({ dialog: 'start' }) },
        { id: 'mcpHelp', label: 'Connect an agent (MCP)', run: () => setState({ dialog: 'mcp' }) },
        'sep',
        { id: 'whatsNew', label: 'What’s new', run: () => setState({ dialog: 'whatsNew' }) },
        { id: 'report', label: 'Report a problem…', run: () => setState({ dialog: 'report' }) },
        { id: 'about', label: 'About', run: () => setState({ dialog: 'about' }) },
      ],
    ],
  }
}

function submenus(): Record<string, [string, Entry[]]> {
  const recent = recentProjects()
  return {
    workspace: [
      'Workspace',
      [
        { id: 'ws-ads', label: 'Ads, vertical', keys: 'Alt+1', run: () => setLayout('ads'), checked: (s) => s.page === 'edit' && s.layout === 'ads' },
        { id: 'ws-standard', label: 'Standard', keys: 'Alt+2', run: () => setLayout('standard'), checked: (s) => s.page === 'edit' && s.layout === 'standard' },
        { id: 'ws-review', label: 'Review', keys: 'Alt+3', run: () => setLayout('review'), checked: (s) => s.page === 'edit' && s.layout === 'review' },
        { id: 'ws-audio', label: 'Audio', keys: 'Alt+4', run: () => setState({ page: 'audio' }), checked: (s) => s.page === 'audio' },
        ...(workspaces().length ? (['sep'] as Entry[]) : []),
        ...workspaces().map((w): Entry => ({ id: `ws-own-${w.name}`, label: w.name, run: () => applyWorkspace(w.name) })),
        'sep',
        { id: 'ws-save', label: 'Save this layout…', run: () => setState({ dialog: 'saveLayout' }) },
        { id: 'ws-manage', label: 'Manage workspaces…', run: () => setState({ dialog: 'workspaces' }) },
        { id: 'ws-reset', label: 'Reset to default', run: () => setLayout('ads') },
      ],
    ],
    panels: [
      'Panels',
      [
        { id: 'p-lib', label: 'Library', checked: (s) => !s.hiddenPanels.includes('lib'), run: () => togglePanel('lib') },
        { id: 'p-insp', label: 'Inspector', checked: (s) => !s.hiddenPanels.includes('insp'), run: () => togglePanel('insp') },
        { id: 'p-player', label: 'Player', checked: (s) => !s.hiddenPanels.includes('player'), run: () => togglePanel('player') },
        { id: 'p-tl', label: 'Timeline', checked: (s) => !s.hiddenPanels.includes('tl'), run: () => togglePanel('tl') },
        { id: 'p-hist', label: 'History', run: showHistory },
        { id: 'p-meters', label: 'Audio meters', run: () => setState({ page: 'audio' }) },
      ],
    ],
    track: [
      'Track height',
      [
        { id: 'th-s', label: 'Small', run: () => timelineApi.setHeight(0.65) },
        { id: 'th-m', label: 'Medium', run: () => timelineApi.setHeight(1) },
        { id: 'th-l', label: 'Large', run: () => timelineApi.setHeight(1.45) },
        'sep',
        { id: 'th-fit', label: 'Fit all tracks', run: () => timelineApi.fitHeight() },
      ],
    ],
    recent: [
      'Open recent',
      [
        ...recent.map((dir): Item => ({ id: dir, label: basename(dir).replace(/\.studio$/, ''), run: () => openProjectAt(dir), checked: (s) => s.snap?.dir === dir })),
        ...(recent.length ? (['sep'] as Entry[]) : []),
        { id: 'rclear', label: recent.length ? 'Clear the list' : 'No recent projects', run: clearRecent, enabled: () => recent.length > 0 },
      ],
    ],
  }
}

const CHECK = 'M3 8.5l3 3 7-7'

function MenuList({ title, entries, state, sub, onSub, onPick, width, top }: { title: string; entries: Entry[]; state: State; sub?: string; onSub?: (id: string, index: number) => void; onPick: () => void; width: number; top?: number }) {
  return (
    <div className="menu-list" role="menu" aria-label={title} style={{ width, marginTop: top }}>
      {entries.map((e, i) =>
        e === 'sep' ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : (
          <button
            key={e.id}
            type="button"
            role="menuitem"
            className={sub && e.sub === sub ? 'open' : ''}
            disabled={e.enabled ? !e.enabled(state) : false}
            aria-haspopup={e.sub ? 'menu' : undefined}
            onMouseEnter={() => onSub?.(e.sub ?? '', i)}
            onClick={() => {
              if (e.sub) return onSub?.(e.sub, i)
              onPick()
              e.run?.()
            }}
          >
            <span className="menu-check" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: e.checked?.(state) ? 1 : 0 }}>
                <path d={CHECK} />
              </svg>
            </span>
            <span className="menu-label">{e.label}</span>
            <span className="menu-keys">{e.keys && ACTION_IDS.has(e.id) ? keysFor(e.id) : (e.keys ?? '')}</span>
            <span className="menu-sub" aria-hidden="true">
              {e.sub && (
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 3l5 5-5 5" />
                </svg>
              )}
            </span>
          </button>
        ),
      )}
    </div>
  )
}

export function MenuBar() {
  const [open, setOpen] = useState<string | null>(null)
  const [sub, setSub] = useState<{ id: string; index: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  // Only follow the store while a menu is open (its items' enabled and checked states).
  const state = useStore((s) => (open ? s : null)) ?? getState()
  const all = menus()
  const subs = submenus()

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  const close = () => {
    setOpen(null)
    setSub(null)
  }
  // The submenu sits level with its item: 28 px per item, 9 per separator, inside 4 px padding.
  const subTop = (entries: Entry[], index: number) => entries.slice(0, index).reduce((y, e) => y + (e === 'sep' ? 9 : 28), 0)

  return (
    <div className="menubar" ref={ref}>
      {Object.entries(all).map(([id, [name, entries]]) => (
        <div key={id} className="menu">
          <button
            type="button"
            className={`menu-button${open === id ? ' open' : ''}`}
            aria-haspopup="menu"
            aria-expanded={open === id}
            onClick={() => (open === id ? close() : (setOpen(id), setSub(null)))}
            onPointerEnter={() => open && open !== id && (setOpen(id), setSub(null))}
          >
            {name}
          </button>
          {open === id && (
            <div className="menu-pop">
              <MenuList title={name} entries={entries} state={state} sub={sub?.id} onSub={(s, index) => setSub(s ? { id: s, index } : null)} onPick={close} width={272} />
              {sub && subs[sub.id] && <MenuList title={subs[sub.id][0]} entries={subs[sub.id][1]} state={state} onPick={close} width={240} top={subTop(entries, sub.index)} />}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
