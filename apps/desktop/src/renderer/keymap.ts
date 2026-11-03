// Every keyboard shortcut in one table (Menus.dc.html's "Keyboard shortcuts"): default keys,
// presets that start from another editor's keys, and your own changes on top. The menus
// show the keys from here, so a change shows up everywhere.

import { timelineApi } from './Timeline'
import {
  closeProject,
  breakCompound,
  copy,
  copyAttributes,
  cut,
  deleteFocused,
  deleteSide,
  duplicate,
  extractAudio,
  frameUs,
  getState,
  importDialog,
  importFolderDialog,
  makeCompound,
  openProjectDialog,
  paste,
  pasteAttributes,
  redo,
  seek,
  seekSource,
  selectAfterPlayhead,
  selectAll,
  setLayout,
  setState,
  splitAtPlayhead,
  step,
  toast,
  toggleLinkage,
  toggleMagnet,
  togglePlay,
  undo,
  addMarker,
  shuttle,
} from './store'
import { addText } from './libraryActions'
import { setUi } from './ui-state'

export type Group = 'Timeline' | 'Playback' | 'Tools' | 'Workspace' | 'Edit' | 'File'

export interface Action {
  id: string
  group: Group
  label: string
  keys: string
  run?: () => unknown
  /** Shown for reference; a mouse gesture, not a key you can change. */
  fixed?: boolean
}

const total = () => getState().snap?.durationUs ?? 0

export const ACTIONS: Action[] = [
  { id: 'split', group: 'Timeline', label: 'Split at playhead', keys: 'Ctrl+B', run: splitAtPlayhead },
  { id: 'ripple', group: 'Timeline', label: 'Ripple delete', keys: 'Shift+Del', run: deleteFocused },
  { id: 'after', group: 'Timeline', label: 'Select clips after playhead', keys: 'Y', run: selectAfterPlayhead },
  { id: 'trackHeight', group: 'Timeline', label: 'Track height', keys: 'Shift+Scroll', fixed: true },
  { id: 'zoomScroll', group: 'Timeline', label: 'Zoom the timeline', keys: 'Alt+Scroll', fixed: true },
  { id: 'fit', group: 'Timeline', label: 'Zoom to fit', keys: 'Shift+Z', run: () => timelineApi.fit() },
  { id: 'marker', group: 'Timeline', label: 'Add marker', keys: 'M', run: addMarker },
  { id: 'deleteLeft', group: 'Timeline', label: 'Delete left', keys: 'Q', run: () => deleteSide('left') },
  { id: 'deleteRight', group: 'Timeline', label: 'Delete right', keys: 'W', run: () => deleteSide('right') },
  { id: 'extract', group: 'Timeline', label: 'Extract audio', keys: 'Shift+Ctrl+S', run: extractAudio },
  { id: 'magnet', group: 'Timeline', label: 'Main track magnet', keys: 'P', run: toggleMagnet },
  { id: 'snapping', group: 'Timeline', label: 'Snapping', keys: 'N', run: () => timelineApi.toggleSnap() },
  { id: 'linkage', group: 'Timeline', label: 'Link audio and video', keys: '§', run: toggleLinkage },
  { id: 'zoomIn', group: 'Timeline', label: 'Zoom in', keys: 'Ctrl+=', run: () => timelineApi.zoom(1.4) },
  { id: 'zoomOut', group: 'Timeline', label: 'Zoom out', keys: 'Ctrl+−', run: () => timelineApi.zoom(1 / 1.4) },
  { id: 'compound', group: 'Timeline', label: 'Make compound clip', keys: 'Alt+G', run: makeCompound },
  { id: 'breakCompound', group: 'Timeline', label: 'Break compound clip', keys: 'Shift+Alt+G', run: breakCompound },

  { id: 'play', group: 'Playback', label: 'Play or pause', keys: 'Space', run: togglePlay },
  { id: 'back', group: 'Playback', label: 'Play backwards', keys: 'J', run: () => shuttle(-1) },
  { id: 'stop', group: 'Playback', label: 'Stop', keys: 'K', run: () => shuttle(0) },
  { id: 'forward', group: 'Playback', label: 'Play forwards', keys: 'L', run: () => shuttle(1) },
  { id: 'prev', group: 'Playback', label: 'Previous frame', keys: '←', run: () => step(-1) },
  { id: 'next', group: 'Playback', label: 'Next frame', keys: '→', run: () => step(1) },
  { id: 'prevSecond', group: 'Playback', label: 'Back one second', keys: 'Shift+←', run: () => step(-Math.round(1_000_000 / frameUs())) },
  { id: 'nextSecond', group: 'Playback', label: 'Forward one second', keys: 'Shift+→', run: () => step(Math.round(1_000_000 / frameUs())) },
  { id: 'start', group: 'Playback', label: 'Go to start', keys: 'Home', run: () => (getState().source ? seekSource(0) : seek(0)) },
  { id: 'end', group: 'Playback', label: 'Go to end', keys: 'End', run: () => (getState().source ? seekSource(Number.MAX_SAFE_INTEGER) : seek(total())) },
  { id: 'full', group: 'Playback', label: 'Full-screen player', keys: 'F', run: () => setState({ fullPlayer: !getState().fullPlayer }) },

  { id: 'selectTool', group: 'Tools', label: 'Select tool', keys: 'V', run: () => setState({ tool: 'select' }) },
  { id: 'splitTool', group: 'Tools', label: 'Split tool', keys: 'B', run: () => setState({ tool: getState().tool === 'blade' ? 'select' : 'blade' }) },
  { id: 'envelope', group: 'Tools', label: 'Volume envelope', keys: 'E', run: () => setState({ page: 'audio' }) },
  { id: 'text', group: 'Tools', label: 'Add text at playhead', keys: 'T', run: addText },
  { id: 'keyframe', group: 'Tools', label: 'Add keyframe', keys: 'Alt+K', run: () => window.dispatchEvent(new CustomEvent('studio:keyframe')) },
  { id: 'undo', group: 'Tools', label: 'Undo', keys: 'Ctrl+Z', run: undo },
  { id: 'redo', group: 'Tools', label: 'Redo', keys: 'Shift+Ctrl+Z', run: redo },

  { id: 'ws-ads', group: 'Workspace', label: 'Ads, vertical', keys: 'Alt+1', run: () => setLayout('ads') },
  { id: 'ws-standard', group: 'Workspace', label: 'Standard', keys: 'Alt+2', run: () => setLayout('standard') },
  { id: 'ws-review', group: 'Workspace', label: 'Review', keys: 'Alt+3', run: () => setLayout('review') },
  { id: 'ws-audio', group: 'Workspace', label: 'Audio', keys: 'Alt+4', run: () => setState({ page: 'audio' }) },
  { id: 'editPage', group: 'Workspace', label: 'Edit page', keys: 'Shift+4', run: () => setState({ page: 'edit' }) },
  { id: 'audioPage', group: 'Workspace', label: 'Audio page', keys: 'Shift+6', run: () => setState({ page: 'audio' }) },
  { id: 'export', group: 'Workspace', label: 'Export', keys: 'Ctrl+E', run: () => total() && setState({ dialog: 'export' }) },

  { id: 'cut', group: 'Edit', label: 'Cut', keys: 'Ctrl+X', run: cut },
  { id: 'copy', group: 'Edit', label: 'Copy', keys: 'Ctrl+C', run: copy },
  { id: 'paste', group: 'Edit', label: 'Paste', keys: 'Ctrl+V', run: paste },
  { id: 'copyAttr', group: 'Edit', label: 'Copy attributes', keys: 'Ctrl+Alt+C', run: copyAttributes },
  { id: 'pasteAttr', group: 'Edit', label: 'Paste attributes', keys: 'Shift+Ctrl+V', run: pasteAttributes },
  { id: 'dup', group: 'Edit', label: 'Duplicate', keys: 'Ctrl+D', run: duplicate },
  { id: 'del', group: 'Edit', label: 'Delete', keys: 'Del', run: deleteFocused },
  { id: 'all', group: 'Edit', label: 'Select all', keys: 'Ctrl+A', run: selectAll },
  { id: 'deselect', group: 'Edit', label: 'Select nothing', keys: 'Esc', run: () => (getState().fullPlayer ? setState({ fullPlayer: false }) : setState({ selection: [] })) },
  { id: 'history', group: 'Edit', label: 'Show history', keys: 'Alt+H', run: () => {
    setState({ page: 'edit' })
    setUi('lib.cat', 'history')
  } },
  { id: 'keys', group: 'Edit', label: 'Keyboard shortcuts', keys: 'Ctrl+K', run: () => setState({ dialog: 'shortcuts' }) },

  { id: 'new', group: 'File', label: 'New project', keys: 'Ctrl+N', run: () => setState({ dialog: 'new' }) },
  { id: 'open', group: 'File', label: 'Open project', keys: 'Ctrl+O', run: openProjectDialog },
  { id: 'import', group: 'File', label: 'Import media', keys: 'Ctrl+I', run: importDialog },
  { id: 'importFolder', group: 'File', label: 'Import a folder', keys: 'Shift+Ctrl+I', run: importFolderDialog },
  { id: 'save', group: 'File', label: 'Save', keys: 'Ctrl+S', run: () => toast('Saved. Studio saves every change as you make it.') },
  { id: 'saveAs', group: 'File', label: 'Save as', keys: 'Ctrl+Alt+S', run: () => setState({ dialog: 'saveAs' }) },
  { id: 'close', group: 'File', label: 'Close project', keys: 'Ctrl+W', run: () => void closeProject() },
  { id: 'prefs', group: 'File', label: 'Preferences', keys: 'Ctrl+,', run: () => setState({ dialog: 'prefs' }) },
]

export const PRESETS = ['Default', 'DaVinci Resolve', 'Premiere Pro', 'CapCut'] as const
export type Preset = (typeof PRESETS)[number]
const PRESET_KEYS: Record<Preset, Record<string, string>> = {
  Default: {},
  'DaVinci Resolve': { split: 'Ctrl+\\', ripple: 'Shift+Del', selectTool: 'A', splitTool: 'B', fit: 'Shift+Z', marker: 'M' },
  'Premiere Pro': { split: 'Ctrl+K', ripple: 'Shift+Del', selectTool: 'V', splitTool: 'C', fit: '\\', marker: 'M' },
  CapCut: { split: 'Ctrl+B', ripple: 'Del', selectTool: 'A', splitTool: 'B', fit: 'Shift+Z', marker: 'M' },
}

const STORE_KEY = 'studio.keys.v1'
interface Saved {
  preset: Preset
  overrides: Record<string, string>
}
function load(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}')
    return { preset: PRESETS.includes(s.preset) ? s.preset : 'Default', overrides: s.overrides ?? {} }
  } catch {
    return { preset: 'Default', overrides: {} }
  }
}
let saved = load()
const listeners = new Set<() => void>()
let version = 0

function save() {
  version++
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(saved))
  } catch {}
  rebuild()
  for (const l of listeners) l()
}
export function subscribeKeys(cb: () => void) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
export const keysVersion = () => version
export const currentPreset = () => saved.preset
export function setPreset(p: Preset) {
  saved = { preset: p, overrides: {} }
  save()
}
export function setKeys(id: string, keys: string) {
  saved = { ...saved, overrides: { ...saved.overrides, [id]: keys } }
  save()
}

// Combos are compared in one order: Ctrl, Alt, Shift, then the key.
function canon(keys: string): string {
  const parts = keys.split('+').filter(Boolean)
  // "Ctrl++" style: a trailing plus is the key itself.
  if (keys.endsWith('++')) parts.push('+')
  const key = parts.pop() ?? ''
  const mods = new Set(parts.map((p) => p.toLowerCase()))
  return `${mods.has('ctrl') || mods.has('cmd') ? 'Ctrl+' : ''}${mods.has('alt') ? 'Alt+' : ''}${mods.has('shift') ? 'Shift+' : ''}${key.toUpperCase()}`
}

/** The key's name as the shortcuts list writes it. */
function keyName(e: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null
  if (e.code === 'Backquote') return '§'
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5)
  if (e.code === 'Minus' || e.code === 'NumpadSubtract') return '−'
  if (e.code === 'Equal' || e.code === 'NumpadAdd') return '='
  if (e.code === 'Backslash' || e.code === 'IntlBackslash') return '\\'
  if (e.code === 'Slash') return '/'
  if (e.code === 'Comma') return ','
  const named: Record<string, string> = { ' ': 'Space', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Delete: 'Del', Backspace: 'Del', Escape: 'Esc' }
  if (named[e.key]) return named[e.key]
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3)
  if (e.key === '-') return '−'
  if (e.key === '+') return '='
  return e.key.length === 1 ? e.key.toUpperCase() : e.key
}

/** How the list writes a key press: Shift+Ctrl+Z, Alt+1. */
export function comboOf(e: KeyboardEvent): string | null {
  const k = keyName(e)
  if (!k) return null
  return `${e.shiftKey ? 'Shift+' : ''}${e.ctrlKey || e.metaKey ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}${k}`
}

let byCombo = new Map<string, Action>()
let keysById = new Map<string, string>()
/** Defaults, then the preset, then your own changes; a later claim on a combo takes it. */
function rebuild() {
  const assign = new Map<string, string>()
  for (const a of ACTIONS) assign.set(a.id, a.keys)
  const owner = new Map<string, string>()
  const claim = (id: string, keys: string) => {
    const c = canon(keys)
    const prev = owner.get(c)
    if (prev && prev !== id) assign.set(prev, '')
    const old = assign.get(id)
    if (old && owner.get(canon(old)) === id) owner.delete(canon(old))
    assign.set(id, keys)
    if (keys) owner.set(c, id)
  }
  for (const a of ACTIONS) if (!a.fixed) claim(a.id, a.keys)
  for (const [id, k] of Object.entries(PRESET_KEYS[saved.preset])) claim(id, k)
  for (const [id, k] of Object.entries(saved.overrides)) claim(id, k)
  byCombo = new Map()
  keysById = assign
  for (const a of ACTIONS) {
    const k = assign.get(a.id)
    if (k && !a.fixed) byCombo.set(canon(k), a)
  }
  // Backspace deletes too, and Ctrl+Y redoes, without taking a row in the list.
}
rebuild()

/** The keys an action has now ('' when another action took them). */
export const keysFor = (id: string) => keysById.get(id) ?? ACTIONS.find((a) => a.id === id)?.keys ?? ''
/** Whether the keys differ from the default, by preset or by hand. */
export const changed = (id: string) => keysFor(id) !== (ACTIONS.find((a) => a.id === id)?.keys ?? '')

export function actionFor(e: KeyboardEvent): Action | undefined {
  const combo = comboOf(e)
  if (!combo) return
  const a = byCombo.get(canon(combo))
  if (a) return a
  // Extras that aren't rows in the list: Backspace deletes, Ctrl+Y redoes, and Ctrl+Alt+V
  // pastes attributes (the partner of Ctrl+Alt+C) unless something else took it.
  if ((e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey && (e.code === 'KeyV' || e.key.toLowerCase() === 'v')) return ACTIONS.find((x) => x.id === 'pasteAttr')
  if (e.key === 'Backspace') return byCombo.get(canon(keysFor('del')))
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === 'KeyY') return ACTIONS.find((x) => x.id === 'redo')
  // Ctrl+/ and "?" open the list too, whatever Ctrl+K is set to.
  if (e.key === '?' || ((e.ctrlKey || e.metaKey) && e.code === 'Slash')) return ACTIONS.find((x) => x.id === 'keys')
}

/** The list as text, for "Export as file". */
export function keymapText(): string {
  const groups = [...new Set(ACTIONS.map((a) => a.group))]
  return [`Studio keyboard shortcuts (${saved.preset})`, '', ...groups.flatMap((g) => [g, ...ACTIONS.filter((a) => a.group === g).map((a) => `  ${a.label.padEnd(32)} ${keysFor(a.id) || '–'}`), ''])].join('\n')
}
