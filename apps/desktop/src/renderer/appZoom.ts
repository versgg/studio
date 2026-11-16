// App zoom: Ctrl/Cmd+Shift + and − make everything bigger or smaller, Ctrl/Cmd+Shift+0 back to
// as designed (shared/app-zoom.ts). Caught before anything else on the page, typing included:
// the timeline has Ctrl/Cmd + and − alone, and the Audio page its own zoom keys.

import { nextZoom, zoomLabel, zoomOf } from '../shared/app-zoom'
import { keyChar } from './keyboardLayout'
import { toast } from './store'

let now = 1

/** The window's size now (1 as designed). */
export const appZoom = () => now

/** A step in (1), out (−1) or back to 100 % (0); the main process keeps it within what the screen fits. */
export async function zoomApp(dir: 1 | -1 | 0) {
  const r = await window.studio.app.setZoom(nextZoom(now, dir))
  now = r.factor
  toast(r.limited ? `Zoom ${zoomLabel(now)} (as big as this screen fits)` : `Zoom ${zoomLabel(now)}`)
}

/** Listens for the zoom keys (once, as the page starts), and picks up the size Studio was left at. */
export function installAppZoom() {
  void window.studio.app.getZoom().then((z) => (now = z))
  window.addEventListener(
    'keydown',
    (e) => {
      const dir = zoomOf(e, keyChar(e))
      if (dir === null) return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (!e.repeat || dir !== 0) void zoomApp(dir)
    },
    { capture: true },
  )
}
