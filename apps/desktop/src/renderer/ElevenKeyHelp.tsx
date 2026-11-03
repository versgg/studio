// Where to make an ElevenLabs key and what it must be allowed to do. Shown next to every
// place Studio asks for the key.

import { useState } from 'react'
import { ELEVEN_EXTRA, ELEVEN_KEYS_URL, ELEVEN_PERMISSIONS } from '../shared/eleven-permissions'
import './eleven-key-help.css'

export function ElevenKeyHelp({ open: startOpen = false }: { open?: boolean }) {
  const [open, setOpen] = useState(startOpen)
  return (
    <div className="ekh">
      <div className="ekh-line">
        <button type="button" className="ekh-link" onClick={() => window.studio.app.openExternal(ELEVEN_KEYS_URL)}>
          Create a key on elevenlabs.io
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9.5 2.5h4v4 M13.5 2.5L8 8 M11.5 9.5v4h-9v-9h4" />
          </svg>
        </button>
        <button type="button" className="ekh-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Which permissions?'}
        </button>
      </div>
      {open && (
        <div className="ekh-box">
          <p>
            Keys are restricted by default. Under <strong>Restrict key</strong>, set these, or the parts of Studio next to them won't work:
          </p>
          <table>
            <tbody>
              {ELEVEN_PERMISSIONS.map((p) => (
                <tr key={p.name}>
                  <th scope="row">{p.name}</th>
                  <td className="lvl">{p.level}</td>
                  <td>{p.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="ekh-sub">
            If your key settings also list {ELEVEN_EXTRA.map((p) => `“${p.name}”`).join(' and ')}, turn those on too. Everything else can stay off. A monthly credit limit on the key is a good idea.
          </p>
        </div>
      )}
    </div>
  )
}
