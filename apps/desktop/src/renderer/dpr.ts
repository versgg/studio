// The screen's pixels per CSS pixel, which the app zoom changes too (Ctrl/Cmd+Shift + and −):
// canvases drawn at it draw again when it changes, so they stay sharp.

import { useEffect, useState } from 'react'

export function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1)
  useEffect(() => {
    let mq: MediaQueryList | null = null
    const watch = () => {
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      mq.addEventListener('change', changed, { once: true })
    }
    const changed = () => {
      setDpr(window.devicePixelRatio || 1)
      watch()
    }
    watch()
    return () => mq?.removeEventListener('change', changed)
  }, [])
  return dpr
}
