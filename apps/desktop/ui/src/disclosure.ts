import { createContext, useContext } from "solid-js";

/**
 * The reader's open and closed choices in one transcript — a thought, a tool
 * run, a call's output — by the key each block names itself with.
 *
 * A choice belongs to the conversation it was made in, not to the element
 * that drew it: the window unmounts rows as the reader scrolls, and a choice
 * kept in the component was gone when the row came back. A module map kept
 * it, but for every pane and session at once, for the life of the app.
 */
export interface Disclosure {
  get(key: string): boolean | undefined;
  set(key: string, open: boolean): void;
}

/** Outside a transcript nothing is remembered; the block's own state is all there is. */
const forgetful: Disclosure = { get: () => undefined, set: () => undefined };

export const DisclosureContext = createContext<Disclosure>(forgetful);

export function useDisclosure(): Disclosure {
  return useContext(DisclosureContext);
}
