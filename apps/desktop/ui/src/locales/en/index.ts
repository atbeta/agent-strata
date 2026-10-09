import type { MessageKey } from "../zh";
import shell from "./shell";
import session from "./session";
import reading from "./reading";
import trace from "./trace";
import policy from "./policy";

const merged = { ...shell, ...session, ...reading, ...trace, ...policy };

/**
 * The parity check. This line is the whole reason the file exists in this
 * shape: a key present in `zh` and missing here is a type error, not a gap
 * someone has to notice by reading the interface in the other language.
 */
const complete: Record<MessageKey, string> = merged;

export { complete as en };