// The builtin plugins, one line each.
//
// A static array rather than a scan of `packages/*/plugin.json`: the import is
// what makes the registration typechecked and the plugin present in a compiled
// sidecar, and a scan would be a second, runtime-only way for a package to be
// "there" without anything importing it. Adding a capability is one import and
// one line — which is the seam this whole design is built around, stated in the
// only place a reader will look for it.
//
// Third-party plugins (M4) are the case a directory scan is for, and the
// manifest format they will be read with is the same one these use.
//
// The browser plugin is deliberately *not* here. It is a real capability built
// on this seam, but it is not ready to ship: the panel's frame path can wedge
// a rail, and a capability nobody can switch off from a menu should not be in
// the box. It lives on `local/browser-plugin` until that is settled.
//
// The `echo` reference plugin is deliberately *not* here. It exists to prove
// that a capability is a package and a line of registration, and a proof that
// ships is a tool every user sees: its three tools would appear in the tool
// list of every OpenCode on the machine, its system prompt would join every
// prompt, and its panel would add a tab nobody asked for. Tests register it
// through `ServiceOpts.plugins`.

import type { RegisteredPlugin } from "./host";
import { manifest as devManifest, createDevPlugin } from "@agent-strata/plugin-dev-process";

export interface BuiltinOptions {
  /** The service data directory; plugin state and per-plugin data live under it. */
  dataDir: string;
  /** Where a session's workspace is, for `guards.workspace` and the dev plugin. */
  workspaceOf: (sessionId: string) => string | undefined;
}

export function builtinPlugins(options: BuiltinOptions): RegisteredPlugin[] {
  return [
    {
      manifest: devManifest,
      // dev servers are the app's own long-lived processes, so the pid table
      // sits where the old service-level manager kept it
      create: () => createDevPlugin({ pidFile: `${options.dataDir}/dev-processes.json`, workspaceOf: options.workspaceOf }),
    },
  ];
}
