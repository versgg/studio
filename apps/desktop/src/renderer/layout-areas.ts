/**
 * The layout's grid areas with hidden panels taken out: another panel takes each hidden one's
 * cells (a neighbour whole, else cell by cell from above, below, left or right), as long as
 * every panel stays a rectangle. A panel that can't go is left in.
 */
export function hideAreas(areas: string, hidden: string[]): string {
  let g = (areas.match(/"[^"]+"/g) ?? []).map((r) => r.slice(1, -1).trim().split(/\s+/))
  const valid = (x: string[][]) => {
    const names = new Set(x.flat())
    for (const n of names) {
      const cells = x.flatMap((row, r) => row.map((v, c) => (v === n ? [r, c] : null)).filter(Boolean)) as number[][]
      const rs = cells.map(([r]) => r)
      const cs = cells.map(([, c]) => c)
      const r0 = Math.min(...rs), r1 = Math.max(...rs), c0 = Math.min(...cs), c1 = Math.max(...cs)
      if ((r1 - r0 + 1) * (c1 - c0 + 1) !== cells.length) return false
    }
    return true
  }
  // A hidden panel's cells may go to another hidden one that is handled later, so a few
  // passes clear them all; panels still showing are tried first.
  for (let pass = 0; pass <= hidden.length; pass++) {
    for (const h of hidden) {
      if (!g.flat().includes(h)) continue
      const at = (r: number, c: number) => g[r]?.[c]
      const ok = (n: string | undefined) => !!n && n !== h
      const neighbours = new Set<string>()
      g.forEach((row, r) =>
        row.forEach((v, c) => {
          if (v !== h) return
          for (const n of [at(r, c - 1), at(r, c + 1), at(r - 1, c), at(r + 1, c)]) if (ok(n)) neighbours.add(n!)
        }),
      )
      const whole = (n: string) => g.map((row) => row.map((v) => (v === h ? n : v)))
      const tries: string[][][] = [...neighbours].filter((n) => !hidden.includes(n)).map(whole)
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const t = g.map((row, r) => row.map((v, c) => (v === h && ok(at(r + dr, c + dc)) ? at(r + dr, c + dc)! : v)))
        if (!t.flat().includes(h)) tries.push(t)
      }
      tries.push(...[...neighbours].filter((n) => hidden.includes(n)).map(whole))
      const next = tries.find(valid)
      if (next) g = next
    }
  }
  return g.map((row) => `"${row.join(' ')}"`).join(' ')
}
