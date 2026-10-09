import shell from "./shell";
import session from "./session";
import reading from "./reading";
import trace from "./trace";
import policy from "./policy";

/**
 * Chinese is the source of truth for the key set, not an accident of ordering.
 * `en` is typed against the keys collected here, so a string added in one
 * dictionary and forgotten in the other fails the build instead of reaching a
 * reader as a bare `session.empty` in the middle of the interface.
 */
export const zh = { ...shell, ...session, ...reading, ...trace, ...policy };

export type MessageKey = keyof typeof zh & string;

/** A counted thing: `tn("session.files", n)` picks `.one` or `.other`. */
type OneKeys = Extract<MessageKey, `${string}.one`>;
export type PluralKey = OneKeys extends `${infer Base}.one` ? Base : never;