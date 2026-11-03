// Dialogs from the File, View and Help menus: Save as, Versions, saved workspaces, Getting
// started, What's new, Report a problem, Preferences, the agent connection, and the
// approval an agent asks for before it exports.

import { useEffect, useState, type ReactNode } from 'react'
import { ElevenKeyHelp } from './ElevenKeyHelp'
import { keysFor } from './keymap'
import {
  applyWorkspace,
  call,
  deleteWorkspace,
  getState,
  openProjectAt,
  saveWorkspace,
  setLayout,
  setState,
  toast,
  useStore,
  workspaces,
  type Layout,
} from './store'
import './project-dialogs.css'

function Frame({ title, children, foot, wide }: { title: string; children: ReactNode; foot?: ReactNode; wide?: boolean }) {
  const close = () => setState({ dialog: null })
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className={`pd${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="pd-head">
          <h2>{title}</h2>
          <button type="button" className="pd-x" aria-label="Close" onClick={close}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <path d="M3.5 3.5l9 9 M12.5 3.5l-9 9" />
            </svg>
          </button>
        </div>
        <div className="pd-body">{children}</div>
        {foot && <div className="pd-foot">{foot}</div>}
      </div>
    </div>
  )
}
const close = () => setState({ dialog: null })

export function SaveAsDialog() {
  const snap = useStore((s) => s.snap)
  const [name, setName] = useState(`${snap?.project.name ?? 'Untitled'} copy`)
  const [busy, setBusy] = useState(false)
  const go = async (pick: boolean) => {
    if (!snap) return
    setBusy(true)
    try {
      const dir = await window.studio.app.saveProjectAs(snap.dir, name, pick)
      if (dir) {
        await openProjectAt(dir)
        toast(`Saved as “${name}”. You're working in the copy now.`)
        close()
      }
    } catch (e) {
      toast(`Couldn't save the copy: ${(e as Error).message}`, 'error')
    }
    setBusy(false)
  }
  return (
    <Frame
      title="Save as"
      foot={
        <>
          <span className="pd-note">A full copy, with its media links, history and caches.</span>
          <button type="button" className="pd-btn" onClick={() => go(true)} disabled={busy || !name.trim()}>
            Choose folder…
          </button>
          <button type="button" className="pd-btn primary" onClick={() => go(false)} disabled={busy || !name.trim()}>
            Save copy
          </button>
        </>
      }
    >
      <label className="pd-field">
        <span>Name</span>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go(false)} spellCheck={false} />
      </label>
    </Frame>
  )
}

export function VersionsDialog() {
  const snap = useStore((s) => s.snap)
  const [list, setList] = useState<{ file: string; name: string; saved: number }[]>([])
  const [name, setName] = useState('')
  const dir = snap?.dir ?? ''
  const reload = () => dir && window.studio.app.versions(dir).then(setList)
  useEffect(() => {
    reload()
  }, [dir])
  const save = async () => {
    const n = name.trim() || new Date().toLocaleString('sv-SE').slice(0, 16)
    await window.studio.app.saveVersion(dir, n)
    setName('')
    reload()
    toast(`Version “${n}” saved`)
  }
  const restore = async (file: string, label: string) => {
    await window.studio.app.restoreVersion(dir, file)
    await openProjectAt(dir)
    toast(`Restored “${label}”. What was there is kept as a version too.`)
    reload()
  }
  return (
    <Frame title="Versions" wide>
      <div className="pd-row">
        <input className="pd-input" placeholder="Name this version (for example: Before the music)" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} spellCheck={false} />
        <button type="button" className="pd-btn primary" onClick={save}>
          Save this version
        </button>
      </div>
      {list.length === 0 ? (
        <p className="pd-note">No saved versions yet. A version is a snapshot of the edit you can go back to; undo history keeps working as usual.</p>
      ) : (
        <ul className="pd-list">
          {list.map((v) => (
            <li key={v.file}>
              <span className="pd-list-name">{v.name}</span>
              <span className="pd-list-meta">{new Date(v.saved).toLocaleString('sv-SE').slice(0, 16)}</span>
              <button type="button" className="pd-link" onClick={() => restore(v.file, v.name)}>
                Restore
              </button>
              <button
                type="button"
                className="pd-link"
                onClick={async () => {
                  await window.studio.app.deleteVersion(dir, v.file)
                  reload()
                }}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </Frame>
  )
}

export function SaveLayoutDialog() {
  const layout = useStore((s) => s.layout)
  const [name, setName] = useState('')
  const save = () => {
    const n = name.trim()
    if (!n) return
    saveWorkspace(n)
    toast(`Layout “${n}” saved. It's under View › Workspace.`)
    close()
  }
  return (
    <Frame
      title="Save this layout"
      foot={
        <button type="button" className="pd-btn primary" onClick={save} disabled={!name.trim()}>
          Save
        </button>
      }
    >
      <label className="pd-field">
        <span>Name</span>
        <input autoFocus placeholder={`My ${layout} layout`} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} spellCheck={false} />
      </label>
      <p className="pd-note">Keeps the arrangement, the panel sizes and which panels are hidden.</p>
    </Frame>
  )
}

export function WorkspacesDialog() {
  useStore((s) => s.workspaceTick)
  const list = workspaces()
  return (
    <Frame title="Manage workspaces">
      {list.length === 0 ? (
        <p className="pd-note">No saved layouts yet. Arrange the panels, then View › Workspace › Save this layout.</p>
      ) : (
        <ul className="pd-list">
          {list.map((w) => (
            <li key={w.name}>
              <span className="pd-list-name">{w.name}</span>
              <span className="pd-list-meta">{w.layout}</span>
              <button type="button" className="pd-link" onClick={() => applyWorkspace(w.name)}>
                Use
              </button>
              <button type="button" className="pd-link" onClick={() => deleteWorkspace(w.name)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </Frame>
  )
}

export function StartDialog() {
  const steps: [string, string][] = [
    ['Bring in your clips', `Import (${keysFor('import')}), or drop files and whole folders on the library. A dropped folder stays linked and shows as a map.`],
    ['Put them on the timeline', 'Double-click a clip, or drag it down. The main track closes gaps by itself (the magnet, P).'],
    ['Cut', `Split at the playhead (${keysFor('split')}), delete left and right of it (${keysFor('deleteLeft')} / ${keysFor('deleteRight')}), or press B for the split tool.`],
    ['Shape the look', 'Pick a clip and use the Inspector: transform, speed, colour, masks. Drag it on the player to move it.'],
    ['Add text, stickers, sound', 'From the library tabs. Each lands on its own track at the playhead.'],
    ['Captions', 'Library › Captions makes them from the voiceover with your ElevenLabs key.'],
    ['Export', `Export (${keysFor('export')}) renders every format you tick, with the sound levelled for social.`],
  ]
  return (
    <Frame title="Getting started" wide>
      <ol className="pd-steps">
        {steps.map(([h, t]) => (
          <li key={h}>
            <strong>{h}</strong>
            <span>{t}</span>
          </li>
        ))}
      </ol>
      <p className="pd-note">
        Every shortcut: {keysFor('keys')}.{' '}
        <button type="button" className="pd-link" onClick={() => setState({ dialog: 'shortcuts' })}>
          Open the list
        </button>
      </p>
    </Frame>
  )
}

const NEWS: [string, string[]][] = [
  ['27 October 2026', ['Text, stickers, overlays and adjustment layers on their own tracks', 'Transitions on cuts, video effects, looks, HSL, curves, wheels and LUTs', 'Captions from your voiceover, .srt export', 'Masks, background removal and auto reframe', 'Home, Save as, Versions, saved layouts, Preferences', 'An MCP connection for Claude']],
  ['26 October 2026', ['The editor rebuilt to the design: layouts, player, timeline, export, shortcuts', 'The Audio page: effects, envelopes, loudness, fix and tidy', 'Transform, colour, speed, reverse, keyframes and freeze frame', 'Linked folders, Vmake text removal, ElevenLabs voiceovers and recording']],
]

export function WhatsNewDialog() {
  return (
    <Frame title="What’s new" wide>
      {NEWS.map(([date, items]) => (
        <section key={date} className="pd-news">
          <h3>{date}</h3>
          <ul>
            {items.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </section>
      ))}
    </Frame>
  )
}

export function ReportDialog() {
  const caps = useStore((s) => s.caps)
  const snap = useStore((s) => s.snap)
  const [text, setText] = useState('')
  const details = [
    `What happened: ${text.trim() || '(not written)'}`,
    '',
    `Studio build: ${new Date().toISOString().slice(0, 10)} · ${window.studio.platform}`,
    `FFmpeg: ${caps?.ffmpeg ?? 'not found'}`,
    `Encoders: ${caps?.encoders?.join(', ') || 'none'}`,
    `Sound output: ${caps?.audioDevice ?? 'none'}`,
    `Project: ${snap?.project.name ?? 'none'} (${snap?.project.width}×${snap?.project.height}, ${snap?.project.tracks.reduce((n, t) => n + t.clips.length, 0) ?? 0} clips)`,
    `User agent: ${navigator.userAgent}`,
  ].join('\n')
  return (
    <Frame
      title="Report a problem"
      wide
      foot={
        <>
          <span className="pd-note">Copies the details to the clipboard, ready to paste wherever you report it.</span>
          <button
            type="button"
            className="pd-btn primary"
            onClick={async () => {
              await navigator.clipboard.writeText(details)
              toast('Copied the report')
            }}
          >
            Copy report
          </button>
        </>
      }
    >
      <label className="pd-field col">
        <span>What happened, and what you expected</span>
        <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <pre className="pd-pre">{details}</pre>
    </Frame>
  )
}

const KEY_NAMES: [string, string][] = [
  ['elevenlabs', 'ElevenLabs (voiceovers, the voice changer)'],
  ['vmake', 'Vmake (text removal)'],
]

/** Paste a key; it goes straight to the main process and is stored encrypted there. */
function KeyInput({ name, onSaved }: { name: string; onSaved: () => void }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const save = async () => {
    const r = await window.studio.services.setKey(name as never, value.trim())
    setValue('')
    if (r.error) setError(r.error)
    else {
      setError('')
      toast('Key stored')
      onSaved()
    }
  }
  return (
    <div className="pd-row">
      <input className="pd-input" type="password" placeholder="Paste the key" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && value.trim() && save()} autoComplete="off" spellCheck={false} />
      <button type="button" className="pd-btn" onClick={save} disabled={!value.trim()}>
        Save
      </button>
      {error && <span className="pd-note">{error}</span>}
    </div>
  )
}

export function PrefsDialog() {
  const layout = useStore((s) => s.layout)
  const waves = useStore((s) => s.showWaveforms)
  const thumbs = useStore((s) => s.showThumbnails)
  const caps = useStore((s) => s.caps)
  const [keys, setKeys] = useState<Record<string, boolean>>({})
  useEffect(() => {
    window.studio.services.keys().then((k) => setKeys(k as Record<string, boolean>))
  }, [])
  const forget = async (name: string) => {
    await window.studio.services.clearKey(name as never)
    setKeys(await window.studio.services.keys())
    toast('Key removed')
  }
  return (
    <Frame title="Preferences" wide>
      <div className="pd-grid">
        <span>Layout</span>
        <div className="seg-pill">
          {(['ads', 'standard', 'review'] as Layout[]).map((l) => (
            <button key={l} type="button" className={l === layout ? 'on' : ''} onClick={() => setLayout(l)}>
              {l[0].toUpperCase() + l.slice(1)}
            </button>
          ))}
        </div>
        <span>Timeline</span>
        <div className="pd-checks">
          <label>
            <input type="checkbox" checked={waves} onChange={() => setState({ showWaveforms: !waves })} /> Show waveforms
          </label>
          <label>
            <input type="checkbox" checked={thumbs} onChange={() => setState({ showThumbnails: !thumbs })} /> Show thumbnails
          </label>
        </div>
        <span>Projects folder</span>
        <div className="pd-row">
          <span className="pd-path" title={caps?.projectsDir}>
            {caps?.projectsDir}
          </span>
          <button type="button" className="pd-btn" onClick={() => caps?.projectsDir && window.studio.app.openFolder(caps.projectsDir)}>
            Open
          </button>
        </div>
        <span>Keys</span>
        <div className="pd-keys">
          {KEY_NAMES.map(([k, label]) => (
            <div key={k} className="pd-key">
              <div className="pd-row">
                <span className="pd-list-name">{label}</span>
                <span className="pd-list-meta">{keys[k] ? 'Stored, encrypted on this computer' : 'Not set'}</span>
                {keys[k] && (
                  <button type="button" className="pd-link" onClick={() => forget(k)}>
                    Remove
                  </button>
                )}
              </div>
              {!keys[k] && <KeyInput name={k} onSaved={async () => setKeys(await window.studio.services.keys())} />}
              {k === 'elevenlabs' && <ElevenKeyHelp />}
            </div>
          ))}
        </div>
        <span>Shortcuts</span>
        <div>
          <button type="button" className="pd-btn" onClick={() => setState({ dialog: 'shortcuts' })}>
            Keyboard shortcuts…
          </button>
        </div>
      </div>
    </Frame>
  )
}

/** The agent connection: is an agent connected, how to connect one, and what it may do. */
export function McpDialog() {
  const snap = useStore((s) => s.snap)
  const [status, setStatus] = useState<{ clients?: number; lastSeen?: string } | null>(null)
  const [cmd, setCmd] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    const poll = () => call<{ clients: number; lastSeen?: string }>('mcp.status').then((s) => live && setStatus(s ?? null))
    poll()
    const t = window.setInterval(poll, 2000)
    window.studio.app.mcpCommand?.().then((c: string | null) => live && setCmd(c))
    return () => {
      live = false
      window.clearInterval(t)
    }
  }, [])
  const mcp = snap?.project.mcp ?? { allowed: 'all', askBeforeExport: true }
  const set = (patch: Partial<typeof mcp>) => call('project.setOptions', { mcp: { ...mcp, ...patch } })
  return (
    <Frame title="Agent connection (MCP)" wide>
      <div className="pd-grid">
        <span>Status</span>
        <span>{status ? (status.clients ? `${status.clients} agent${status.clients === 1 ? '' : 's'} connected` : 'No agent connected right now') : 'The engine is starting…'}</span>
        <span>Connect Claude Code</span>
        <div className="pd-row">
          <code className="pd-code">{cmd ?? 'claude mcp add studio -- studio-mcp'}</code>
          <button
            type="button"
            className="pd-btn"
            onClick={async () => {
              await navigator.clipboard.writeText(cmd ?? 'claude mcp add studio -- studio-mcp')
              toast('Copied the command')
            }}
          >
            Copy
          </button>
        </div>
        <span>Allowed to</span>
        <div className="seg-pill">
          {(
            [
              ['all', 'Edit, import, export'],
              ['edit', 'Edit only'],
              ['look', 'Only look'],
            ] as const
          ).map(([v, l]) => (
            <button key={v} type="button" className={mcp.allowed === v ? 'on' : ''} onClick={() => set({ allowed: v })}>
              {l}
            </button>
          ))}
        </div>
        <span>Ask before export</span>
        <label className="pd-checks">
          <input type="checkbox" checked={mcp.askBeforeExport} onChange={() => set({ askBeforeExport: !mcp.askBeforeExport })} /> An agent's export waits for your OK
        </label>
      </div>
      <p className="pd-note">Edits an agent makes land in the History tab as “Claude · MCP”, and undo works on them like on yours.</p>
    </Frame>
  )
}

/** An agent asks to do something risky (export, removing media): Allow or Don't allow. */
export function ApprovalPrompt() {
  const approval = useStore((s) => s.approval)
  if (!approval) return null
  const answer = (ok: boolean) => {
    call('approval.answer', { id: approval.id, ok })
    setState({ approval: getState().approvalQueue[0] ?? null, approvalQueue: getState().approvalQueue.slice(1) })
  }
  return (
    <div className="modal-backdrop">
      <div className="pd" role="alertdialog" aria-modal="true" aria-label="An agent asks">
        <div className="pd-head">
          <h2>Claude asks to {approval.what}</h2>
        </div>
        <div className="pd-body">
          <p className="pd-text">{approval.detail}</p>
        </div>
        <div className="pd-foot">
          <span className="pd-note">Change this in View › Agent connection.</span>
          <button type="button" className="pd-btn" onClick={() => answer(false)}>
            Don’t allow
          </button>
          <button type="button" className="pd-btn primary" onClick={() => answer(true)}>
            Allow
          </button>
        </div>
      </div>
    </div>
  )
}
