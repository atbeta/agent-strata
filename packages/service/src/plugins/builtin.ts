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
import { manifest as backgroundManifest, createBackgroundPlugin } from "@agent-strata/plugin-background";
import { manifest as devManifest, createDevPlugin } from "@agent-strata/plugin-dev-process";
import { manifest as scheduleManifest, createSchedulePlugin } from "@agent-strata/plugin-schedule";
import { manifest as sessionsManifest, createSessionsPlugin } from "@agent-strata/plugin-sessions";
import { manifest as terminalManifest, createTerminalPlugin } from "@agent-strata/plugin-terminal";
import type { SessionView } from "@agent-strata/projector";
import type { SearchHit, SessionSummary } from "@agent-strata/store";

export interface BuiltinOptions {
  /** The service data directory; plugin state and per-plugin data live under it. */
  dataDir: string;
  /** Where a session's workspace is, for `guards.workspace` and the dev plugin. */
  workspaceOf: (sessionId: string) => string | undefined;
  /** Read access to the session store, for plugins that let an agent look at other sessions. */
  sessions: {
    list(opts: { workspace?: string; limit?: number; rootsOnly?: boolean }): SessionSummary[];
    search(
      query: string,
      opts: { workspace?: string; sessionId?: string; limit?: number },
    ): SearchHit[];
    view(sessionId: string): SessionView;
  };
  /** Acting on sessions on the user's behalf — the same paths the HTTP routes take. */
  sessionControl: {
    connections(): { id: string; agent: string; canPrompt: boolean }[];
    connectionOf(sessionId: string): string | undefined;
    /** throws a readable Error on an unknown connection or one that cannot prompt */
    create(opts: { connectionId: string; title?: string; directory?: string }): Promise<{ sessionId: string }>;
    /** throws when no backend owns the session */
    prompt(sessionId: string, text: string): Promise<void>;
  };
}

export function builtinPlugins(options: BuiltinOptions): RegisteredPlugin[] {
  return [
    {
      manifest: backgroundManifest,
      create: () => createBackgroundPlugin(),
    },
    {
      manifest: devManifest,
      // dev servers are the app's own long-lived processes, so the pid table
      // sits where the old service-level manager kept it
      create: () => createDevPlugin({ pidFile: `${options.dataDir}/dev-processes.json`, workspaceOf: options.workspaceOf }),
    },
    {
      manifest: terminalManifest,
      create: () => createTerminalPlugin({ workspaceOf: options.workspaceOf }),
    },
    {
      manifest: sessionsManifest,
      // read-only store access plus the same workspace lookup every builtin
      // gets — a plugin that reads sessions cannot create one
      create: () => createSessionsPlugin({ ...options.sessions, workspaceOf: options.workspaceOf }),
    },
    {
      manifest: scheduleManifest,
      // the acting surface, not the read one — its timer may only do what a
      // user prompt already does
      create: () =>
        createSchedulePlugin({
          control: options.sessionControl,
          view: options.sessions.view,
          workspaceOf: options.workspaceOf,
          // The target picker lists sessions by name. The workspace is
          // passed by the plugin, and the store filters on it, so the
          // list holds one workspace's sessions and no others.
          listSessions: (opts) =>
            options.sessions.list(opts).map((s) => ({
              session_id: s.session_id,
              title: s.title,
              workspace: s.workspace,
            })),
        }),
    },
  ];
}
