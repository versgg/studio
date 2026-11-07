// A dub's clone that ElevenLabs won't speak with until the voice is verified ("This voice requires
// verification", voice_access_denied): the user's rule is to delete it and clone the voice again.
// Once per run: a voice refused again stops with what to do, instead of cloning on and on.

/** ElevenLabs' code for a voice that may not speak until it's verified. */
export const NEEDS_VERIFYING = 'voice_access_denied'

export const needsVerifying = (e: unknown) => (e as { code?: string } | null)?.code === NEEDS_VERIFYING

/**
 * Speaks with a clone (`voiceId`, read at each call); refused until verified, `reclone` deletes it
 * and clones again (the new id, or null when it can't), and that one speaks. Refused again, or a
 * second refusal in the same run, throws `refused()`.
 */
export function cloneSpeaker(o: { voiceId: () => string; reclone: (refused: string) => Promise<string | null>; refused: () => Error }) {
  let tried = false
  return async <T>(speak: (voiceId: string) => Promise<T>): Promise<T> => {
    const id = o.voiceId()
    try {
      return await speak(id)
    } catch (e) {
      if (!needsVerifying(e)) throw e
      if (tried) throw o.refused()
      tried = true
      const again = await o.reclone(id)
      if (!again) throw o.refused()
      try {
        return await speak(again)
      } catch (e2) {
        throw needsVerifying(e2) ? o.refused() : e2
      }
    }
  }
}
