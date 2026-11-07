// A dub's clone of her voice lives in the user's ElevenLabs account only while Studio speaks with
// it (the user's rule: "after each ElevenLabs clone make sure it deletes the voice, or the user
// has the choice to keep it"). Each use clones her again from the sample kept in the dub's folder
// if there's no clone, speaks, and deletes it after, unless the user chose to keep it. Uses of one
// dub's clone run one at a time, so one never deletes the clone another is speaking with.
// No imports: node --test runs this file as it is (scripts/clone-lease.test.mjs).

export function cloneLease(o: {
  /** The clone there is now, if any. */
  id: () => string | undefined
  /** Clones her again; the new id. */
  make: () => Promise<string>
  /** Deletes it from the account. */
  drop: (id: string) => Promise<void>
  /** The user chose to keep it (or it isn't a clone Studio made). */
  keep: () => boolean
}) {
  let chain: Promise<unknown> = Promise.resolve()
  const queue = <T>(f: () => Promise<T>): Promise<T> => {
    const run = chain.then(f)
    chain = run.catch(() => {})
    return run
  }
  const tidy = async () => {
    const id = o.id()
    if (id && !o.keep()) await o.drop(id)
  }
  return {
    /** Runs `use` with the clone (made first if there's none), then deletes it unless it's kept. */
    use: <T>(use: (id: string) => Promise<T>): Promise<T> =>
      queue(async () => {
        const id = o.id() ?? (await o.make())
        try {
          return await use(id)
        } finally {
          await tidy().catch(() => {})
        }
      }),
    /** Deletes the clone now unless it's kept: after a dub's own clone was made, or Delete was picked. */
    tidy: () => queue(tidy),
  }
}
