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
 */

const NONE: ReadonlySet<string> = new Set<string>();

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

export function createEntranceLedger(): EntranceLedger {
  let session: string | null = null;
  let painted = new Set<string>();
  let entered = new Set<string>();
  let primed = false;
  return {
    arriving(who, ids) {
      if (who !== session) {
        session = who;
        primed = false;
        entered = new Set();
      }
      // An empty column is not a look. A session still loading would otherwise
      // be remembered as having nothing in it, and would then announce its
      // entire history as newly arrived when it landed.
      if (ids.length === 0) return NONE;
      if (!primed) {
        primed = true;
        painted = new Set(ids);
        return NONE;
      }
      for (const id of ids) if (!painted.has(id)) entered.add(id);
      painted = new Set(ids);
      return entered.size ? entered : NONE;
    },
  };
}
