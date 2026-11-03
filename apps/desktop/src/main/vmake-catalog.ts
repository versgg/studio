// What Vmake's text removal offers, known before Vmake is asked: its models, the prices last
// seen and the balance, kept in userData's vmake-account.json. The Remove text window shows
// them at once while the account is checked in the background (and once a little after Studio
// starts). A model Vmake starts offering joins the list for good, named from its config.

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { VmakeAccount } from '../shared/api'

/** The watermark-remover models, from purchase_config.json: [effect model, name, note]. */
export const MODELS: Record<string, [string, string, string]> = {
  full: ['video_remove_full', 'Smart Remove', 'Text, captions and logos'],
  pro: ['video_remove_full_pro', 'Smart Remove Pro', 'Sharper, and costs more'],
  subtitle: ['video_remove_subtitle', 'Subtitles only', 'Leaves logos alone'],
  watermark: ['video_remove_watermark', 'Watermark only', 'Leaves captions alone'],
  'subtitle-box': ['video_remove_subtitle_box', 'Subtitle box', 'Boxed captions'],
}

/** Their prices on 2026-10-31, until this computer's account has answered once. */
const PRICES: VmakeAccount['prices'] = {
  full: { credits: 50, durationLimit: 600, remain: null },
  pro: { credits: 100, durationLimit: 300, remain: null },
  subtitle: { credits: 50, durationLimit: 600, remain: null },
  watermark: { credits: 50, durationLimit: 600, remain: null },
  'subtitle-box': { credits: 50, durationLimit: 600, remain: null },
}

/** One model in Vmake's purchase config. */
export interface VmakeOffer {
  effect: string
  credits: number | null
  durationLimit: number
  remain: number | null
  name?: string
  note?: string
}

interface Saved {
  balance: number | null
  checked: number | null
  prices: VmakeAccount['prices']
  /** Models Vmake offered that Studio didn't know, by key (their effect model). */
  added: Record<string, { effect: string; name: string; note: string }>
}

const file = () => path.join(app.getPath('userData'), 'vmake-account.json')
let saved: Saved | null = null
function load(): Saved {
  if (saved) return saved
  try {
    saved = { balance: null, checked: null, prices: PRICES, added: {}, ...JSON.parse(fs.readFileSync(file(), 'utf8')) }
  } catch {
    saved = { balance: null, checked: null, prices: PRICES, added: {} }
  }
  return saved!
}

/** Every model: Studio's own first, then those Vmake added since. */
function models(): VmakeAccount['models'] {
  const own = Object.entries(MODELS).map(([k, [, name, note]]) => [k, { name, note }])
  const added = Object.entries(load().added).map(([k, m]) => [k, { name: m.name, note: m.note }])
  return Object.fromEntries([...own, ...added])
}

/** What's known now, without asking Vmake. */
export function known(): VmakeAccount {
  const s = load()
  return { balance: s.balance, prices: s.prices, models: models(), checked: s.checked }
}

/** The effect model Vmake charges for a model's key. */
export const effectOf = (key: string): string | null => MODELS[key]?.[0] ?? load().added[key]?.effect ?? null

/** "video_remove_face_blur" → "Face blur". */
function nameOf(effect: string) {
  const words = effect.replace(/^video_(remove_)?/, '').replace(/_/g, ' ').trim()
  return words ? words[0].toUpperCase() + words.slice(1) : effect
}

/** Takes in what the account just said: the balance, prices, and any model new to the list. */
export function learn(balance: number | null, offers: VmakeOffer[]): VmakeAccount {
  const s = load()
  const added = { ...s.added }
  const keyOf = new Map<string, string>([...Object.entries(MODELS).map(([k, [effect]]) => [effect, k] as const), ...Object.entries(added).map(([k, m]) => [m.effect, k] as const)])
  const prices: VmakeAccount['prices'] = {}
  for (const o of offers) {
    let key = keyOf.get(o.effect)
    if (!key) {
      key = o.effect
      added[key] = { effect: o.effect, name: o.name || nameOf(o.effect), note: o.note || 'New on Vmake' }
      keyOf.set(o.effect, key)
    }
    prices[key] ??= { credits: o.credits, durationLimit: o.durationLimit, remain: o.remain }
  }
  // An answer without a price list keeps the last one.
  saved = { balance, checked: Date.now(), prices: offers.length ? prices : s.prices, added }
  try {
    fs.writeFileSync(file(), JSON.stringify(saved, null, 2))
  } catch {}
  return known()
}
