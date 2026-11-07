// macOS gives an app opened from the Dock or Finder launchd's short PATH (/usr/bin:/bin:/usr/sbin:
// /sbin), not the one Terminal has, so Homebrew's FFmpeg (/opt/homebrew/bin), Claude Code and the
// rest weren't found: "FFmpeg is not installed", no import or export. Imported first in main.ts,
// so the PATH is the user's own before anything starts (the engine and every tool inherit it).
// No electron import: node --test runs this file (scripts/shell-path.test.mjs).

import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

/** Where Homebrew and the usual installers put their tools on a Mac (Apple silicon, then Intel). */
export const MAC_DIRS = (home: string) => ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', path.join(home, '.local', 'bin'), path.join(home, '.cargo', 'bin')]

/** The login shell's PATH first, then what the app was given, then the usual folders; each once. */
export function mergePath(shell: string, given: string, home: string): string {
  const all = [...shell.split(':'), ...given.split(':'), ...MAC_DIRS(home)].filter(Boolean)
  return [...new Set(all)].join(':')
}

/** The PATH the user's login shell sets up (zsh by default), or '' if it can't be read quickly. */
export function loginShellPath(): string {
  try {
    const out = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "__STUDIO_PATH__%s__STUDIO_PATH__" "$PATH"'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return /__STUDIO_PATH__(.*?)__STUDIO_PATH__/s.exec(out)?.[1] ?? ''
  } catch {
    return ''
  }
}

if (process.platform === 'darwin') {
  const given = process.env.PATH ?? ''
  // Started from Terminal it's there already; reading the login shell takes a second with some setups.
  const fromTerminal = given.split(':').some((d) => d === '/opt/homebrew/bin' || d === '/usr/local/bin')
  process.env.PATH = mergePath(fromTerminal ? '' : loginShellPath(), given, os.homedir())
}
