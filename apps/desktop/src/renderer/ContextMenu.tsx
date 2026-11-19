// Right-click menus for timeline clips, empty timeline space and library items.

import { cancelDub, dubbedLines, openDub, rerollClips, retryDub } from './dub'
import { askDirector } from './director'
import { keysFor, keysLabel } from './keymap'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { setUi as setAudioUi } from './audioState'
import { isTranslatedLine } from './wordsSaid'
import {
  breakCompound,
  call,
  cancelTextRemoval,
  copy,
  copyAttributes,
  cut,
  deleteSelection,
  exportSelection,
  extractAudio,
  findClip,
  getState,
  isCompound,
  makeCompound,
  mediaById,
  openChangeVoice,
  openChangeWords,
  openVmake,
  paste,
  pasteAttributes,
  removeFromLibrary,
  selectAll,
  setState,
  splitAtPlayhead,
  useStore,
  type MenuEntry,
} from './store'

/**
 * Edit in Audio: the clip's sound opens on the Audio page, its track picked and the view
 * zoomed to it. A video's own sound is first extracted to a linked track of its own, so cuts
 * there keep the picture in step.
 */
export async function editInAudio(clipId: string) {
  let found = findClip(getState().snap, clipId)
  if (!found) return
  const media = mediaById(getState().snap, found.clip.mediaId)
  const linked = () => {
    const link = found!.clip.link
    const snap = getState().snap
    return link ? snap?.project.tracks.filter((t) => t.kind === 'audio').flatMap((t) => t.clips.map((c) => ({ clip: c, track: t }))).find((x) => x.clip.link === link) : undefined
  }
  if (found.track.kind !== 'audio') {
    if (media?.kind === 'video' && media.hasAudio && !found.clip.detached) {
      const before = getState().snap?.revision
      await call('clip.extractAudio', { clipIds: [clipId] })
      // Wait for the snapshot that has the new audio clip.
      for (let i = 0; i < 40 && getState().snap?.revision === before; i++) await new Promise((r) => setTimeout(r, 50))
      found = findClip(getState().snap, clipId)
    }
    const audio = found && linked()
    if (!audio) return
    found = audio
  }
  const { clip, track } = found!
  const pad = Math.max(200_000, Math.round(clip.durationUs * 0.05))
  setAudioUi({ trackId: track.id, sel: null, zoom: { start: Math.max(0, clip.startUs - pad), span: clip.durationUs + 2 * pad } })
  setState({ page: 'audio', selection: [clip.id], focus: 'timeline' })
}

export function openMenu(x: number, y: number, items: MenuEntry[]) {
  setState({ menu: { x, y, items } })
}

/** For a clip (already selected): edit, split, attributes, sound, compound, export. */
export function clipMenu(): MenuEntry[] {
  const s = getState()
  const sel = s.selection
  const one = sel.length === 1 ? findClip(s.snap, sel[0]) : undefined
  const media = one && mediaById(s.snap, one.clip.mediaId)
  const t = s.positionUs
  const underPlayhead = sel.some((id) => {
    const c = findClip(s.snap, id)?.clip
    return c && t > c.startUs && t < c.startUs + c.durationUs
  })
  // A sound clip (on a sound track, not the main one): its track's voice can go to Director.
  const soundClip = sel.map((id) => findClip(s.snap, id)).find((f) => f && f.track.kind === 'audio' && !f.track.main)
  // A video's own sound, on any layer (it was the main track only).
  const soundHere = one?.track.kind === 'video' && media?.kind === 'video' && media.hasAudio
  // Clips that speak, for Change voice…: sound clips, and video clips whose own sound plays.
  const speaking = sel.filter((id) => {
    const f = findClip(s.snap, id)
    const m = f && mediaById(s.snap, f.clip.mediaId)
    if (!f || !m || m.missing || f.clip.busy) return false
    return f.track.kind === 'audio' ? m.kind === 'audio' || m.hasAudio : m.kind === 'video' && m.hasAudio && !f.clip.detached
  })
  // Sentences a voice dub spoke (each its own sound clip): Reroll voice says them again.
  const dubbed = dubbedLines(s.snap, sel).reduce((n, d) => n + d.lineIds.length, 0)
  // Text is being removed from it: nothing else until that's done.
  const busy = one?.clip.busy
  if (busy && s.dubJobs[busy]) return [{ label: 'Show the dub', run: () => openDub({ mediaId: one!.clip.mediaId, clipId: one!.clip.id }) }, { label: 'Cancel dub', run: () => cancelDub(busy) }, ...(s.dubJobs[busy].needsClaude ? [{ label: 'Try again', run: () => void retryDub(busy) }] : [])]
  if (busy) return [{ label: 'Cancel text removal', run: () => cancelTextRemoval(busy) }]
  return [
    { label: 'Cut', keys: keysFor('cut'), run: () => cut() },
    { label: 'Copy', keys: keysFor('copy'), run: () => copy() },
    { label: 'Paste', keys: keysFor('paste'), run: () => paste(), disabled: s.clipboard?.kind !== 'clips' && s.clipboard?.kind !== 'media' },
    { label: 'Delete', keys: keysFor('del'), run: deleteSelection },
    'sep',
    { label: 'Split at playhead', keys: keysFor('split'), run: splitAtPlayhead, disabled: !underPlayhead },
    ...(one && (media?.kind === 'audio' || media?.hasAudio)
      ? [{ label: 'Edit in Audio', run: () => editInAudio(one.clip.id) } as MenuEntry]
      : []),
    'sep',
    { label: 'Copy attributes', keys: keysFor('copyAttr'), run: copyAttributes, disabled: sel.length !== 1 },
    { label: 'Paste attributes', keys: keysFor('pasteAttr'), run: pasteAttributes, disabled: !s.attributes },
    'sep',
    one?.clip.detached
      ? { label: 'Restore its sound', run: () => call('clip.set', { clipId: one.clip.id, detached: false }) }
      : { label: 'Extract audio', keys: keysFor('extract'), run: extractAudio, disabled: !soundHere },
    { label: 'Create compound clip', keys: keysFor('compound'), run: makeCompound, disabled: sel.length < 2 },
    ...(one?.track.main && media?.kind === 'video' ? [{ label: 'Remove text with Vmake…', run: () => openVmake({ mediaId: media.id, clipId: one.clip.id }) }] : []),
    ...(one?.track.main && media?.kind === 'video' ? [{ label: 'Dub…', run: () => openDub({ mediaId: media.id, clipId: one.clip.id }) }] : []),
    ...(speaking.length ? [{ label: 'Change voice…', run: () => openChangeVoice({ clipIds: speaking }) }] : []),
    // One sentence a translation or a dub said: its words, to change and have said again.
    ...(one && (dubbed || isTranslatedLine(one.clip.id)) ? [{ label: 'Change words said…', run: () => openChangeWords(one.clip.id) }] : []),
    ...(dubbed ? [{ label: dubbed === 1 ? 'Reroll voice' : `Reroll voice (${dubbed} sentences)`, run: () => void rerollClips(sel) }] : []),
    ...(sel.some(isCompound) ? [{ label: 'Break compound clip', keys: keysFor('breakCompound'), run: breakCompound }] : []),
    'sep',
    // A voice's phrases (the clips of its sound track) to Director, which makes the ad from them.
    ...(soundClip ? [{ label: 'Send to Director…', keys: keysFor('director'), run: () => askDirector(soundClip.clip.id) }] : []),
    { label: `Export ${sel.length === 1 ? 'this clip' : `these ${sel.length} clips`}…`, run: exportSelection },
  ]
}

/** For empty space on the timeline. */
export function timelineMenu(): MenuEntry[] {
  const s = getState()
  return [
    { label: 'Paste', keys: keysFor('paste'), run: () => paste(), disabled: !s.clipboard },
    { label: 'Select all', keys: keysFor('all'), run: selectAll, disabled: !s.snap?.durationUs },
  ]
}

/** For library items (already picked). */
export function libraryMenu(): MenuEntry[] {
  const s = getState()
  const picked = s.snap?.project.media.filter((m) => s.libraryPicked.includes(m.id)) ?? []
  const addable = picked.filter((m) => !m.missing)
  return [
    {
      label: picked.length > 1 ? `Add ${addable.length} to the timeline` : 'Add to the timeline',
      run: async () => {
        for (const m of addable) await call('timeline.insert', { mediaId: m.id })
      },
      disabled: !addable.length,
    },
    'sep',
    { label: 'Cut', keys: keysFor('cut'), run: () => cut() },
    { label: 'Copy', keys: keysFor('copy'), run: () => copy() },
    { label: 'Paste', keys: keysFor('paste'), run: () => paste(), disabled: !(s.clipboard?.kind === 'media' && s.clipboard.cut) },
    'sep',
    { label: picked.length > 1 ? `Remove ${picked.length} from the library` : 'Remove from the library', keys: keysFor('del'), run: () => removeFromLibrary(picked.map((m) => m.id)) },
    ...(picked.length === 1 && picked[0].kind === 'video' && !picked[0].missing ? [{ label: 'Remove text with Vmake…', run: () => openVmake({ mediaId: picked[0].id }) }] : []),
    ...(addable.some((m) => m.kind === 'audio' || m.hasAudio) ? [{ label: 'Change voice…', run: () => openChangeVoice({ mediaIds: addable.filter((m) => m.kind === 'audio' || m.hasAudio).map((m) => m.id) }) }] : []),
    ...(picked.length === 1 ? [{ label: window.studio.platform === 'darwin' ? 'Show in Finder' : window.studio.platform === 'win32' ? 'Show in Explorer' : 'Show in Files', run: () => window.studio.app.showItem(picked[0].path) }] : []),
  ]
}

export function ContextMenu() {
  const menu = useStore((s) => s.menu)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })

  // Keep it on screen.
  useLayoutEffect(() => {
    if (!menu || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    setPos({ x: Math.min(menu.x, innerWidth - r.width - 4), y: Math.min(menu.y, innerHeight - r.height - 4) })
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const close = () => setState({ menu: null })
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
    window.addEventListener('blur', close)
    window.addEventListener('wheel', close, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('wheel', close, true)
    }
  }, [menu])

  if (!menu) return null
  return (
    <div className="menu-list context-menu" role="menu" ref={ref} style={{ left: pos.x || menu.x, top: pos.y || menu.y }} onContextMenu={(e) => e.preventDefault()}>
      {menu.items.map((e, i) =>
        e === 'sep' ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={e.disabled}
            onClick={() => {
              setState({ menu: null })
              e.run()
            }}
          >
            <span>{e.label}</span>
            {e.keys && <kbd>{keysLabel(e.keys)}</kbd>}
          </button>
        ),
      )}
    </div>
  )
}
