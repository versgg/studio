// Keys for outside services (a Vmake access token and an ElevenLabs API key), kept in the
// user's settings folder encrypted with the OS (DPAPI on Windows, the keychain on macOS,
// the secret service on Linux). They stay in the main process: the page can only ask
// whether one is set, save a new one or clear it — never read it back.

import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export type SecretName = 'vmake' | 'elevenlabs'

const file = () => path.join(app.getPath('userData'), 'secrets.json')
// Where the OS can't encrypt, keys live only for this session.
const memory = new Map<SecretName, string>()

function readAll(): Partial<Record<SecretName, string>> {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'))
  } catch {
    return {}
  }
}

export function getSecret(name: SecretName): string | null {
  if (memory.has(name)) return memory.get(name)!
  const stored = readAll()[name]
  if (!stored || !safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    return null
  }
}

/** Saves a key. Returns whether it was stored on disk (false: kept for this session only). */
export function setSecret(name: SecretName, value: string): boolean {
  const v = value.trim()
  if (!v) return clearSecret(name), false
  if (!safeStorage.isEncryptionAvailable()) {
    memory.set(name, v)
    return false
  }
  memory.delete(name)
  const all = readAll()
  all[name] = safeStorage.encryptString(v).toString('base64')
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(all, null, 2))
  return true
}

export function clearSecret(name: SecretName) {
  memory.delete(name)
  const all = readAll()
  if (name in all) {
    delete all[name]
    fs.writeFileSync(file(), JSON.stringify(all, null, 2))
  }
}

export const hasSecret = (name: SecretName) => !!getSecret(name)

/** Services Studio no longer uses; a key saved for one is taken off the disk. */
const RETIRED = ['anthropic']

export function dropRetiredSecrets() {
  const all = readAll() as Record<string, string>
  if (!RETIRED.some((k) => k in all)) return
  for (const k of RETIRED) delete all[k]
  fs.writeFileSync(file(), JSON.stringify(all, null, 2))
}
