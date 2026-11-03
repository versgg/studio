// Visual dub, step 2: Claude reads every piece of text from its crop (OCR only found it) and
// translates it. An earlier dubbing tool sent OCR's words to you.com's research agent, which is where its
// misread and mistranslated texts came from (scrap words translated, a lip highlight read as
// "A", an emoji added, "Only 9 Fridays until Christmas!" left in English as "scene" text).
//
// Claude runs through Claude Code on this computer (`claude -p`, the user's own sign-in, no key
// in Studio), with every crop and its whole frame as images, in one call per video so the
// same words get the same translation throughout. The answer is checked here: every block
// answered, no emoji added or dropped, numbers kept, and a translation not wildly longer than
// its original (it must fit the same place).
//
// Claude Code driving Studio over MCP can instead write the readings itself: a `texts.json` in
// the dub's folder with every block is taken as it is.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DubScan, DubText } from '../shared/dub'
import { DUB_FONTS } from '../shared/dub'

export class ClaudeSignedOut extends Error {}

/** The test stand-in (STUDIO_CLAUDE_FAKE=1, as in translate-read.ts): never runs Claude; OCR's reading as it is, translated as "<LANG>: <text>". */
const FAKE = process.env.STUDIO_CLAUDE_FAKE === '1'

/** Claude Code's command line: the npm install's own executable, the native install, or PATH. */
export function findClaude(): string | null {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const candidates = [
    process.env.STUDIO_CLAUDE,
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', exe),
    path.join(os.homedir(), '.local', 'bin', exe),
    path.join(os.homedir(), '.claude', 'local', exe),
    ...(process.env.PATH ?? '').split(path.delimiter).map((d) => d && path.join(d, exe)),
  ]
  for (const c of candidates) if (c && fs.existsSync(c)) return c
  return null
}

const LANG_NAMES: Record<string, string> = {
  sv: 'Swedish', no: 'Norwegian (Bokmål)', da: 'Danish', fi: 'Finnish', de: 'German', en: 'English', nl: 'Dutch',
  fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese', pl: 'Polish',
}
export const langName = (code: string) => LANG_NAMES[code] ?? code

const SCHEMA = {
  type: 'object',
  properties: {
    texts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          kind: { type: 'string', enum: ['edit', 'scene', 'part'] },
          partOf: { type: 'string' },
          translation: { type: 'string' },
          font: { type: 'string' },
          category: { type: 'string', enum: ['sans', 'serif', 'script', 'display', 'mono'] },
          weight: { type: 'number' },
          italic: { type: 'boolean' },
          uppercase: { type: 'boolean' },
        },
        required: ['id', 'text', 'kind', 'translation', 'category'],
      },
    },
  },
  required: ['texts'],
}

function prompt(scan: DubScan, lang: string, context: string) {
  const name = langName(lang)
  return [
    `You are localising the on-screen text of a short social video ad into ${name}.`,
    context ? `What the ad is: ${context}` : '',
    'Each piece of text comes as two images: a crop of it at full resolution, then the whole frame with it outlined in red. ' +
      "OCR's guess is given for each, but OCR misreads (letters, digits, spaces, emoji): read the crop yourself.",
    'For every id return:',
    '- text: exactly what is written, with its line breaks as \\n, its capitals, punctuation and emoji (as the Unicode emoji).',
    "- kind: \"edit\" for text added in editing (titles, labels, captions, prices, calls to action); \"scene\" for text that is part of what was filmed (a product's label, packaging, a sign, clothing), which stays as it is; \"part\" when this crop is only a piece of another listed text (then give partOf: that id).",
    `- translation: the text in natural ${name} as a native copywriter would write it for this ad, in the same tone. ` +
      'Keep brand names, product names (all their words, "Cream" included), numbers and percentages exactly as written. Keep the same number of lines where natural, and about the same length: it replaces the original in the same place. ' +
      'Keep every emoji the original has and add none. The same words get the same translation every time they appear. For "scene" and "part", repeat the text.',
    `- category: sans, serif, script, display or mono; font: the closest of these families: ${DUB_FONTS.join(', ')}; weight (100–900), italic, uppercase (all capitals).`,
    '',
    'The texts, in order:',
    ...scan.blocks.map((b) => `${b.id} (${(b.startUs / 1e6).toFixed(2)}–${(b.endUs / 1e6).toFixed(2)} s): OCR read ${JSON.stringify(b.lines.map((l) => l.text).join('\n'))}`),
  ]
    .filter(Boolean)
    .join('\n')
}

const EMOJI = /\p{Extended_Pictographic}/gu
export const emojis = (s: string) => (s.match(EMOJI) ?? []).sort().join('')
export const numbers = (s: string) => (s.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(',', '.')).sort().join(' ')

/** What's wrong with an answer, if anything (the reason goes back to Claude for a second try). */
export function checkTexts(scan: DubScan, texts: DubText[]): string | null {
  const ids = new Set(scan.blocks.map((b) => b.id))
  const got = new Set(texts.map((t) => t.id))
  const missing = [...ids].filter((i) => !got.has(i))
  if (missing.length) return `No answer for ${missing.join(', ')}.`
  for (const t of texts) {
    if (!ids.has(t.id)) return `${t.id} is not one of the texts.`
    if (t.kind !== 'edit') continue
    if (!t.translation.trim()) return `${t.id} has no translation.`
    if (emojis(t.text) !== emojis(t.translation)) return `${t.id}: the translation must keep exactly the original's emoji (${emojis(t.text) || 'none'}).`
    if (numbers(t.text) !== numbers(t.translation)) return `${t.id}: the translation must keep the original's numbers (${numbers(t.text) || 'none'}).`
    if (t.translation.length > Math.max(12, t.text.length * 1.6)) return `${t.id}: the translation is much longer than the original (${t.translation.length} vs ${t.text.length} characters); it must fit the same place.`
  }
  return null
}

export function runClaude<T = { texts: DubText[] }>(exe: string, content: unknown[], signal?: AbortSignal, schema: object = SCHEMA, key = 'texts'): Promise<T> {
  return new Promise((resolve, reject) => {
    // Its own empty folder, so no project's CLAUDE.md or memory comes along; no tools, no MCP.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-dub-'))
    const child = spawn(exe, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--model', process.env.STUDIO_DUB_MODEL || 'opus', '--json-schema', JSON.stringify(schema)], { cwd, windowsHide: true })
    const stop = () => child.kill()
    signal?.addEventListener('abort', stop)
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)))
    child.on('error', (e) => reject(new Error(`Claude Code could not start: ${e.message}`)))
    child.on('close', () => {
      signal?.removeEventListener('abort', stop)
      fs.rmSync(cwd, { recursive: true, force: true })
      if (signal?.aborted) return reject(new Error('Cancelled.'))
      const result = out.split(/\r?\n/).filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).find((j) => j.type === 'result')
      if (!result) return reject(new Error(err.trim().split(/\r?\n/).pop() || 'Claude Code gave no answer.'))
      const text = String(result.result ?? '')
      if (/authenticat|log ?in|sign ?in|OAuth/i.test(text) && result.is_error) return reject(new ClaudeSignedOut('Claude Code is signed out. Run `claude auth login` in a terminal, then try again.'))
      if (result.is_error) return reject(new Error(text || 'Claude Code failed.'))
      const answer = result.structured_output ?? (() => {
        try {
          return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
        } catch {
          return null
        }
      })()
      if (!answer?.[key]) return reject(new Error(`Claude Code answered without the ${key}.`))
      resolve(answer)
    })
    // Claude Code may quit before reading it all (signed out): that's its answer, not a crash.
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n')
  })
}

/** Reads and translates a scan's texts (into `dir/texts.json`), or takes a texts.json already there. */
export async function readTexts(scan: DubScan, dir: string, lang: string, o: { context?: string; signal?: AbortSignal } = {}): Promise<DubText[]> {
  const file = path.join(dir, 'texts.json')
  if (fs.existsSync(file)) {
    const texts = JSON.parse(fs.readFileSync(file, 'utf8')).texts as DubText[]
    const wrong = checkTexts(scan, texts)
    if (!wrong) return texts
  }
  if (FAKE) {
    const texts = scan.blocks.map((b): DubText => {
      const text = b.lines.map((l) => l.text).join('\n')
      return { id: b.id, text, kind: 'edit', translation: `${lang.toUpperCase()}: ${text}`, category: 'sans' }
    })
    fs.writeFileSync(file, JSON.stringify({ lang, texts }, null, 1))
    return texts
  }
  const exe = findClaude()
  if (!exe) throw new ClaudeSignedOut('Claude Code is not installed on this computer, so nothing can read and translate the text.')
  const image = (f: string) => ({ type: 'image', source: { type: 'base64', media_type: f.endsWith('.png') ? 'image/png' : 'image/jpeg', data: fs.readFileSync(path.join(dir, f)).toString('base64') } })
  const content: unknown[] = []
  for (const b of scan.blocks) content.push({ type: 'text', text: `${b.id}:` }, image(b.crop), image(b.frame))
  content.push({ type: 'text', text: prompt(scan, lang, o.context ?? '') })
  let answer = await runClaude(exe, content, o.signal)
  let wrong = checkTexts(scan, answer.texts)
  if (wrong) {
    content.push({ type: 'text', text: `Your previous answer had a problem: ${wrong} Answer again for every id, fixing it.` })
    answer = await runClaude(exe, content, o.signal)
    wrong = checkTexts(scan, answer.texts)
    if (wrong) throw new Error(`Claude's reading didn't hold up: ${wrong}`)
  }
  fs.writeFileSync(file, JSON.stringify({ lang, texts: answer.texts }, null, 1))
  return answer.texts
}

/** A spoken sentence to translate: what was heard, and how many characters fit its moment. */
export type SpeechLine = { id: string; heard: string; seconds: number; budget: number }
/** Claude's answer for one: what was said (misheard names put right) and the translation. */
export type SpeechText = { id: string; text: string; translation: string }

const SPEECH_SCHEMA = {
  type: 'object',
  properties: { lines: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, translation: { type: 'string' } }, required: ['id', 'text', 'translation'] } } },
  required: ['lines'],
}

/** What's wrong with a speech translation, if anything (back to Claude for one more try). */
export function checkSpeech(lines: SpeechLine[], got: SpeechText[], slack = 1.15): string | null {
  const ids = new Set(lines.map((l) => l.id))
  const missing = lines.filter((l) => !got.some((g) => g.id === l.id)).map((l) => l.id)
  if (missing.length) return `No translation for ${missing.join(', ')}.`
  const long: string[] = []
  for (const g of got) {
    if (!ids.has(g.id)) return `${g.id} is not one of the sentences.`
    if (!g.translation.trim()) return `${g.id} has no translation.`
    if (numbers(g.text) !== numbers(g.translation)) return `${g.id}: keep the numbers as said (${numbers(g.text) || 'none'}).`
    const l = lines.find((x) => x.id === g.id)!
    if (g.translation.length > l.budget * slack) long.push(`${g.id} (${g.translation.length} characters, room for about ${l.budget})`)
  }
  return long.length ? `These are too long to say in their time: ${long.join('; ')}. Make them shorter by saying them more simply, not by dropping meaning or abbreviating.` : null
}

/**
 * Translates what's said as ONE script (so it reads as one person talking), each sentence sized
 * to its moment: about `budget` characters (its room × the language's speaking rate). Names
 * speech recognition got wrong are put right from the on-screen text (`known`), e.g. a product
 * heard as "Lumma Vee" that the video shows as "Lumavee". With `previous`, the script is
 * made shorter where `lines` say so, as a whole again (never one sentence on its own).
 */
export async function translateSpeech(lines: SpeechLine[], lang: string, o: { from?: string; known?: string[]; previous?: SpeechText[]; signal?: AbortSignal } = {}): Promise<SpeechText[]> {
  if (FAKE) return lines.map((l) => ({ id: l.id, text: l.heard, translation: `${lang.toUpperCase()}: ${l.heard}` }))
  const exe = findClaude()
  if (!exe) throw new ClaudeSignedOut('Claude Code is not installed on this computer, so nothing can translate the speech.')
  const name = langName(lang)
  const text = [
    `You are dubbing a short social video ad into ${name}${o.from ? ` from ${langName(o.from)}` : ''}. One person's voice will say your translation, sentence by sentence, at the moments the original sentences were said.`,
    o.known?.length ? `The video shows this text on screen (the right spelling of brand and product names): ${o.known.map((k) => JSON.stringify(k)).join(', ')}.` : '',
    'Each sentence below is what speech recognition heard. First put right anything it misheard (names, products, numbers), as "text". Then translate it as "translation":',
    `- natural spoken ${name}, as a native would say it in a video like this, in the same tone; the sentences together read as one person talking;`,
    '- about as many characters as "budget" (what fits the time the original took); never longer by much, and if the original is long, say it more simply rather than speed it up;',
    '- keep brand names, product names, numbers and percentages; write names the way they are pronounced as words (Lumavee, not LUMAVEE, which a voice would spell out letter by letter); no abbreviations, brackets or stage directions; numbers as they are spoken naturally;',
    '- keep what each sentence says: drop filler words before you drop meaning.',
    o.previous ? `This is a second pass: your last translation is given as "now". Keep it, except make the sentences listed as too long shorter (to their budget), and adjust their neighbours only if the meaning needs it.` : '',
    'Return every id.',
    JSON.stringify(lines.map((l) => ({ id: l.id, heard: l.heard, seconds: Math.round(l.seconds * 10) / 10, budget: l.budget, ...(o.previous ? { now: o.previous.find((p) => p.id === l.id)?.translation } : {}) }))),
  ]
    .filter(Boolean)
    .join('\n')
  const content: unknown[] = [{ type: 'text', text }]
  let answer = await runClaude<{ lines: SpeechText[] }>(exe, content, o.signal, SPEECH_SCHEMA, 'lines')
  const wrong = checkSpeech(lines, answer.lines)
  if (wrong) {
    content.push({ type: 'text', text: `Your answer had a problem: ${wrong} Answer again for every id.` })
    answer = await runClaude<{ lines: SpeechText[] }>(exe, content, o.signal, SPEECH_SCHEMA, 'lines')
    const still = checkSpeech(lines, answer.lines, 1.3)
    if (still && !/too long/.test(still)) throw new Error(`Claude's translation didn't hold up: ${still}`)
  }
  return lines.map((l) => answer.lines.find((a) => a.id === l.id)!)
}
