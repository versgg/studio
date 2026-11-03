import { actionFor } from './keymap'
import { getState, setState } from './store'

/** App-wide keys, from the keymap (keymap.ts). Typing in a field, or an open dialog, takes precedence. */
export function installShortcuts(): () => void {
  const onKey = (e: KeyboardEvent) => {
    const s = getState()
    const el = e.target as HTMLElement | null
    const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) && (el as HTMLInputElement).type !== 'range'
    if (s.dialog) {
      if (e.key === 'Escape' && !s.recordingKeys) setState({ dialog: null })
      return
    }
    if (typing || s.recordingKeys) return
    const a = actionFor(e)
    if (!a?.run) return
    // Space on a focused button would click it, and Alt alone opens nothing here.
    e.preventDefault()
    a.run()
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}
