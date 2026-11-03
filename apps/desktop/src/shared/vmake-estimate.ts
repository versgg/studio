// How long Vmake takes to remove the text, honestly. Its query only says "working" or
// "done", so the bar during the wait is the clock against an estimate learned from the
// account's own finished jobs: seconds of waiting per second of video, the median of the
// last few (the main process keeps them, vmake-jobs.ts). Shared by the main process (the bar
// it saves with the job) and the page (the bar and time left it shows each second).

/** Seconds of waiting per second of video before any job has finished: a first guess. */
export const FIRST_GUESS_RATE = 3
/** A first guess never promises less than this. */
export const FIRST_GUESS_MIN_MS = 30_000
/** How many finished jobs the estimate learns from. */
export const HISTORY_SIZE = 10
/** The bar's span for the wait: it starts here once Vmake has the job… */
export const WAIT_FROM = 0.2
/** …and stops here until Vmake says it's done (the download takes it on). */
export const WAIT_TO = 0.85

/** The middle value (the mean of the middle two for an even count); null for none. */
export function median(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b)
  if (!v.length) return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

/**
 * How long Vmake should take for `seconds` of video, from past jobs' seconds of waiting per
 * second of video. With none yet it's a first guess (3 s per second, at least 30 s).
 */
export function expectedWait(seconds: number, rates: number[]): { ms: number; firstGuess: boolean } {
  const rate = median(rates.slice(-HISTORY_SIZE))
  const s = Math.max(0, seconds)
  if (rate == null) return { ms: Math.max(FIRST_GUESS_MIN_MS, Math.round(s * FIRST_GUESS_RATE * 1000)), firstGuess: true }
  return { ms: Math.max(1000, Math.round(s * rate * 1000)), firstGuess: false }
}

/**
 * The bar while Vmake works: from 20 % to 85 % as the clock runs through the estimate, held at
 * 85 % until Vmake says it's done, and never back. A real progress number (0–100) from Vmake
 * is used instead when it sends one.
 */
export function waitFraction(elapsedMs: number, expectedMs: number, previous = 0, reported = 0): number {
  const f = reported > 0 ? reported / 100 : elapsedMs / Math.max(1, expectedMs)
  const now = Math.round((WAIT_FROM + (WAIT_TO - WAIT_FROM) * Math.min(1, Math.max(0, f))) * 1e4) / 1e4
  return Math.min(WAIT_TO, Math.max(previous, now))
}

/** "40 s", "1 min", "12 min": a wait, rounded the way it's said. */
export function roughly(ms: number): string {
  const s = Math.max(0, ms / 1000)
  if (s < 55) return `${Math.max(5, Math.round(s / 5) * 5)} s`
  return `${Math.max(1, Math.round(s / 60))} min`
}

/**
 * What's left of the wait, in words: "about 40 s left", "about 1 min left (first estimate)",
 * or "taking longer than usual" once the estimate has passed.
 */
export function timeLeft(elapsedMs: number, expectedMs: number, firstGuess: boolean): string {
  const left = expectedMs - elapsedMs
  if (left <= 0) return firstGuess ? 'taking longer than the first estimate' : 'taking longer than usual'
  return `about ${roughly(left)} left${firstGuess ? ' (first estimate)' : ''}`
}
