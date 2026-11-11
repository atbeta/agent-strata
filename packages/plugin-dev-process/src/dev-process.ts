import { createManager } from "./manager";
import type { DevManager, DevManagerOptions } from "./types";

export type { DevStopResult } from "@agent-strata/api";
export { childEnv, chooseWindowsShell, commandName, existingDirectory, looksLongRunning } from "./command";
export { readRecords } from "./registry";
export { commandShell } from "./system";
export type {
  DevEvent,
  DevLogLine,
  DevLogPage,
  DevLost,
  DevManager,
  DevManagerOptions,
  DevProcess,
  DevStartInput,
  DevState,
} from "./types";
export { canonicalPath, insideWorkspace, pathInside, resolveWorkdir, stopInside } from "./workspace";

export function createDevManager(options: DevManagerOptions = {}): DevManager {
  return createManager(options);
}
