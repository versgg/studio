// Writes the built-in LUTs (assets/luts/*.cube, 33-point 3D LUTs) that the Inspector's
// Adjust › Look offers. They are made here from simple colour maths, so their licence is the
// app's own. Run: node apps/desktop/scripts/make-luts.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'luts')
const N = 33
const clamp = (v) => Math.min(1, Math.max(0, v))
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b
/** A gentle S-curve around the middle: amount 0 is straight. */
const sCurve = (v, amount) => clamp(v + amount * (v - 0.5) * (1 - Math.abs(2 * v - 1)) * 2)
const saturate = ([r, g, b], s) => {
  const l = luma(r, g, b)
  return [l + (r - l) * s, l + (g - l) * s, l + (b - l) * s]
}
/** Blacks lifted to `lo`, whites pulled to `hi`. */
const range = (v, lo, hi) => lo + v * (hi - lo)

const LUTS = {
  warm: ([r, g, b]) => saturate([r * 1.05 + 0.02, g * 1.01 + 0.005, b * 0.9], 1.06),
  cool: ([r, g, b]) => saturate([r * 0.92, g * 0.99 + 0.005, b * 1.07 + 0.02], 1.02),
  'teal-orange': ([r, g, b]) => {
    const l = luma(r, g, b)
    const shadow = (1 - l) ** 2
    const high = l ** 2
    const c = [r - 0.05 * shadow + 0.08 * high, g + 0.02 * shadow + 0.02 * high, b + 0.07 * shadow - 0.08 * high]
    return saturate(c.map((v) => sCurve(clamp(v), 0.12)), 1.12)
  },
  mono: ([r, g, b]) => {
    const l = sCurve(luma(r, g, b), 0.18)
    return [l, l, l]
  },
  film: ([r, g, b]) => {
    const c = saturate([r * 1.02, g, b * 0.96], 0.9).map((v) => range(sCurve(clamp(v), 0.2), 0.035, 0.96))
    return c
  },
  faded: ([r, g, b]) => saturate([r, g, b], 0.78).map((v) => range(clamp(v), 0.1, 0.92)),
}

mkdirSync(out, { recursive: true })
for (const [name, f] of Object.entries(LUTS)) {
  const lines = [`TITLE "Studio ${name}"`, `LUT_3D_SIZE ${N}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0']
  // Red changes fastest, then green, then blue (the .cube order).
  for (let bi = 0; bi < N; bi++)
    for (let gi = 0; gi < N; gi++)
      for (let ri = 0; ri < N; ri++) {
        const c = f([ri / (N - 1), gi / (N - 1), bi / (N - 1)]).map(clamp)
        lines.push(c.map((v) => v.toFixed(6)).join(' '))
      }
  writeFileSync(join(out, `${name}.cube`), lines.join('\n') + '\n')
  console.log(`wrote ${name}.cube`)
}
