import { useEffect, useRef, useState } from 'react'
import { fitLine, PHONE_H, PHONE_W, reelsText, saveReelsText, TRIM, type ReelsText } from './reels'
import { fileUrl, getState, useStore } from './store'

// Meta's Reels ad on top of the player, drawn in the phone's own pixels (reels.ts): the fades,
// the title and camera, the Shop now card, the account row, the text, "Ad" and the buttons on
// the right, where Ads Manager's preview puts them. Icons are drawn on a 24 px grid.
const ICON = {
  camera: 'M4 8.5A2.5 2.5 0 0 1 6.5 6h1.8l1.4-2h4.6l1.4 2h1.8A2.5 2.5 0 0 1 20 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5z M15.6 12.8a3.6 3.6 0 1 1-7.2 0a3.6 3.6 0 1 1 7.2 0z',
  heart: 'M12 20.2C6.3 16.4 3 13 3 9.2A4.6 4.6 0 0 1 12 7.4a4.6 4.6 0 0 1 9 1.8c0 3.8-3.3 7.2-9 11z',
  comment: 'M20.6 17.1A9.5 9.5 0 1 0 17.1 20.6L21.5 21.5z',
  repost: 'M4.5 13V8a3 3 0 0 1 3-3H18 M15 2l3 3-3 3 M19.5 11v5a3 3 0 0 1-3 3H6 M9 22l-3-3 3-3',
  send: 'M3 4.5h18l-8.6 16-2.2-8.2z M10.2 12.3L21 4.5',
}
/** An icon's place: its 24 px grid scaled by `k` with its middle (12, 12) at (x, y). */
const Icon = ({ d, x, y, k }: { d: string; x: number; y: number; k: number }) => (
  <path d={d} transform={`translate(${x - 12 * k} ${y - 12 * k}) scale(${k})`} fill="none" stroke="#FFFFFF" strokeWidth={2.1 / k} strokeLinecap="round" strokeLinejoin="round" />
)

const FONT = 'Roboto, sans-serif'
const textFont = (px: number, weight = 400) => `${weight} ${px}px Roboto`

/** The overlay itself, over a 9:16 frame: the phone in the middle and the sides it leaves off. */
export function ReelsOverlay() {
  const dir = useStore((s) => s.snap?.dir)
  const t = useReelsText(dir)
  const thumb = useStill(dir)
  const [, setFonts] = useState(0)
  // The lines are measured in Roboto, so measure again once it has loaded.
  useEffect(() => {
    let live = true
    void document.fonts.load(textFont(16)).then(() => live && setFonts((n) => n + 1))
    return () => {
      live = false
    }
  }, [])
  const name = fitLine(t.account, textFont(16.5), 230, '…')
  const nameW = Math.min(230, measure(name, textFont(16.5)))
  const follow = 85 + nameW + 21
  return (
    <div className="reels" aria-hidden="true">
      <span className="reels-trim left" style={{ width: `${TRIM * 100}%` }} />
      <span className="reels-trim right" style={{ width: `${TRIM * 100}%` }} />
      <svg className="reels-phone" style={{ left: `${TRIM * 100}%`, width: `${(1 - 2 * TRIM) * 100}%` }} viewBox={`0 0 ${PHONE_W} ${PHONE_H}`} preserveAspectRatio="none" fontFamily={FONT}>
        <defs>
          <linearGradient id="reels-top" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#000000" stopOpacity="0.38" />
            <stop offset="1" stopColor="#000000" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="reels-foot" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#000000" stopOpacity="0" />
            <stop offset="0.755" stopColor="#000000" stopOpacity="0.61" />
            <stop offset="1" stopColor="#000000" stopOpacity="0.61" />
          </linearGradient>
          <clipPath id="reels-thumb">
            <rect x="39" y="722" width="56" height="57" rx="6" />
          </clipPath>
        </defs>
        <rect x="0" y="0" width={PHONE_W} height="166" fill="url(#reels-top)" />
        <rect x="0" y="712" width={PHONE_W} height={PHONE_H - 712} fill="url(#reels-foot)" />
        <text x="22" y="83" fontSize="32" fontWeight="700" fill="#FFFFFF">
          Reels
        </text>
        <Icon d={ICON.camera} x={491.5} y={72} k={1.56} />
        {/* The Shop now card: the ad's picture and headline on a dark glass, the button under it. */}
        <path d="M25 803V712a12 12 0 0 1 12-12h385a12 12 0 0 1 12 12v91z" fill="#282828" fillOpacity="0.66" />
        <path d="M25 803h409v44a12 12 0 0 1-12 12H37a12 12 0 0 1-12-12z" fill="#FFFFFF" />
        {thumb ? <image href={fileUrl(thumb)} x="39" y="722" width="56" height="57" preserveAspectRatio="xMidYMid slice" clipPath="url(#reels-thumb)" /> : <rect x="39" y="722" width="56" height="57" rx="6" fill="#5A5A60" />}
        <text x="110.5" y="755" fontSize="16.7" fill="#FFFFFF">
          {fitLine(t.headline, textFont(16.7), 310)}
        </text>
        <text x="39" y="835.5" fontSize="16.5" fontWeight="700" fill="#111111">
          Shop now
        </text>
        <path d="M412.5 824l7.5 7-7.5 7" fill="none" stroke="#111111" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {/* The account, Follow, the first line of the text and "Ad". */}
        <circle cx="45" cy="910" r="20" fill="#3A3A3E" />
        <text x="45" y="916" fontSize="17" fontWeight="700" fill="#FFFFFF" textAnchor="middle">
          {t.account.trim().slice(0, 1).toUpperCase()}
        </text>
        <text x="85" y="915.5" fontSize="16.5" fill="#FFFFFF">
          {name}
        </text>
        <rect x={follow} y="897.5" width="54" height="25.5" rx="8" fill="none" stroke="#FFFFFF" strokeOpacity="0.85" strokeWidth="1.4" />
        <text x={follow + 27} y="914.5" fontSize="13" fontWeight="700" fill="#FFFFFF" textAnchor="middle">
          Follow
        </text>
        <text x="27.5" y="955.5" fontSize="16.5" fill="#FFFFFF">
          {fitLine(t.text, textFont(16.5), 380, '...', true)}
        </text>
        <text x="33.5" y="1000" fontSize="16.5" fill="#FFFFFF" fillOpacity="0.75">
          Ad
        </text>
        {/* The buttons down the right. */}
        <Icon d={ICON.heart} x={487.5} y={858.5} k={1.4} />
        <Icon d={ICON.comment} x={488} y={892.5} k={1.18} />
        <Icon d={ICON.repost} x={487.5} y={926.5} k={1.25} />
        <Icon d={ICON.send} x={488} y={961} k={1.34} />
        {[481, 487.5, 494].map((x) => (
          <circle key={x} cx={x} cy="997" r="1.5" fill="#FFFFFF" />
        ))}
      </svg>
    </div>
  )
}

let ruler: CanvasRenderingContext2D | null = null
function measure(text: string, font: string) {
  ruler ??= document.createElement('canvas').getContext('2d')
  if (!ruler) return text.length * 8
  ruler.font = font
  return ruler.measureText(text).width
}

/** The project's first picture, for the card (Meta shows the ad's picture there). */
function useStill(dir: string | undefined) {
  const [still, setStill] = useState<string | null>(null)
  useEffect(() => {
    if (!dir) return
    let live = true
    window.studio.app
      .projectStill(dir)
      .then((s) => live && setStill(s))
      .catch(() => {})
    return () => {
      live = false
      setStill(null)
    }
  }, [dir])
  return still
}

// Edits in the panel reach the overlay through this, without a store field of their own.
const listeners = new Set<() => void>()
function useReelsText(dir: string | undefined): ReelsText {
  const [, bump] = useState(0)
  useEffect(() => {
    const on = () => bump((n) => n + 1)
    listeners.add(on)
    return () => void listeners.delete(on)
  }, [])
  return reelsText(dir)
}

/** The ▾ beside Safe zones: the ad's account, headline and text, as the preview shows them. */
export function ReelsTextButton() {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      setOpen(false)
    }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [open])
  return (
    <span className="reels-edit-wrap" ref={wrap}>
      <button type="button" className={`safe-more${open ? ' on' : ''}`} title="The ad's account, headline and text" aria-label="Edit the Reels preview's words" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && <ReelsTextPanel />}
    </span>
  )
}

function ReelsTextPanel() {
  const dir = getState().snap?.dir
  const [t, setT] = useState(() => reelsText(dir))
  const set = (k: keyof ReelsText, v: string) => {
    const next = { ...t, [k]: v }
    setT(next)
    saveReelsText(dir, next)
    listeners.forEach((on) => on())
  }
  const field = (k: keyof ReelsText, label: string) => (
    <label className="reels-field">
      <span>{label}</span>
      <input className="text-input" value={t[k]} spellCheck={false} onChange={(e) => set(k, e.target.value)} />
    </label>
  )
  return (
    <div className="reels-edit" role="dialog" aria-label="Reels preview">
      <p className="reels-edit-head">Instagram Reels preview</p>
      {field('account', 'Account')}
      {field('headline', 'Headline')}
      {field('text', 'Text')}
      <p className="reels-edit-note">Only on the player. Exports never include it.</p>
    </div>
  )
}
