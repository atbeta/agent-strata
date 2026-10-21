import { createSignal } from "solid-js";

/**
 * A transcript hit picked in the global palette, waiting for the session page
 * to open and take it.
 *
 * The palette searches the whole store, so it knows the query and the session
 * but not the turn: that belongs to the view the session page loads. Handing
 * the query over rather than a turn index lets the page resolve the hit against
 * the transcript it actually has, including tool results that only name a call.
 */
export interface SearchTarget {
  sessionId: string;
  query: string;
}

const [target, setTarget] = createSignal<SearchTarget>();

/** The live target. Reading it in a render pass subscribes to a new hit. */
export function searchTarget(): SearchTarget | undefined {
  return target();
}

export function requestSearchTarget(sessionId: string, query: string): void {
  setTarget({ sessionId, query });
}

export function clearSearchTarget(): void {
  setTarget(undefined);
}
