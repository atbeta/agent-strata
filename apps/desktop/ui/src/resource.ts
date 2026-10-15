/**
 * An errored Solid resource throws when read, which unmounts the whole window.
 *
 * This is the right trade for the transcript: a view that will not load has no
 * useful half-state, so showing a full-window failure beats showing nothing.
 * It is the wrong trade for the pending prompts, which live in the dock beside
 * a composer that still works. `settled()` turns a failed `/questions` fetch
 * into "there are no questions" — the card vanishes, the session sits at
 * 运行中 with nothing to answer, and nothing anywhere says why. The dock
 * reads `questions.error` directly for exactly that reason.
 */
export function settled<T>(resource: { error: unknown; (): T | undefined }): T | undefined {
  return resource.error ? undefined : resource();
}
