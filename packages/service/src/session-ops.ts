// The session operations the routes and the built-in plugin surface share.
//
// A session a backend creates has to be adopted — routed to the connection
// that made it, remembered by directory, claimed by identity — and a prompt
// has to go out the way `/sessions/:id/prompt` sends it, touched mark and
// all. Both live here so the HTTP route and a built-in's `sessionControl`
// cannot drift into two answers to "how does the layer act on a session".

import type { ConnectionRegistry } from "./connection-registry";
import type { BackendDriver, PromptOpts, PromptPart } from "./driver";
import type { GoalRunner } from "./goal-runner";
import type { SessionClaims } from "./identity";

/** What the session operations need; the service's route deps already carry all of it. */
export interface SessionOpsDeps {
  connections: ConnectionRegistry;
  claims: SessionClaims;
  createdDirs: Map<string, string>;
  /** sessions an input accepted — the event proving it has not landed yet */
  touched: Set<string>;
  goalRunner: GoalRunner;
  directoryOf(sessionId: string): string | undefined;
  driverFor(sessionId: string): BackendDriver | undefined;
}

/**
 * Take ownership of a session a backend just created: route it to the
 * connection that made it, remember the directory it was asked for — the
 * session has no events yet, so this is the only place its workspace can
 * come from — and claim the backend identity so no second channel writes a
 * copy of it under its own id.
 */
export function adoptSession(
  deps: SessionOpsDeps,
  conn: BackendDriver,
  created: { casfId: string; nativeId: string },
  directory?: string,
): void {
  deps.connections.own(created.casfId, conn.id);
  if (directory) deps.createdDirs.set(created.casfId, directory);
  deps.claims.claim(`${conn.agent}:${created.nativeId}`, created.casfId, conn.id);
}

/**
 * Send a prompt the way the prompt route does: let a paused goal run again,
 * mark the session touched until the turn lands — a conditional delete
 * arriving first must already see it used — and take the mark back when the
 * backend refuses.
 */
export async function sendPrompt(
  deps: SessionOpsDeps,
  sessionId: string,
  conn: BackendDriver,
  native: string,
  parts: PromptPart[],
  opts: PromptOpts = {},
): Promise<void> {
  deps.goalRunner.allow(sessionId);
  // The request is accepted — its turn is only a store event away, but a
  // conditional delete arriving first must already see the session used.
  deps.touched.add(sessionId);
  try {
    await conn.prompt(native, parts, { ...opts, directory: deps.directoryOf(sessionId) });
  } catch (error) {
    // A send the backend refused is not a used session.
    deps.touched.delete(sessionId);
    throw error;
  }
}

/**
 * The `sessionControl` surface built-ins are injected with: acting on
 * sessions the way the HTTP routes do, so a plugin's prompt is
 * indistinguishable from the user's.
 */
export function makeSessionControl(deps: SessionOpsDeps) {
  return {
    connections: () =>
      [...deps.connections.values()].map((conn) => ({
        id: conn.id,
        agent: conn.agent,
        canPrompt: conn.capabilities.prompt,
      })),
    connectionOf: (sessionId: string) => deps.connections.connectionOf(sessionId),
    create: async (opts: { connectionId: string; title?: string; directory?: string }) => {
      const conn = deps.connections.get(opts.connectionId);
      if (!conn) throw new Error(`no such connection: ${opts.connectionId}`);
      if (!conn.capabilities.prompt) {
        throw new Error(`connection ${opts.connectionId} cannot create sessions`);
      }
      const created = await conn.createSession({ title: opts.title, directory: opts.directory });
      adoptSession(deps, conn, created, opts.directory);
      return { sessionId: created.casfId };
    },
    prompt: async (sessionId: string, text: string) => {
      const conn = deps.driverFor(sessionId);
      if (!conn) throw new Error("no backend connected");
      const native = conn.nativeId(sessionId);
      if (!native) throw new Error("session is not owned by a connected backend");
      deps.connections.own(sessionId, conn.id);
      await sendPrompt(deps, sessionId, conn, native, [{ type: "text", text }]);
    },
  };
}
