const LEAF =
  'M0 -36C8 -26 18 -28 14 -16C24 -12 22 0 12 0C22 6 20 18 8 14C12 26 4 34 0 36C-4 34 -12 26 -8 14C-20 18 -22 6 -12 0C-22 0 -24 -12 -14 -16C-18 -28 -8 -26 0 -36Z'

/** The in-app mark: blue leaf and coral dot, no tile (the tile is the app icon only). */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d={LEAF} transform="translate(15 17.5) scale(0.33) rotate(-12)" fill="#3B57F0" />
      <circle cx="25" cy="6.5" r="2.6" fill="#FF6B4A" />
    </svg>
  )
}
