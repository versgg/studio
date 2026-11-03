// Dragging a box across a scrolling list picks everything it touches (Home's projects, the
// library). The box is kept in the list's own coordinates, so its start stays put while the
// list scrolls, by the wheel or by holding the pointer near its top or bottom edge, and what
// it passed on the way stays picked.

import { useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'

/** The box, in the scroller's content (draw it absolutely inside the scroller). */
export type Box = { left: number; top: number; width: number; height: number }

const EDGE_PX = 40
const EDGE_SPEED = 18

interface Options {
  /** What scrolls; it holds the drawn box, so it must be `position: relative`. */
  scroller: RefObject<HTMLElement | null>
  /** The pickable elements, each with its id. */
  items: () => Iterable<HTMLElement>
  idOf: (el: HTMLElement) => string | undefined
  onPick: (ids: string[]) => void
  /** Room covered at the scroller's top (a sticky bar): the top edge zone starts below it. */
  topInset?: number
}

export function useBoxSelect({ scroller, items, idOf, onPick, topInset = 0 }: Options) {
  const [box, setBox] = useState<Box | null>(null)
  // Whether this press drew a box, so the click that ends it is ignored.
  const drew = useRef(false)

  /** Starts a box at the press; `base` stays picked (Shift or Ctrl adds to what's picked). */
  const start = (e: ReactPointerEvent, base: string[]) => {
    const el = scroller.current
    if (!el || e.button !== 0) return
    const inner = (x: number, y: number) => {
      const r = el.getBoundingClientRect()
      return { x: x - r.left + el.scrollLeft, y: y - r.top + el.scrollTop }
    }
    const a = inner(e.clientX, e.clientY)
    let p = { x: e.clientX, y: e.clientY }
    let last = el.scrollTop
    drew.current = false
    const update = () => {
      const b = inner(p.x, p.y)
      if (!drew.current && Math.hypot(b.x - a.x, b.y - a.y) < 4) return
      drew.current = true
      const next = { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }
      setBox(next)
      // Against the items where they are now: the box back in the window's coordinates.
      const r = el.getBoundingClientRect()
      const [l, t] = [next.left + r.left - el.scrollLeft, next.top + r.top - el.scrollTop]
      const hit: string[] = []
      for (const it of items()) {
        const rc = it.getBoundingClientRect()
        const id = idOf(it)
        if (id && rc.left < l + next.width && rc.right > l && rc.top < t + next.height && rc.bottom > t) hit.push(id)
      }
      onPick([...new Set([...base, ...hit])])
    }
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      if (drew.current) {
        const r = el.getBoundingClientRect()
        const [top, bottom] = [r.top + topInset, r.top + el.clientHeight]
        const into = p.y < top + EDGE_PX ? p.y - (top + EDGE_PX) : p.y > bottom - EDGE_PX ? p.y - (bottom - EDGE_PX) : 0
        if (into) el.scrollTop = Math.max(0, el.scrollTop + Math.sign(into) * Math.ceil(EDGE_SPEED * Math.min(2, Math.abs(into) / EDGE_PX) ** 2))
      }
      // However it scrolled, the box follows the pointer over the content now in view.
      if (el.scrollTop !== last) {
        last = el.scrollTop
        update()
      }
    }
    const move = (ev: PointerEvent) => {
      p = { x: ev.clientX, y: ev.clientY }
      update()
    }
    const end = () => {
      // The click that follows the release is the box's, not a pick; the next one is.
      if (drew.current) setTimeout(() => (drew.current = false))
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      setBox(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    raf = requestAnimationFrame(tick)
  }

  return { box, start, drew }
}
