import type { StreamingSnapshot } from "./live";

/**
 * Transcript writes held back while the reader is scrolling history.
 *
 * A gesture already spends the frame on layout. Partial replies and tail
 * refreshes in that same stretch rebuild the column the reader is moving
 * through. They wait, and the latest one is applied once the gesture ends.
 * A full refresh replaces a tail refresh; a newer snapshot replaces the one
 * held before it.
 */
export type HeldRefresh = "tail" | "full";

export function createScrollDeferral() {
  let snap: StreamingSnapshot | undefined;
  let refresh: HeldRefresh | undefined;

  return {
    noteSnap(next: StreamingSnapshot) {
      snap = next;
    },
    noteRefresh(full: boolean) {
      if (refresh === "full") return;
      refresh = full ? "full" : "tail";
    },
    pending() {
      return snap !== undefined || refresh !== undefined;
    },
    take() {
      const held = { snap, refresh };
      snap = undefined;
      refresh = undefined;
      return held;
    },
  };
}

/**
 * Hold transcript writes only while a scroll gesture is in progress and the
 * reader has left the tail. Following the tail is the reader watching the
 * reply arrive, so those updates keep painting.
 */
export function deferTranscriptWrite(gesturing: boolean, following: boolean): boolean {
  return gesturing && !following;
}
