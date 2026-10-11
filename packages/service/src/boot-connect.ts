import { endpointOf, type ConnectBody } from "./connections";

export type BootMode = "retry" | "once";

/** A remembered address that is not the one we are opening gets this long, once. */
export const REMEMBERED_PROBE_MS = 1_500;

/**
 * The address we mean to use keeps retrying until the boot deadline.
 * Every other remembered address is probed once.
 * With an explicit URL, that URL is the one. Otherwise the most recently remembered is.
 */
export function bootPlan(
  bodies: ConnectBody[],
  explicit?: string,
): { body: ConnectBody; mode: BootMode }[] {
  if (bodies.length === 0) return [];
  const named = explicit !== undefined && bodies.some((body) => endpointOf(body) === explicit);
  const key = named ? explicit : endpointOf(bodies[bodies.length - 1]!);
  return bodies.map((body) => ({
    body,
    mode: endpointOf(body) === key ? "retry" : "once",
  }));
}
