// The keyboard shortcuts list (Menus.dc.html): start from another editor's keys, search,
// click a shortcut to press new keys for it, export the list as a text file.

import { useEffect, useState, useSyncExternalStore } from 'react'
import { ACTIONS, changed, comboOf, currentPreset, keymapText, keysFor, keysVersion, PRESETS, setKeys, setPreset, subscribeKeys, type Group } from './keymap'
import { setState } from './store'
import './shortcuts-dialog.css'

const GROUPS: Group[] = ['Timeline', 'Playback', 'Tools', 'Workspace', 'Edit', 'File']

export function ShortcutsDialog() {
  useSyncExternalStore(subscribeKeys, keysVersion)
  const [query, setQuery] = useState('')
  const [recording, setRecording] = useState<string | null>(null)
  const preset = currentPreset()
  const close = () => setState({ dialog: null })

  // While recording, the next key press (with its modifiers) becomes the shortcut.
  useEffect(() => {
    setState({ recordingKeys: !!recording })
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') return setRecording(null)
      const combo = comboOf(e)
      if (!combo) return
      setKeys(recording, combo)
      setRecording(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording])
  useEffect(() => () => setState({ recordingKeys: false }), [])

  const q = query.trim().toLowerCase()
  const match = (label: string, keys: string) => !q || label.toLowerCase().includes(q) || keys.toLowerCase().replace(/\s/g, '').includes(q.replace(/\s/g, ''))
  const exportFile = () => {
    const url = URL.createObjectURL(new Blob([keymapText()], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'Studio keyboard shortcuts.txt'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !recording && close()}>
      <section className="keys-dialog" role="dialog" aria-modal="true" aria-labelledby="keys-h">
        <div className="keys-head">
          <h2 id="keys-h">Keyboard shortcuts</h2>
          <span className="keys-from">Start from</span>
          <div className="keys-presets" role="group" aria-label="Shortcut preset">
            {PRESETS.map((p) => (
              <button key={p} type="button" className={p === preset ? 'on' : ''} aria-pressed={p === preset} onClick={() => setPreset(p)}>
                {p}
              </button>
            ))}
          </div>
          <span className="keys-spacer" />
          <div className="keys-search">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10z M14 14l-3.5-3.5" />
            </svg>
            <input type="search" aria-label="Search actions or keys" placeholder="Search actions or keys" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
          </div>
          <button type="button" className="keys-export" onClick={exportFile}>
            Export as file
          </button>
          <button type="button" className="keys-close" aria-label="Close" onClick={close}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <path d="M3.5 3.5l9 9 M12.5 3.5l-9 9" />
            </svg>
          </button>
        </div>
        <div className="keys-grid">
          {GROUPS.map((g) => {
            const rows = ACTIONS.filter((a) => a.group === g && match(a.label, keysFor(a.id)))
            if (!rows.length) return null
            return (
              <div key={g} className="keys-group">
                <h3>{g}</h3>
                {rows.map((a) => {
                  const keys = keysFor(a.id)
                  return (
                    <div key={a.id} className="keys-row">
                      <span className="keys-action">{a.label}</span>
                      {recording === a.id ? (
                        <span className="keys-recording">Press the new keys…</span>
                      ) : a.fixed ? (
                        <span className="keys-chips" title="A mouse gesture">
                          {keys.split('+').map((k, i) => (
                            <span key={i} className="kbd">
                              {k}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <button type="button" className="keys-chips" onClick={() => setRecording(a.id)} title="Click to change" aria-label={`Change the shortcut for ${a.label}, now ${keys || 'none'}`}>
                          {keys ? (
                            keys.split(/\+(?!$)/).map((k, i) => (
                              <span key={i} className={`kbd${changed(a.id) ? ' changed' : ''}`}>
                                {k}
                              </span>
                            ))
                          ) : (
                            <span className="kbd none">None</span>
                          )}
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
        <p className="keys-note">Click a shortcut, then press the new keys (Esc keeps the old ones). Keys another action had move to the new one. Shown for Windows and Linux; macOS swaps Ctrl for Cmd.</p>
      </section>
    </div>
  )
}
