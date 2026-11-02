/**
 * Which turns may play the entrance animation.
 *
 * A CSS entrance belongs to the life of the element it is on, and the life of a
 * transcript row is not the life of a turn. The virtual window unmounts rows as
 * the reader scrolls and rebuilds the whole column when they change session, so
 * anything keyed to the element replays on navigation — which is how a column
 * that is merely *being read* ends up shimmering every time the reader changes
 * conversation. Moving the class from the message to the turn did not help: the
 * turn root is exactly as replaceable as the message inside it.
 *
 * So the entrance is decided by identity instead. It means "this arrived while
 * you were already here", which is the only reading worth animating: a column
 * built in one pass because the reader asked for a different conversation is a
 * page, not news.
 *
 * ## Why an arrival expires
 *
 * Being an arrival is a moment, not a property. A turn used to be remembered as
 * arriving for the rest of the session, and while a reply streams the virtual
 * window mounts and unmounts rows constantly as the content grows — so every
 * remount replayed the entrance. The whole column faded in over and over for as
 * long as the answer kept coming, which is the flicker readers reported. A turn
 * stops being news `ARRIVAL_MS` after it landed.
 */

const NONE: ReadonlySet<string> = new Set<string>();

/**
 * How long a turn stays "arriving", in milliseconds.
 *
 * A little longer than the 0.16s entrance, so the class is still on the element
 * when the animation finishes rather than being pulled out from under it. It
 * has to expire: the entrance is tied to the element, so a row that remounts
 * while the class is still on it replays from the first frame.
 */
export const ARRIVAL_MS = 250;

export interface EntranceLedger {
  /**
   * The turns that have moved in since the reader arrived at `session`, and
   * remembers everything now on screen.
   *
   * The session id is the reset. Keying the reset off an effect instead would
   * leave it racing the render — the rows could be built before the reset ran —
   * and a race here fails by animating the whole column, which is the bug.
   */
  arriving(session: string, ids: readonly string[]): ReadonlySet<string>;
}

export function createEntranceLedger(now: () => number = Date.now): EntranceLedger {
  let session: string | null = null;
  let painted = new Set<string>();
  /** Turn id → when it arrived. Anything older than `ARRIVAL_MS` is forgotten. */
  let entered = new Map<string, number>();
  let primed = false;
  /** Handed out again while the set of arrivals is unchanged. */
  let snapshot: ReadonlySet<string> = NONE;

  return {
    arriving(who, ids) {
      if (who !== session) {
        session = who;
        primed = false;
        entered = new Map();
        snapshot = NONE;
      }
      // An empty column is not a look. A session still loading would otherwise
      // be remembered as having nothing in it, and would then announce its
      // entire history as newly arrived when it landed.
      if (ids.length === 0) return NONE;
      if (!primed) {
        primed = true;
        painted = new Set(ids);
        snapshot = NONE;
        return NONE;
      }
      const at = now();
      let changed = false;
      for (const [id, when] of entered) {
        if (at - when >= ARRIVAL_MS) {
          entered.delete(id);
          changed = true;
        }
      }
      for (const id of ids) {
        if (!painted.has(id)) {
          entered.set(id, at);
          changed = true;
        }
      }
      painted = new Set(ids);
      // Identity is kept while nothing moved: the row reads this as it is
      // built, and a fresh set on every streaming tick churns every mounted
      // turn for no reason.
      if (changed || snapshot === NONE) {
        snapshot = entered.size ? new Set(entered.keys()) : NONE;
      }
      return snapshot;
    },
  };
}
