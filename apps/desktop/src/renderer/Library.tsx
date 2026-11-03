import './library.css'
import { useMemo, useRef, useState, type DragEvent } from 'react'
import { AudioPanel } from './AudioPanel'
import { libraryMenu, openMenu } from './ContextMenu'
import { DIcon, LIB_ICONS } from './design-icons'
import { Actions, Head, Note, Row, SearchBox, mss, startMediaDrag } from './LibraryBlocks'
import { CaptionsTab, EffectsTab, HistoryTab, StickersTab, TextTab, TransitionsTab } from './LibraryTabs'
import { TranslationsTab } from './TranslationsTab'
import { call, fileUrl, getState, importDialog, importFolderDialog, importPaths, previewMedia, setState, syncFolder, unlinkFolder, useStore, type Folder, type Media } from './store'
import { setUi, useUi } from './ui-state'
import { useBoxSelect } from './boxSelect'

export { MEDIA_MIME } from './LibraryBlocks'

type Cat = 'media' | 'audio' | 'text' | 'stickers' | 'effects' | 'transitions' | 'translations' | 'captions' | 'history'
const CATEGORIES: [Cat, string][] = [
  ['media', 'Media'],
  ['audio', 'Audio'],
  ['text', 'Text'],
  ['stickers', 'Stickers'],
  ['effects', 'Effects'],
  ['transitions', 'Transitions'],
  ['translations', 'Translations'],
  ['captions', 'Captions'],
  ['history', 'History'],
]

export function LibraryPanel() {
  const [cat, setCat] = useUi<Cat>('lib.cat', 'media')
  return (
    <div className="panel library">
      <nav className="categories" aria-label="Library categories">
        {CATEGORIES.map(([id, name]) => (
          <button key={id} type="button" aria-pressed={cat === id} className={cat === id ? 'active' : ''} onClick={() => setCat(id)}>
            <DIcon d={LIB_ICONS[id]} />
            <span>{name}</span>
          </button>
        ))}
      </nav>
      {cat === 'media' ? (
        <MediaBin />
      ) : cat === 'audio' ? (
        <AudioPanel />
      ) : (
        <div className="lib-scroll">
          {cat === 'text' ? <TextTab /> : cat === 'stickers' ? <StickersTab /> : cat === 'effects' ? <EffectsTab /> : cat === 'transitions' ? <TransitionsTab /> : cat === 'translations' ? <TranslationsTab /> : cat === 'captions' ? <CaptionsTab /> : <HistoryTab />}
        </div>
      )}
    </div>
  )
}

/** The Media tab's Record button: recording lives in Audio › Voice. */
export function openRecorder() {
  setUi('lib.audioSub', 'Voice')
  setUi('lib.cat', 'audio')
}

// The folder map

interface TreeNode {
  folder: Folder
  dir: string
  name: string
  count: number
  children: TreeNode[]
}

const parentDir = (dir: string) => (dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '')
const joinPath = (root: string, dir: string) => (dir ? `${root}${root.includes('\\') ? '\\' : '/'}${dir.replaceAll('/', root.includes('\\') ? '\\' : '/')}` : root)

/** One tree per linked folder, built from where its media sit. Counts include subfolders. */
function buildTrees(folders: Folder[], items: Media[]): TreeNode[] {
  return folders.map((folder) => {
    const root: TreeNode = { folder, dir: '', name: folder.name, count: 0, children: [] }
    const nodes = new Map<string, TreeNode>([['', root]])
    const ensure = (dir: string): TreeNode => {
      const found = nodes.get(dir)
      if (found) return found
      const parent = ensure(parentDir(dir))
      const node: TreeNode = { folder, dir, name: dir.split('/').pop()!, count: 0, children: [] }
      parent.children.push(node)
      nodes.set(dir, node)
      return node
    }
    for (const m of items) {
      if (m.folder !== folder.id) continue
      let n: TreeNode | undefined = ensure(m.dir ?? '')
      for (let d = m.dir ?? ''; ; d = parentDir(d)) {
        n = nodes.get(d)
        if (n) n.count++
        if (!d) break
      }
    }
    const sort = (n: TreeNode) => {
      n.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      n.children.forEach(sort)
    }
    sort(root)
    return root
  })
}

/** The nodes from a linked folder's top down to `dir`. */
function pathTo(trees: TreeNode[], folderId: string, dir: string): TreeNode[] {
  const root = trees.find((t) => t.folder.id === folderId)
  if (!root) return []
  const path = [root]
  for (const part of dir ? dir.split('/') : []) {
    const at = path[path.length - 1]
    const next = at.children.find((c) => c.name === part)
    if (!next) break
    path.push(next)
  }
  return path
}

/** "Jul and Problem", or what the folder holds when it has no subfolders: "Images, 1080 × 1350". */
function describe(node: TreeNode, all: Media[]): string {
  const kids = node.children.filter((c) => c.count > 0).map((c) => c.name)
  if (kids.length) {
    const shown = kids.length > 3 ? [...kids.slice(0, 2), `${kids.length - 2} more`] : kids
    return shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
  }
  const here = all.filter((m) => m.folder === node.folder.id && (m.dir ?? '') === node.dir)
  const kinds = [...new Set(here.map((m) => m.kind))]
  const word = { video: 'Video', image: 'Images', audio: 'Audio' } as const
  const text = kinds.map((k, i) => (i ? word[k].toLowerCase() : word[k])).join(' and ')
  const sizes = [...new Set(here.filter((m) => m.kind !== 'audio').map((m) => `${m.width} × ${m.height}`))]
  return sizes.length === 1 ? `${text}, ${sizes[0]}` : text
}

function MediaBin() {
  const media = useStore((s) => s.snap?.project.media)
  const folders = useStore((s) => s.snap?.project.folders)
  const tracks = useStore((s) => s.snap?.project.tracks)
  const processing = useStore((s) => s.snap?.processing)
  const hasProject = useStore((s) => !!s.snap)
  const scope = useStore((s) => s.libraryScope)
  const dir = useStore((s) => s.libraryDir)
  const [dropping, setDropping] = useState(false)
  // Picked library items (separate from the timeline's selection).
  const picked = useStore((s) => s.libraryPicked)
  const setPicked = (ids: string[]) => setState({ libraryPicked: ids })
  const importing = useStore((s) => s.importing)
  const loadTotal = useStore((s) => s.loadTotal)
  const anchorRef = useRef<string | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const binRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useUi('lib.media.query', '')

  const all = media ?? []
  const used = useMemo(() => new Set((tracks ?? []).flatMap((t) => t.clips.map((c) => c.mediaId))), [tracks])
  const trees = useMemo(() => buildTrees(folders ?? [], all), [folders, all])
  const loose = all.filter((m) => !m.folder)
  const path = scope !== 'all' && scope !== 'loose' ? pathTo(trees, scope, dir) : []
  const node = path[path.length - 1]
  const busy = processing?.length ?? 0

  // What the grid shows: a search across the current place, or the place itself.
  const q = query.trim().toLowerCase()
  const under = (m: Media) => (node ? m.folder === node.folder.id && (!node.dir || m.dir === node.dir || (m.dir ?? '').startsWith(`${node.dir}/`)) : true)
  const items = q ? all.filter((m) => under(m) && m.name.toLowerCase().includes(q)) : node ? all.filter((m) => m.folder === node.folder.id && (m.dir ?? '') === node.dir) : loose
  const go = (folderId: string | 'all', d = '') => {
    setState({ libraryScope: folderId, libraryDir: d })
    setQuery('')
  }

  // The Folders list is the folder map: every linked folder, opened along the way to where you are.
  const rows: { node: TreeNode; depth: number; current: boolean; child: boolean }[] = []
  const walk = (list: TreeNode[], depth: number, parentIsHere: boolean) => {
    for (const n of list.filter((c) => c.count > 0 || depth === 0)) {
      rows.push({ node: n, depth, current: n === node, child: parentIsHere })
      if (path.includes(n)) walk(n.children, depth + 1, n === node)
    }
  }
  walk(trees, 0, !node)

  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropping(true)
  }
  const onDrop = (e: DragEvent) => {
    setDropping(false)
    if (!e.dataTransfer.files.length) return
    e.preventDefault()
    importPaths([...e.dataTransfer.files].map((f) => window.studio.app.pathForFile(f)).filter(Boolean))
  }

  // Click picks one; Ctrl+click adds or removes; Shift+click picks the run from the last one.
  const pick = (id: string, e: React.MouseEvent) => {
    if (e.shiftKey && anchorRef.current) {
      const ids = items.map((m) => m.id)
      const [a, b] = [ids.indexOf(anchorRef.current), ids.indexOf(id)]
      if (a >= 0 && b >= 0) {
        setPicked([...new Set([...picked, ...ids.slice(Math.min(a, b), Math.max(a, b) + 1)])])
        return
      }
    }
    anchorRef.current = id
    if (e.ctrlKey || e.metaKey) setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id])
    else setPicked([id])
  }

  // Dragging across empty space in the grid draws a box and picks every tile it touches; it
  // holds on to them while the list scrolls (useBoxSelect).
  const { box, start: startBox } = useBoxSelect({
    scroller: scrollRef,
    items: () => gridRef.current?.querySelectorAll<HTMLElement>('[data-media]') ?? [],
    idOf: (el) => el.dataset.media,
    onPick: setPicked,
  })
  const onGridDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.tile')) return
    const add = e.shiftKey || e.ctrlKey || e.metaKey
    if (!add) setPicked([])
    startBox(e, add ? picked : [])
  }

  const empty = !all.length && !trees.length
  const crumbs = node ? [node.folder.name, ...(node.dir ? node.dir.split('/') : [])] : []
  return (
    <div
      ref={binRef}
      className={`bin${dropping ? ' dropping' : ''}`}
      // The library takes Ctrl+C/X/V and Delete once clicked.
      onPointerDownCapture={() => getState().focus !== 'library' && setState({ focus: 'library' })}
      onDragOver={onDragOver}
      onDragLeave={(e) => !binRef.current?.contains(e.relatedTarget as Node | null) && setDropping(false)}
      onDrop={onDrop}
    >
      <div className="lib-scroll bin-scroll" ref={scrollRef}>
        <Actions
          items={[
            { label: 'Import', icon: LIB_ICONS.import, onClick: importDialog, disabled: !hasProject, title: 'Import files (Ctrl+I)' },
            { label: 'Folder', icon: LIB_ICONS.folder, onClick: importFolderDialog, disabled: !hasProject, title: 'Link a folder (Ctrl+Shift+I). Its subfolders become a map here; the files stay where they are.' },
            { label: 'Record', icon: LIB_ICONS.mic, onClick: openRecorder, disabled: !hasProject, title: 'Record a voiceover (Audio › Voice)' },
          ]}
        />
        <SearchBox className="bin-search" value={query} onChange={setQuery} placeholder={node ? `Search ${node.name}` : 'Search media'} />
        {importing.length > 0 ? (
          <div className="bin-status" role="status">
            <span>
              Loading <strong>{importing.join(', ')}</strong>… scanning the files. Leave it be; it shows up here when done.
            </span>
            <span className="bin-progress indeterminate" />
          </div>
        ) : busy > 0 ? (
          <div className="bin-status" role="status">
            <span>
              Loading thumbnails and previews: {Math.max(0, loadTotal - busy)} of {Math.max(loadTotal, busy)} ready. You can already use what's here.
            </span>
            <span className="bin-progress">
              <span style={{ width: `${(100 * Math.max(0, loadTotal - busy)) / Math.max(1, loadTotal, busy)}%` }} />
            </span>
          </div>
        ) : null}
        {empty ? (
          <Note>Import video, audio or images, or link a whole folder. Or drop files and folders here.</Note>
        ) : (
          <>
            <Head
              text={
                <span className="crumbs">
                  <button type="button" className={!node ? 'here' : ''} onClick={() => go('all')}>
                    In this project
                  </button>
                  {crumbs.map((part, i) => (
                    <span key={i} className="crumb">
                      <span className="crumb-sep" aria-hidden="true">
                        /
                      </span>
                      <button type="button" className={i === crumbs.length - 1 ? 'here' : ''} onClick={() => go(node!.folder.id, i === 0 ? '' : node!.dir.split('/').slice(0, i).join('/'))}>
                        {part}
                      </button>
                    </span>
                  ))}
                  <span className="crumb-count"> · {items.length}</span>
                </span>
              }
              right={
                node && (
                  <span className="crumb-actions">
                    <button type="button" title="Rescan for new and missing files" onClick={() => syncFolder(node.folder.id)}>
                      Rescan
                    </button>
                    <button type="button" title="Open in the file manager" onClick={() => window.studio.app.openFolder(joinPath(node.folder.path, node.dir))}>
                      Show
                    </button>
                    {!node.dir && (
                      <button type="button" title="Remove this folder from the library (files on disk are untouched; clips on the timeline stay)" onClick={() => unlinkFolder(node.folder.id)}>
                        Remove
                      </button>
                    )}
                  </span>
                )
              }
            />
            {items.length ? (
              <div className="bin-grid" ref={gridRef} onPointerDown={onGridDown}>
                {items.map((m) => (
                  <MediaTile
                    key={m.id}
                    media={m}
                    busy={!!processing?.includes(m.id)}
                    selected={picked.includes(m.id)}
                    used={used.has(m.id)}
                    onPick={(e) => pick(m.id, e)}
                    onMenu={(e) => {
                      e.preventDefault()
                      if (!picked.includes(m.id)) setPicked([m.id])
                      openMenu(e.clientX, e.clientY, libraryMenu())
                    }}
                    dragIds={picked.includes(m.id) ? items.filter((x) => picked.includes(x.id) && !x.missing) : [m]}
                    showPlace={!!q}
                  />
                ))}
              </div>
            ) : (
              <Note>{q ? `Nothing named “${query.trim()}” here.` : node ? 'No files here, only folders.' : 'Nothing imported on its own yet. Linked folders are below.'}</Note>
            )}
            {!q && rows.length > 0 && (
              <>
                <Head text="Folders" />
                <div className="tree lib-rows" role="tree" aria-label="Folder map">
                  {rows.map((r) => (
                    <Row
                      key={`${r.node.folder.id}:${r.node.dir}`}
                      className={`tree-row${r.child ? ' folder-tile' : ''}`}
                      nameClass="tree-label tile-name"
                      active={r.current}
                      icon={LIB_ICONS.folder}
                      name={r.node.name}
                      sub={describe(r.node, all)}
                      dur={String(r.node.count)}
                      style={{ paddingLeft: 6 + r.depth * 16 }}
                      title={`${r.node.name}\n${r.node.count} file${r.node.count === 1 ? '' : 's'}`}
                      onClick={() => go(r.node.folder.id, r.node.dir)}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}
        {box && <div className="bin-box" style={box} />}
      </div>
    </div>
  )
}

/** Puts media on the timeline one after another (at the end, unless `at` is given). */
export async function addToTimeline(ids: { id: string; kind: Media['kind']; durationUs: number }[], at?: number) {
  let t = at
  for (const m of ids) {
    await call('timeline.insert', { mediaId: m.id, ...(t != null ? { atUs: Math.round(t) } : {}) })
    if (t != null) t += m.kind === 'image' ? 3_000_000 : m.durationUs
  }
}

function MediaTile({ media, busy, selected, used, onPick, onMenu, dragIds, showPlace }: { media: Media; busy: boolean; selected: boolean; used: boolean; onPick: (e: React.MouseEvent) => void; onMenu: (e: React.MouseEvent) => void; dragIds: Media[]; showPlace?: boolean }) {
  // Where the player is in this clip, when it's the one being previewed.
  const mark = useStore((s) => (s.source?.mediaId === media.id ? s.source.positionUs : null))
  const length = media.kind === 'image' ? 3_000_000 : Math.max(1, media.durationUs)
  // With several picked, + and dragging take all of them, in library order.
  const add = () => addToTimeline(dragIds)
  const place = showPlace && media.dir ? `${media.dir}/` : ''
  return (
    <div
      className={`tile${selected ? ' selected' : ''}${media.missing ? ' missing' : ''}`}
      data-media={media.id}
      draggable={!media.missing}
      onDragStart={(e) => startMediaDrag(e, dragIds)}
      onClick={(e) => {
        onPick(e)
        // A plain click previews the clip, from where it was clicked across the thumbnail.
        if (e.shiftKey || e.ctrlKey || e.metaKey || media.missing) return
        const thumb = (e.currentTarget as HTMLElement).querySelector('.tile-thumb')!.getBoundingClientRect()
        const f = e.clientY <= thumb.bottom ? Math.min(1, Math.max(0, (e.clientX - thumb.left) / thumb.width)) : 0
        previewMedia(media.id, media.kind === 'image' ? 0 : f * length)
      }}
      onContextMenu={onMenu}
      onDoubleClick={() => !media.missing && call('timeline.insert', { mediaId: media.id })}
      title={`${media.name}\n${media.missing ? 'Missing on disk: ' + media.path : media.kind === 'audio' ? 'Audio' : `${media.width} × ${media.height}`}${media.kind === 'image' || media.missing ? '' : ` · ${mss(media.durationUs)}`}${used ? '\nOn the timeline' : ''}\nDouble-click or drag to add it to the timeline`}
    >
      <div className={`tile-thumb kind-${media.kind}`}>
        {media.poster ? <img src={fileUrl(media.poster)} alt="" draggable={false} loading="lazy" /> : media.kind === 'audio' ? <DIcon d={LIB_ICONS.audio} size={20} /> : null}
        {used && !media.missing && (
          <span className="tile-check" title="On the timeline">
            <DIcon d={LIB_ICONS.check} size={10} width={2} />
          </span>
        )}
        {media.missing ? <span className="tile-missing">Missing</span> : media.kind !== 'image' && <span className="tile-dur">{mss(media.durationUs)}</span>}
        {busy && <span className="tile-busy" aria-label="Preparing" />}
        {mark != null && media.kind !== 'image' && <span className="tile-mark" style={{ left: `${Math.min(100, (100 * mark) / length)}%` }} />}
        {!media.missing && (
          <button
            type="button"
            className="tile-add"
            title="Add to the timeline"
            onClick={(e) => {
              e.stopPropagation()
              add()
            }}
          >
            <DIcon d={LIB_ICONS.plus} size={12} />
          </button>
        )}
      </div>
      <span className="tile-name">
        {place && <span className="tile-place">{place}</span>}
        {media.name}
      </span>
    </div>
  )
}
