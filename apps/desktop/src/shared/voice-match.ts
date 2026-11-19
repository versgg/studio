// Which of the account's ElevenLabs voices said each sentence of a voiceover Studio didn't make
// (main/voice-read.ts), for a file two or more voices speak in: a dialogue made with ElevenLabs'
// Text to Dialogue (one history item listing each line with its voice), or lines generated one
// voice at a time and joined into one file. A translation then speaks each sentence in its own
// voice (renderer/translate.ts groups its lines by voice).

/** One thing the account generated: a whole take, or one line of a dialogue. */
export type HistoryLine = { voiceId: string; voiceName: string; model: string; text: string; speed: number; at: number }

/**
 * ElevenLabs' history items as lines: a dialogue item has no text or voice of its own, its
 * `dialogue` list has them line by line (elevenlabs.io/docs/api-reference/history/list, 2026-11-19).
 */
export function historyLines(items: unknown[]): HistoryLine[] {
  const out: HistoryLine[] = []
  for (const raw of items) {
    const h = raw as { voice_id?: string; voice_name?: string; model_id?: string; text?: string; settings?: { speed?: number } | null; date_unix?: number; dialogue?: { text?: string; voice_id?: string; voice_name?: string }[] | null }
    const base = { model: h.model_id ?? '', speed: h.settings?.speed ?? 1, at: h.date_unix ?? 0 }
    if (h.voice_id && h.text) out.push({ ...base, voiceId: h.voice_id, voiceName: h.voice_name ?? '', text: h.text })
    for (const d of h.dialogue ?? []) if (d.voice_id && d.text) out.push({ ...base, voiceId: d.voice_id, voiceName: d.voice_name ?? '', text: d.text })
  }
  return out
}

/** Words, lower-case, without punctuation or ElevenLabs' [audio tags]. */
export const wordsOf = (s: string) =>
  s
    .replace(/\[[^\]]*\]/g, ' ')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)

/**
 * Each sentence's voice when the file is spoken by two or more (null for a file one voice
 * speaks: the file's voice stands, as before). A history line belongs to this file when most of
 * its words are said in it; a sentence is a voice's when that voice's lines hold at least 60 %
 * of its words, more than any other voice's. A sentence no voice holds gets null (the file's voice).
 */
export function voicesBySentence(sentences: { text: string }[], history: HistoryLine[]): (HistoryLine | null)[] | null {
  const said = new Set(sentences.flatMap((s) => wordsOf(s.text)))
  if (!said.size) return null
  // The file's lines, by voice: their words, and the newest line (model, speed, name).
  const byVoice = new Map<string, { words: Set<string>; line: HistoryLine }>()
  for (const h of history) {
    const w = wordsOf(h.text)
    if (w.length < 2 || w.filter((x) => said.has(x)).length / w.length < 0.7) continue
    const v = byVoice.get(h.voiceId) ?? { words: new Set<string>(), line: h }
    for (const x of w) v.words.add(x)
    if (h.at > v.line.at) v.line = h
    byVoice.set(h.voiceId, v)
  }
  if (byVoice.size < 2) return null
  const out = sentences.map((s) => {
    const w = wordsOf(s.text)
    if (!w.length) return null
    let best: { n: number; line: HistoryLine } | null = null
    let tie = false
    for (const v of byVoice.values()) {
      const n = w.filter((x) => v.words.has(x)).length
      if (best && n === best.n) tie = true
      if (!best || n > best.n) {
        best = { n, line: v.line }
        tie = false
      }
    }
    return best && !tie && best.n / w.length >= 0.6 ? best.line : null
  })
  return new Set(out.filter(Boolean).map((l) => l!.voiceId)).size >= 2 ? out : null
}
