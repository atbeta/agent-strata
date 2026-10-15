/**
 * When is a stop believed?
 *
 * The reader pressed stop, and something on screen has to say whether it landed.
 * Two things can go wrong and they are opposites: believing a stop that did not
 * happen, and disbelieving one that did. The second is what shipped: on a long
 * session the confirmation waited for the view to be re-fetched and say idle,
 * and the watchdog reported a stop that had already been accepted as one that
 * had not.
 *
 * The rule is kept here rather than inline so it can be held. It has one job:
 * say what counts as evidence, and refuse to wait on a re-fetch for it.
 */

export type StopVerdict =
  /** Still waiting on the backend to take the abort. */
  | "waiting"
  /** The backend took it. Say so. */
  | "confirmed"
  /** The view says nothing is running, even though the POST has not returned. */
  | "confirmed-by-view";

/**
 * `accepted` — the abort POST has returned 200. The service only answers after
 * the backend has taken the request, so this is the backend saying yes.
 *
 * `generating` — the session still reads as producing, from `busy`, a partial
 * message, or a prompt handed over and not yet answered.
 *
 * The one that matters is the first. The second is a re-fetch behind a signal
 * that is only as fresh as the last fetch, and on a long session it is the
 * slowest thing on screen; asking it to confirm something already answered
 * turns a stop that worked into a stop that did not.
 */
export function stopVerdict(accepted: boolean, generating: boolean): StopVerdict {
  if (accepted) return "confirmed";
  if (!generating) return "confirmed-by-view";
  return "waiting";
}

/** Whether the reader should be told the stop landed. */
export function stopConfirmed(accepted: boolean, generating: boolean): boolean {
  return stopVerdict(accepted, generating) !== "waiting";
}
