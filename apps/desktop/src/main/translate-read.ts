// Translations, the Claude step: everything a finished project says (its text clips, caption
// lines and spoken sentences) translated into one language in ONE call, so the ad reads as one
// piece and the same words get the same translation throughout. Each answer comes with a
// back-translation into the project's own language, for the review of languages the user
// doesn't read. Checked here like a dub's: every id, numbers kept, emoji kept on screen, and
// spoken sentences sized to their moments (one more try when something is off).

import type { TrItem, TrText } from '../shared/translate'
import { ClaudeSignedOut, emojis, findClaude, langName, numbers, runClaude } from './dub-read'
import { CPS } from './dub-voice'

export const FAKE = process.env.STUDIO_CLAUDE_FAKE === '1'

const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' }, translation: { type: 'string' }, back: { type: 'string' } }, required: ['id', 'translation', 'back'] },
    },
  },
  required: ['items'],
}

/** An item as Claude gets it: spoken sentences with the characters their moment holds. */
type Ask = { id: string; kind: string; text: string; original?: string; seconds?: number; budget?: number }

/** Each spoken sentence's room (until the next one starts) and what fits in it at the language's rate, 10 % faster. */
export function budgets(items: TrItem[], endUs: number, lang: string) {
  const lines = items.filter((i) => i.kind === 'line').sort((a, b) => a.startUs - b.startUs)
  return new Map(
    lines.map((l, i) => {
      const seconds = Math.max(0.3, ((lines[i + 1]?.startUs ?? endUs) - l.startUs) / 1e6)
      return [l.id, { seconds, budget: Math.max(8, Math.round(seconds * (CPS[lang] ?? 14) * 1.1)) }]
    }),
  )
}

/** What's wrong with an answer, if anything. */
export function checkItems(asks: Ask[], got: TrText[], slack = 1.15): string | null {
  const missing = asks.filter((a) => !got.some((g) => g.id === a.id)).map((a) => a.id)
  if (missing.length) return `No translation for ${missing.join(', ')}.`
  const long: string[] = []
  for (const a of asks) {
    const g = got.find((x) => x.id === a.id)!
    if (!g.translation.trim()) return `${a.id} has no translation.`
    if (numbers(a.text) !== numbers(g.translation)) return `${a.id}: keep the numbers as they are (${numbers(a.text) || 'none'}).`
    if (a.kind !== 'spoken' && emojis(a.text) !== emojis(g.translation)) return `${a.id}: keep exactly the original's emoji (${emojis(a.text) || 'none'}).`
    if (a.kind === 'on-screen text' && g.translation.length > Math.max(12, a.text.length * 1.6)) return `${a.id}: much longer than the original (${g.translation.length} vs ${a.text.length} characters); it must fit the same place.`
    if (a.budget && g.translation.length > a.budget * slack) long.push(`${a.id} (${g.translation.length} characters, room for about ${a.budget})`)
  }
  return long.length ? `These are too long to say in their time: ${long.join('; ')}. Say them more simply, without dropping meaning or abbreviating.` : null
}

const KIND = { text: 'on-screen text', caption: 'caption', line: 'spoken' } as const

/**
 * Translates every item from `from` into `lang`. Caption lines are left out when `captions` is
 * false (they're made again from the new voice), and spoken sentences unless `speak` and their
 * voice is known (nothing else would use them). Throws ClaudeSignedOut when Claude Code can't run.
 */
export async function translateItems(items: TrItem[], o: { from: string; lang: string; endUs: number; captions: boolean; speak: boolean; signal?: AbortSignal }): Promise<TrText[]> {
  const room = budgets(items, o.endUs, o.lang)
  const asks: Ask[] = items
    .filter((i) => (i.kind === 'caption' ? o.captions : i.kind === 'line' ? o.speak && !!i.voice : true))
    .map((i) => ({ id: i.id, kind: KIND[i.kind], text: i.text, ...(i.original ? { original: i.original } : {}), ...(room.has(i.id) ? { seconds: Math.round(room.get(i.id)!.seconds * 10) / 10, budget: room.get(i.id)!.budget } : {}) }))
  if (!asks.length) return []
  if (FAKE) return asks.map((a) => ({ id: a.id, translation: fakeTranslate(a.text, o.lang), back: a.text }))
  const exe = findClaude()
  if (!exe) throw new ClaudeSignedOut('Claude Code is not installed on this computer, so nothing can translate the project.')
  const from = langName(o.from), to = langName(o.lang)
  const text = [
    `You are localising a finished short social video ad from ${from} into ${to}. Everything it says is listed below in the order it appears: on-screen text, caption lines and spoken sentences. Together they are one ad; translate them as one piece, in the same tone, as a native ${to} copywriter would write it for this ad. The same words get the same translation every time they appear.`,
    'For every id return:',
    `- translation: the ${to}.`,
    `- back: your translation put back into ${from}, word for word, so someone who doesn't read ${to} can check the meaning. Not a polished rewrite.`,
    'Rules:',
    '- Keep brand names, shop names, product names (all their words, "Cream" included), numbers and percentages exactly as written.',
    '- "original", when given, is what the ad said before it was translated into ' + from + '. Use it to get the meaning right, but follow the ' + from + ' where they differ: it was changed on purpose (a shop name, a call to action).',
    '- On-screen text: about the same length, keeping its line breaks (\\n) where natural; it replaces the original in the same place. Keep every emoji and add none.',
    '- Caption lines: short like the original line; each stands on its own on screen.',
    '- Spoken sentences: natural spoken ' + to + ' that one person says, sentence after sentence. About as many characters as "budget" (what fits the time it has), never much more: say it more simply rather than faster. Write names the way they are said as words (Lumavee, not LUMAVEE, which a voice would spell out); no abbreviations, brackets or stage directions.',
    'Return every id.',
    JSON.stringify(asks),
  ].join('\n')
  const content: unknown[] = [{ type: 'text', text }]
  let answer = await runClaude<{ items: TrText[] }>(exe, content, o.signal, SCHEMA, 'items')
  const wrong = checkItems(asks, answer.items)
  if (wrong) {
    content.push({ type: 'text', text: `Your answer had a problem: ${wrong} Answer again for every id.` })
    answer = await runClaude<{ items: TrText[] }>(exe, content, o.signal, SCHEMA, 'items')
    const still = checkItems(asks, answer.items, 1.3)
    if (still && !/too long/.test(still)) throw new Error(`Claude's translation didn't hold up: ${still}`)
  }
  return asks.map((a) => answer.items.find((x) => x.id === a.id)!)
}

/** The test stand-in (STUDIO_CLAUDE_FAKE=1): the text as it is, marked with the language, about as long. */
function fakeTranslate(text: string, lang: string) {
  return text
    .split('\n')
    .map((l, i) => (i ? l : `${lang.toUpperCase()}: ${l}`))
    .join('\n')
}
