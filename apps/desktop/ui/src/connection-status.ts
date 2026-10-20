import type { ConnectionPhaseName, ConnectionsResponse } from "./api";

/**
 * What the window may say about backends before `/connections` has answered.
 *
 * `pending` is the gap between paint and the first response. Treating that gap
 * as "nothing is connected" is how the first frame asked someone to fix a
 * backend the app was still dialing. `unreachable` is the service itself
 * failing to answer, which is a different fact from a backend that is gone.
 */
export type ViewPhase = ConnectionPhaseName | "pending" | "unreachable";

export function viewPhase(
  snapshot: Pick<ConnectionsResponse, "phase" | "connections"> | undefined,
  error: unknown,
): ViewPhase {
  if (!snapshot) return error ? "unreachable" : "pending";
  if (snapshot.phase) return snapshot.phase;
  return snapshot.connections.length > 0 ? "connected" : "idle";
}

export type BackendHeadline = "connecting" | "failed" | "missing" | "unreachable" | "none";

/** The footer line when there is no live row to show. */
export function backendHeadline(phase: ViewPhase): BackendHeadline {
  if (phase === "pending" || phase === "attaching") return "connecting";
  if (phase === "failed") return "failed";
  if (phase === "missing") return "missing";
  if (phase === "unreachable") return "unreachable";
  return "none";
}

export type SidebarEmptyKind =
  | "connecting"
  | "failed"
  | "missing"
  | "unreachable"
  | "listError"
  | "none"
  | "needBackend"
  | "hidden";

/**
 * Which empty sentence the sidebar is allowed to show.
 *
 * "Connect a backend to see sessions" is a conclusion. It waits until the
 * connection list has come back idle. While the list is still in flight, or a
 * backend is still being dialed, the sentence is the connecting one — the
 * same one the footer uses — so the two surfaces cannot disagree.
 */
export function sidebarEmptyKind(input: {
  phase: ViewPhase;
  listSettled: boolean;
  listError: boolean;
}): SidebarEmptyKind {
  if (input.listError) return "listError";
  if (input.phase === "pending" || input.phase === "attaching") return "connecting";
  if (input.phase === "failed") return "failed";
  if (input.phase === "missing") return "missing";
  if (input.phase === "unreachable") return "unreachable";
  if (input.phase === "connected" && !input.listSettled) return "hidden";
  if (input.listSettled) return "none";
  return "needBackend";
}
