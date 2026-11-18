// What ElevenLabs last sent about the account (its voices, models and credits), kept in the
// settings folder so the Audio tab has them at once and a slow or silent answer never holds up
// a voiceover (ElevenLabs stopped answering one account's voice list for minutes on 2026-11-18
// while it still spoke). Names and ids only: never the key. Forgotten with the key.

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { ElevenAccount, ElevenModel, Voice } from '../shared/api'

export type ElevenKept = { voices?: Voice[]; voicesAt?: number; models?: ElevenModel[]; account?: ElevenAccount }

const file = () => path.join(app.getPath('userData'), 'eleven-cache.json')

export function kept(): ElevenKept {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'))
  } catch {
    return {}
  }
}

export function keep(part: ElevenKept) {
  try {
    const next = { ...kept(), ...part }
    fs.writeFileSync(`${file()}.tmp`, JSON.stringify(next))
    fs.renameSync(`${file()}.tmp`, file())
  } catch {}
}

export const forgetKept = () => fs.rmSync(file(), { force: true })
