import { useEffect, useRef, useState, type ReactNode } from 'react'
import { FORMATS } from './format'
import { Icon } from './icons'
import type { VmakeAccount } from '../shared/api'
import { vmakeCheck, vmakeHasToken, vmakeKnown, vmakeTokenSet } from './vmakeAccount'
import { CloneDialogBody, DesignDialogBody, VoicePickerDialog } from './AudioPanel'
import { ExportDialog } from './ExportDialog'
import { McpDialog, PrefsDialog, ReportDialog, SaveAsDialog, SaveLayoutDialog, StartDialog, VersionsDialog, WhatsNewDialog, WorkspacesDialog } from './ProjectDialogs'
import { ShortcutsDialog } from './ShortcutsDialog'
import { call, fileUrl, findClip, importPaths, mediaById, newProject, removeText, setState, useStore, type Crop } from './store'

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
  }, [])
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header>
          <h2>{title}</h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        {children}
      </div>
    </div>
  )
}

const close = () => setState({ dialog: null, exportClips: null })

export function Dialogs() {
  const dialog = useStore((s) => s.dialog)
  if (dialog === 'export') return <ExportDialog />
  if (dialog === 'saveAs') return <SaveAsDialog />
  if (dialog === 'versions') return <VersionsDialog />
  if (dialog === 'saveLayout') return <SaveLayoutDialog />
  if (dialog === 'workspaces') return <WorkspacesDialog />
  if (dialog === 'start') return <StartDialog />
  if (dialog === 'whatsNew') return <WhatsNewDialog />
  if (dialog === 'report') return <ReportDialog />
  if (dialog === 'prefs') return <PrefsDialog />
  if (dialog === 'mcp') return <McpDialog />
  if (dialog === 'new') return <NewProjectDialog />
  if (dialog === 'shortcuts') return <ShortcutsDialog />
  if (dialog === 'about') return <AboutDialog />
  if (dialog === 'crop') return <CropDialog />
  if (dialog === 'vmake') return <VmakeDialog />
  if (dialog === 'voices')
    return (
      <Modal title="Choose a voice" onClose={close} wide>
        <VoicePickerDialog close={close} />
      </Modal>
    )
  if (dialog === 'clone')
    return (
      <Modal title="Clone a voice" onClose={close} wide>
        <CloneDialogBody close={close} />
      </Modal>
    )
  if (dialog === 'design')
    return (
      <Modal title="Design a voice" onClose={close} wide>
        <DesignDialogBody close={close} />
      </Modal>
    )
  return null
}

/**
 * Text removal with Vmake, on the user's own Vmake account and credits. It opens ready: the
 * models, prices and balance as last seen (vmakeAccount.ts), while the account is checked in
 * the background and anything new from Vmake slots in.
 */
function VmakeDialog() {
  const snap = useStore((s) => s.snap)
  const target = useStore((s) => s.vmakeTarget)
  const [hasKey, setHasKey] = useState<boolean | null>(vmakeHasToken)
  const [token, setToken] = useState('')
  const [account, setAccount] = useState<VmakeAccount | null>(vmakeKnown)
  const [error, setError] = useState('')
  const [model, setModel] = useState('full')
  const media = target && mediaById(snap, target.mediaId)
  const clip = target?.clipId ? findClip(snap, target.clipId)?.clip : undefined
  const seconds = (clip?.durationUs ?? media?.durationUs ?? 0) / 1e6

  const check = async () => {
    setError('')
    const r = await vmakeCheck()
    if ('error' in r) {
      setError(r.auth ? r.error : `Couldn't check the account just now: ${r.error}`)
      if (r.auth) setHasKey(false)
    } else setAccount(r)
  }
  useEffect(() => {
    if (!account) window.studio.services.vmakeKnown().then((a) => setAccount((now) => now ?? a))
    window.studio.services.keys().then((k) => {
      setHasKey(k.vmake)
      vmakeTokenSet(k.vmake)
      if (k.vmake) check()
    })
  }, [])

  const save = async () => {
    const r = await window.studio.services.setKey('vmake', token)
    if (r.error) return setError(r.error)
    setToken('')
    setHasKey(true)
    vmakeTokenSet(true)
    await check()
  }
  const forget = async () => {
    await window.studio.services.clearKey('vmake')
    setHasKey(false)
    vmakeTokenSet(false)
  }
  const price = account?.prices[model]
  const tooLong = !!price?.durationLimit && seconds > price.durationLimit
  const short = !!account && price?.credits != null && account.balance != null && account.balance < price.credits
  const start = () => {
    if (!target) return
    removeText(target, model)
    close()
  }
  if (!media) return null
  return (
    <Modal title="Remove text with Vmake" onClose={close} wide>
      <div className="modal-body">
        <p className="hint" style={{ margin: 0 }}>
          {clip ? `Sends the ${seconds.toFixed(1)} s this clip uses` : `Sends all of ${media.name} (${seconds.toFixed(1)} s)`} to Vmake on your own account. The cleaned copy {clip ? 'replaces it on the timeline' : 'joins the library'}; Ctrl+Z goes back. It carries on if you close the project, and picks up again when Studio starts.
        </p>
        {hasKey === false && (
          <div className="field-block">
            <span className="field-label">Your Vmake access token</span>
            <div className="folder-row">
              <input className="text-input" style={{ flex: 1 }} type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste the access-token header from vmake.ai" spellCheck={false} autoComplete="off" data-autofocus />
              <button type="button" className="button" onClick={save} disabled={!token.trim()}>
                Save
              </button>
            </div>
            <p className="hint">vmake.ai while signed in → F12 → Network → any request to wapi.vmake.ai → Request Headers → copy access-token. Studio keeps it encrypted on this computer.</p>
          </div>
        )}
        {hasKey && (
          <div className="field-block">
            <span className="field-label">Removal</span>
            <div className="choice-list" role="radiogroup" aria-label="Removal model">
              {Object.entries(account?.models ?? {}).map(([key, m]) => {
                const p = account?.prices[key]
                return (
                  <button key={key} type="button" role="radio" aria-checked={model === key} className={model === key ? 'on' : ''} onClick={() => setModel(key)} disabled={!p}>
                    <span className="choice-name">{m.name}</span>
                    <span className="choice-note">{m.note}</span>
                    <span className="choice-meta">
                      {!p ? 'Not offered now' : p.credits != null ? `${p.credits} credits` : ''}
                      {p?.durationLimit ? ` · up to ${Math.round(p.durationLimit / 60)} min` : ''}
                    </span>
                  </button>
                )
              })}
            </div>
            {tooLong && <p className="error">{account?.models[model]?.name} takes videos up to {Math.round((price?.durationLimit ?? 0) / 60)} min; this is {Math.ceil(seconds / 60)}. Split it or pick another model.</p>}
            {short && <p className="error">That costs {price?.credits} credits and the account has {account?.balance}.</p>}
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </div>
      <footer>
        <span className="footer-note">
          {hasKey && account?.balance != null ? `Balance: ${account.balance} credits` : ''}
          {hasKey && (
            <button type="button" className="link-button" style={{ marginLeft: 10 }} onClick={forget}>
              Use another token
            </button>
          )}
        </span>
        <button type="button" className="button" onClick={close}>
          Cancel
        </button>
        <button type="button" className="button primary" onClick={start} disabled={!hasKey || !price || tooLong || short}>
          {price?.credits != null ? `Remove text · ${price.credits} credits` : 'Remove text'}
        </button>
      </footer>
    </Modal>
  )
}

const CROP_RATIOS: [string, number | null][] = [
  ['Free', null],
  ['9:16', 9 / 16],
  ['4:5', 4 / 5],
  ['1:1', 1],
  ['16:9', 16 / 9],
]
type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** Crop: a box over the clip's frame. Rotation and mirroring apply after it. */
function CropDialog() {
  const snap = useStore((s) => s.snap)
  const id = useStore((s) => s.cropClip)
  const found = id ? findClip(snap, id) : undefined
  const media = found && mediaById(snap, found.clip.mediaId)
  const [box, setBox] = useState<Crop>(found?.clip.crop ?? { x: 0, y: 0, w: 1, h: 1 })
  const [ratio, setRatio] = useState<number | null>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ handle: Handle; x: number; y: number; start: Crop } | null>(null)
  if (!found || !media) return null
  const imgAspect = media.width && media.height ? media.width / media.height : 9 / 16
  const k = (r: number) => r / imgAspect // width : height of a ratio-r box, in frame fractions

  const fitted = (b: Crop): Crop => {
    let { x, y, w, h } = b
    w = Math.min(1, Math.max(0.05, w))
    h = Math.min(1, Math.max(0.05, h))
    return { x: Math.min(1 - w, Math.max(0, x)), y: Math.min(1 - h, Math.max(0, y)), w, h }
  }
  const pickRatio = (r: number | null) => {
    setRatio(r)
    if (r == null) return
    // The largest box of that shape, centred on the current one.
    const kr = k(r)
    const w = kr <= 1 ? kr : 1
    const h = kr <= 1 ? 1 : 1 / kr
    const cx = box.x + box.w / 2
    const cy = box.y + box.h / 2
    setBox(fitted({ x: cx - w / 2, y: cy - h / 2, w, h }))
  }
  const onDown = (handle: Handle) => (e: React.PointerEvent) => {
    e.stopPropagation()
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {}
    dragRef.current = { handle, x: e.clientX, y: e.clientY, start: box }
  }
  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    const rect = frameRef.current?.getBoundingClientRect()
    if (!d || !rect) return
    const dx = (e.clientX - d.x) / rect.width
    const dy = (e.clientY - d.y) / rect.height
    const s = d.start
    if (d.handle === 'move') {
      setBox(fitted({ ...s, x: s.x + dx, y: s.y + dy }))
      return
    }
    let { x, y, w, h } = s
    if (d.handle.includes('e')) w = s.w + dx
    if (d.handle.includes('w')) {
      w = s.w - dx
      x = s.x + dx
    }
    if (d.handle.includes('s')) h = s.h + dy
    if (d.handle.includes('n')) {
      h = s.h - dy
      y = s.y + dy
    }
    if (ratio != null) {
      // Keep the shape: the side being dragged leads, the other follows.
      const kr = k(ratio)
      if (d.handle === 'n' || d.handle === 's') w = h * kr
      else h = w / kr
      if (d.handle.includes('n')) y = s.y + s.h - h
      if (d.handle === 'n' || d.handle === 's') x = s.x + (s.w - w) / 2
      if (d.handle === 'e' || d.handle === 'w') y = s.y + (s.h - h) / 2
      if (w > 1 || h > 1 || w < 0.05 || h < 0.05) return
    }
    setBox(fitted({ x, y, w, h }))
  }
  const onUp = () => {
    dragRef.current = null
  }
  const apply = () => {
    call('clip.set', { clipId: found.clip.id, crop: box })
    close()
  }
  const reset = () => {
    setBox({ x: 0, y: 0, w: 1, h: 1 })
    setRatio(null)
  }
  const pct = (n: number) => `${n * 100}%`
  return (
    <Modal title="Crop" onClose={close} wide>
      <div className="modal-body">
        <div className="crop-stage" onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <div className="crop-frame" ref={frameRef} style={{ width: Math.min(508, 440 * imgAspect), height: Math.min(508, 440 * imgAspect) / imgAspect }}>
            {media.poster && <img src={fileUrl(media.poster)} alt="" draggable={false} />}
            <div className="crop-box" style={{ left: pct(box.x), top: pct(box.y), width: pct(box.w), height: pct(box.h) }} onPointerDown={onDown('move')}>
              {(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as Handle[]).map((h) => (
                <span key={h} className={`crop-handle h-${h}`} onPointerDown={onDown(h)} />
              ))}
            </div>
          </div>
        </div>
        <div className="seg" role="group" aria-label="Crop shape">
          {CROP_RATIOS.map(([label, r]) => (
            <button key={label} type="button" className={ratio === r ? 'on' : ''} aria-pressed={ratio === r} onClick={() => pickRatio(r)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <footer>
        <span className="footer-note">
          {Math.round(box.w * media.width)} × {Math.round(box.h * media.height)} of {media.width} × {media.height}
        </span>
        <button type="button" className="button" onClick={reset}>
          Reset
        </button>
        <button type="button" className="button" onClick={close}>
          Cancel
        </button>
        <button type="button" className="button primary" onClick={apply} data-autofocus>
          Apply
        </button>
      </footer>
    </Modal>
  )
}


function NewProjectDialog() {
  const at = useStore((s) => s.newAt)
  const [name, setName] = useState(at?.name ?? 'Untitled')
  const [aspect, setAspect] = useState(at?.aspect ?? '9:16')
  // The offered name selected to type over, as the dialog opens.
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => field.current?.select(), [])
  const create = async () => {
    await newProject(name.trim() || at?.name || 'Untitled', aspect)
    setState({ newAt: null })
    if (at?.paths.length) importPaths(at.paths, 0)
  }
  return (
    <Modal title="New project" onClose={close}>
      <form
        className="modal-body"
        onSubmit={(e) => {
          e.preventDefault()
          create()
        }}
      >
        <label className="field-block">
          <span className="field-label">Name</span>
          <input ref={field} className="text-input" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} data-autofocus onFocus={(e) => e.target.select()} aria-label="Project name" />
        </label>
        <div className="field-block">
          <span className="field-label">Format</span>
          <div className="formats" role="group" aria-label="Project format">
            {FORMATS.map(([a, w, h]) => (
              <button key={a} type="button" className={aspect === a ? 'on' : ''} aria-pressed={aspect === a} onClick={() => setAspect(a)}>
                <span className="format-shape" style={{ aspectRatio: `${w} / ${h}` }} />
                <span className="format-name">{a}</span>
                <span className="format-size">
                  {w} × {h}
                </span>
              </button>
            ))}
          </div>
        </div>
        <footer>
          <span className="footer-note">Saved in Documents › Studio Projects</span>
          <button type="button" className="button" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="button primary">
            Create
          </button>
        </footer>
      </form>
    </Modal>
  )
}


function AboutDialog() {
  const caps = useStore((s) => s.caps)
  return (
    <Modal title="About this build" onClose={close}>
      <div className="modal-body">
        <dl className="stats">
          <div>
            <dt>Build</dt>
            <dd>Working version · Windows</dd>
          </div>
          <div>
            <dt>FFmpeg</dt>
            <dd>{caps?.ffmpeg ?? 'Not found'}</dd>
          </div>
          <div>
            <dt>Encoders</dt>
            <dd>{caps?.encoders?.join(', ') || '–'}</dd>
          </div>
          <div>
            <dt>Sound output</dt>
            <dd>{caps?.audioDevice ?? 'None'}</dd>
          </div>
          <div>
            <dt>Projects</dt>
            <dd title={caps?.projectsDir}>{caps?.projectsDir}</dd>
          </div>
        </dl>
      </div>
    </Modal>
  )
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  if (!toasts.length) return null
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast tone-${t.tone}`}>
          {t.text}
        </div>
      ))}
    </div>
  )
}
