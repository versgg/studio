// App zoom (Ctrl/Cmd+Shift + and −, Ctrl/Cmd+Shift+0): the whole window's size, in steps.
// Ctrl/Cmd + and − alone zoom the timeline, as in CapCut and Resolve (the user's choice, 2026-11-16).
// No imports: node --test runs this file (scripts/app-zoom.test.mjs).

/** The sizes the window goes through (1 is as designed). */
export const ZOOM_STEPS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

/** The next size from `now`, a step in (1) or out (−1), or back to 1 (0); never past `max`. */
export function nextZoom(now: number, dir: 1 | -1 | 0, max = Infinity): number {
  const steps = ZOOM_STEPS.filter((z) => z <= max + 1e-9)
  if (dir === 0) return 1
  if (dir > 0) return steps.find((z) => z > now + 1e-6) ?? steps[steps.length - 1]
  return [...steps].reverse().find((z) => z < now - 1e-6) ?? steps[0]
}

/**
 * Which way a key press zooms the app: 1 in, −1 out, 0 back to 1, null not at all. Ctrl or Cmd
 * with Shift, and the key by the character it types without Shift (`char`, from the keyboard's
 * layout): on Swedish and other Nordic keyboards + is where an American keyboard has − (its
 * code is Minus) and Shift makes it ?, so neither the code nor the typed key says which it is.
 */
export function zoomOf(e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; code: string; key: string }, char: string | null): 1 | -1 | 0 | null {
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return null
  if (e.code === 'NumpadAdd') return 1
  if (e.code === 'NumpadSubtract') return -1
  if (e.code === 'Numpad0' || e.code === 'Digit0') return 0
  if (char === '+' || char === '=') return 1
  if (char === '-') return -1
  if (char) return null
  // No layout to ask: what Shift made of the key. + on an American keyboard (Shift+=), ? on the
  // Nordic + key (code Minus), * on the German one (code BracketRight); _ on every − key.
  if (e.key === '+' || (e.key === '?' && e.code === 'Minus') || (e.key === '*' && e.code === 'BracketRight')) return 1
  if (e.key === '_') return -1
  return null
}

/** "125 %" */
export const zoomLabel = (z: number) => `${Math.round(z * 100)} %`
