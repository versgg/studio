// Claude's spoken translations, checked (main/dub-read.ts `translateSpeech`, for dubs and
// translations), and the review's own words kept through the shorter takes. A sentence changed
// in the review is the user's decision (a price for this market: "199 kr" where the original
// says "99 kr"): when a take runs too long and Claude says the script again more simply, that
// sentence stays as written, and the others keep the numbers of the script being shortened,
// not the ones first heard.

/** A spoken sentence to translate: what was heard, and how many characters fit its moment. */
export type SpeechLine = { id: string; heard: string; seconds: number; budget: number }
/** Claude's answer for one: what was said (misheard names put right) and the translation. `edited`: written in the review. */
export type SpeechText = { id: string; text: string; translation: string; edited?: boolean }

/** The numbers in a text, in order of value, as one string to compare ("1,5" is "1.5"). */
export const numbers = (s: string) =>
  (s.match(/\d+(?:[.,]\d+)?/g) ?? [])
    .map((n) => n.replace(',', '.'))
    .sort()
    .join(' ')

/**
 * What's wrong with a speech translation, if anything (back to Claude for one more try). With
 * `previous` (a shorter pass), each sentence keeps the numbers it has now, and one written in
 * the review isn't checked: it's put back as written whatever comes (`keepEdited`).
 */
export function checkSpeech(lines: SpeechLine[], got: SpeechText[], slack = 1.15, previous?: SpeechText[]): string | null {
  const ids = new Set(lines.map((l) => l.id))
  const missing = lines.filter((l) => !got.some((g) => g.id === l.id)).map((l) => l.id)
  if (missing.length) return `No translation for ${missing.join(', ')}.`
  const long: string[] = []
  for (const g of got) {
    if (!ids.has(g.id)) return `${g.id} is not one of the sentences.`
    const was = previous?.find((p) => p.id === g.id)
    if (was?.edited) continue
    if (!g.translation.trim()) return `${g.id} has no translation.`
    const want = numbers(was ? was.translation : g.text)
    if (want !== numbers(g.translation)) return `${g.id}: keep the numbers as ${was ? 'they are now' : 'said'} (${want || 'none'}).`
    const l = lines.find((x) => x.id === g.id)!
    if (g.translation.length > l.budget * slack) long.push(`${g.id} (${g.translation.length} characters, room for about ${l.budget})`)
  }
  return long.length ? `These are too long to say in their time: ${long.join('; ')}. Make them shorter by saying them more simply, not by dropping meaning or abbreviating.` : null
}

/** The answer with every sentence written in the review put back exactly as written. */
export function keepEdited(got: SpeechText[], previous?: SpeechText[]): SpeechText[] {
  return got.map((g) => {
    const was = previous?.find((p) => p.id === g.id && p.edited)
    return was ? { ...g, translation: was.translation, edited: true } : g
  })
}

/** The sentences too long for their moment that Claude may still make shorter: not those written in the review. */
export const canShorten = (long: string[], script: { id: string; edited?: boolean }[]) => long.filter((id) => !script.find((s) => s.id === id)?.edited)
