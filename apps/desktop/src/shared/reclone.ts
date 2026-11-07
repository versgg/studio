// A dub's clone that ElevenLabs won't speak with until the voice is verified ("This voice requires
// verification", voice_access_denied): the user's rule is to delete it and clone the voice again.
// A clone that's gone from the account (voice_not_found) is cloned again the same way.
// Once per run: a voice refused again stops with what to do, instead of cloning on and on.

/** ElevenLabs' code for a voice that may not speak until it's verified. */
export const NEEDS_VERIFYING = 'voice_access_denied'
/** ElevenLabs' code for a voice id the account doesn't have (deleted, or never kept). */
export const VOICE_GONE = 'voice_not_found'

export type Refusal = 'verify' | 'gone'

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code
export const needsVerifying = (e: unknown) => codeOf(e) === NEEDS_VERIFYING
/** Why ElevenLabs won't speak with a voice, when it's one cloning again can fix. */
export const refusal = (e: unknown): Refusal | null => (codeOf(e) === NEEDS_VERIFYING ? 'verify' : codeOf(e) === VOICE_GONE ? 'gone' : null)

/**
 * Speaks with a clone (`voiceId`, read at each call); refused until verified or gone, `reclone`
 * clones again (deleting a refused one; the new id, or null when it can't), and that one speaks.
 * Refused again, or a second refusal in the same run, throws `refused(why)`.
 */
export function cloneSpeaker(o: { voiceId: () => string; reclone: (old: string, why: Refusal) => Promise<string | null>; refused: (why: Refusal) => Error }) {
  let tried = false
  return async <T>(speak: (voiceId: string) => Promise<T>): Promise<T> => {
    const id = o.voiceId()
    try {
      return await speak(id)
    } catch (e) {
      const why = refusal(e)
      if (!why) throw e
      if (tried) throw o.refused(why)
      tried = true
      const again = await o.reclone(id, why)
      if (!again) throw o.refused(why)
      try {
        return await speak(again)
      } catch (e2) {
        const still = refusal(e2)
        throw still ? o.refused(still) : e2
      }
    }
  }
}
