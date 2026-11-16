// The links in what was pasted into Media › Download, once each, in order: anything that starts
// with http:// or https:// between spaces or line breaks (the rest of a line is left out).
export function linksIn(text: string): string[] {
  const out: string[] = []
  for (const w of text.split(/\s+/)) {
    const m = /^https?:\/\/\S+$/i.exec(w.trim())
    if (m && !out.includes(m[0])) out.push(m[0])
  }
  return out
}
