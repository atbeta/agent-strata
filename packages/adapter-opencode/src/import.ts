import type { Event, OpencodeClient, Session } from "@opencode-ai/sdk/v2";
import { OPENCODE_MAPPER_VERSION, OPENCODE_REBUILT_TYPES, rebuildEvents, snapshotEvents } from "./map";
import type { OpencodeSyncGuard, Sink } from "./types";

/**
 * A full import. One snapshot is one append, and the write for the next session
 * waits until the event loop has had a turn.
 */

export function createSessionImport(args: {
  client: OpencodeClient;
  directory?: string;
  sink: Sink;
  ingestor: {
    handle: (evt: Event) => void;
    handleBatch: (events: Event[]) => void;
  };
}) {
  const { client, ingestor } = args;
  const opts = { directory: args.directory, sink: args.sink };

  const importedRevision = new Map<string, number>();
  /** In-memory first, then what the store recorded on an earlier run. */
  const knownRevision = (sessionID: string) =>
    importedRevision.get(sessionID) ?? opts.sink.sessionRevision?.(`opencode:${sessionID}`) ?? undefined;
  const noteRevision = (sessionID: string, rev: number) => {
    importedRevision.set(sessionID, rev);
    opts.sink.markRevision?.(`opencode:${sessionID}`, rev);
  };
  const sessionInfo = async (sessionID: string, directory?: string): Promise<Session> => {
    const sess = await client.session.get({ sessionID, directory: directory ?? opts.directory });
    if (!sess.data) throw new Error(`session ${sessionID} not found`);
    return sess.data;
  };
  const readSession = async (sessionID: string, directory?: string): Promise<Event[]> => {
    const info = await sessionInfo(sessionID, directory);
    const msgs = await client.session.messages({ sessionID, directory: directory ?? opts.directory });
    return snapshotEvents(sessionID, info, msgs.data ?? []);
  };
  const fetchSnapshot = async (
    sessionID: string,
    directory?: string,
    options: { force?: boolean } = {},
  ): Promise<{ updated: number; events: Event[] } | null> => {
    const info = await sessionInfo(sessionID, directory);
    // The session doc carries its own revision. An unchanged one means the
    // messages fetch — the expensive part, the whole transcript — would replay
    // exactly what the store already holds, so a click on a session the
    // listener already imported costs one small GET instead.
    const updated = info.time?.updated ?? info.time?.created ?? 0;
    if (!options.force && knownRevision(sessionID) === updated) return null;
    const msgs = await client.session.messages({ sessionID, directory: directory ?? opts.directory });
    return { updated, events: snapshotEvents(sessionID, info, msgs.data ?? []) };
  };
  const importSession = async (
    sessionID: string,
    directory?: string,
    options: { force?: boolean } = {},
  ): Promise<boolean> => {
    const snap = await fetchSnapshot(sessionID, directory, options);
    if (!snap) return false;
    ingestor.handleBatch(snap.events);
    noteRevision(sessionID, snap.updated);
    return true;
  };
  const rebuildSession = async (sessionID: string, directory?: string): Promise<number> => {
    if (!opts.sink.replaceSession) throw new Error("this sink cannot rebuild sessions");
    const events = rebuildEvents(await readSession(sessionID, directory), opts.directory);
    await opts.sink.replaceSession(`opencode:${sessionID}`, events, {
      replaceTypes: OPENCODE_REBUILT_TYPES,
      mapper: OPENCODE_MAPPER_VERSION,
    });
    return events.length;
  };

  /** Sync crawl fans out over session trees; bound it so one idle poll is cheap. */
  const SYNC_CONCURRENCY = 6;
  const mapLimit = async <T>(items: T[], limit: number, fn: (item: T) => Promise<void>) => {
    let i = 0;
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) await fn(items[i++]!);
      }),
    );
  };

  /**
   * Breadth-first over every pending session's children, one level at a time:
   * a level's `children` calls run at SYNC_CONCURRENCY, then its visits, then
   * the next level is queued. `seen` starts with the frontier's own ids, so a
   * cycle or a repeat across roots is walked once.
   */
  const walkChildren = async (
    pending0: { sessionID: string; directory: string | undefined }[],
    visit: (info: Session, directory: string | undefined) => Promise<void> | void,
  ) => {
    const seen = new Set(pending0.map((p) => p.sessionID));
    let frontier = pending0;
    while (frontier.length) {
      const next: { info: Session; directory: string | undefined }[] = [];
      await mapLimit(frontier, SYNC_CONCURRENCY, async ({ sessionID, directory }) => {
        let kids;
        try {
          kids = await client.session.children({ sessionID, directory });
        } catch (err) {
          console.error(`opencode children failed for ${sessionID}:`, err);
          return;
        }
        for (const info of kids.data ?? []) {
          if (!info?.id || seen.has(info.id)) continue;
          seen.add(info.id);
          next.push({ info, directory });
        }
      });
      await mapLimit(next, SYNC_CONCURRENCY, async ({ info, directory }) => {
        await visit(info, directory);
      });
      frontier = next.map(({ info, directory }) => ({ sessionID: info.id, directory }));
    }
  };

  /** Project directories the pending-ask reads are scoped to; sync keeps it current. */
  const knownDirectories = new Set<string | undefined>([opts.directory]);

  /**
   * Prompts waiting on a user answer live server-side, not on the event
   * bus: an ask raised while this connection was down never reaches us as
   * `permission.asked`, and the session sits busy forever with no card.
   * The server owns a list of them — replaying each as the asked event
   * runs the same policy and prompt path a live ask would, and the
   * ingestor's inflight set makes a re-poll a no-op.
   *
   * The lists are scoped per project directory: an unscoped call only
   * sees asks bound to the server's own root, which is why this runs per
   * known directory (plus once unscoped for that root).
   */
  const restorePendingPrompts = async (directories: Set<string | undefined>) => {
    const pending: Event[] = [];
    const seen = new Set<string>();
    await mapLimit([undefined, ...directories], SYNC_CONCURRENCY, async (directory) => {
      const [perms, questions] = await Promise.all([
        client.permission.list({ directory }).then(
          (r) => r.data ?? [],
          (err) => {
            console.error("opencode permission list failed:", err);
            return [];
          },
        ),
        client.question.list({ directory }).then(
          (r) => r.data ?? [],
          (err) => {
            console.error("opencode question list failed:", err);
            return [];
          },
        ),
      ]);
      for (const req of perms) {
        if (seen.has(`p:${req.id}`)) continue;
        seen.add(`p:${req.id}`);
        pending.push({
          id: `restore:permission:${req.id}`,
          type: "permission.asked",
          properties: req,
        } as Event);
      }
      for (const req of questions) {
        if (seen.has(`q:${req.id}`)) continue;
        seen.add(`q:${req.id}`);
        pending.push({
          id: `restore:question:${req.id}`,
          type: "question.asked",
          properties: req,
        } as Event);
      }
    });
    for (const evt of pending) ingestor.handle(evt);
  };

  const indexSessions = async () => {
    const sessions = await client.session.list({ directory: opts.directory, roots: true, limit: 80 });
    const roots = (sessions.data ?? []).filter((i): i is Session => !!i?.id);
    const ids: string[] = [];
    const visit = async (info: Session) => {
      ingestor.handle({
        id: `index:${info.id}`,
        type: "session.updated",
        properties: { sessionID: info.id, info },
      } as Event);
      ids.push(info.id);
    };
    for (const info of roots) await visit(info);
    await walkChildren(
      roots.map((r) => ({ sessionID: r.id, directory: r.directory || opts.directory })),
      visit,
    );
    return ids;
  };

  /**
   * Re-read every project the server knows and pull transcripts that moved
   * since the last sync. Safe to call repeatedly: an unchanged session is
   * not imported again. Two phases — a concurrent metadata crawl that makes
   * every session a row, then a concurrent import of only what moved.
   */
  const refreshSessions = async (guard?: OpencodeSyncGuard) => {
    const directories = knownDirectories;
    directories.clear();
    directories.add(opts.directory);
    try {
      const projects = await client.project.list();
      for (const project of projects.data ?? []) {
        if (project.worktree) directories.add(project.worktree);
        for (const sandbox of project.sandboxes ?? []) directories.add(sandbox);
      }
    } catch (err) {
      console.error("opencode project list failed:", err);
    }
    await restorePendingPrompts(directories);
    const seen = new Set<string>();
    const found: { info: Session; directory: string | undefined }[] = [];
    const collect = (info: Session, directory: string | undefined) => {
      if (!info?.id || seen.has(info.id)) return;
      seen.add(info.id);
      // The same session can be driven over another channel at once. Whoever
      // holds it writes it; touching it here would make a second copy of a
      // conversation the user is already watching.
      if (guard?.taken?.(`opencode:${info.id}`)) return;
      // Sync walks every project the server knows while indexSessions walks
      // one, so most sessions arrive by this road. Claiming here is what
      // keeps a second OpenCode from making all of them unroutable.
      guard?.claimed?.(`opencode:${info.id}`);
      try {
        ingestor.handle({
          id: `sync:${info.id}:${info.time?.updated ?? 0}`,
          type: "session.updated",
          properties: { sessionID: info.id, info },
        } as Event);
        found.push({ info, directory: info.directory || directory });
      } catch (err) {
        console.error(`sync session ${info.id} failed:`, err);
      }
    };
    await mapLimit([...directories], SYNC_CONCURRENCY, async (directory) => {
      let sessions;
      try {
        sessions = await client.session.list({ directory, roots: true, limit: 80 });
      } catch (err) {
        console.error(`opencode session list failed for ${directory ?? "(default)"}:`, err);
        return;
      }
      const roots = (sessions.data ?? []).filter((i): i is Session => !!i?.id);
      for (const info of roots) collect(info, directory);
      await walkChildren(
        roots.map((r) => ({ sessionID: r.id, directory: r.directory || directory })),
        (info, directory) => collect(info, directory),
      );
    });
    // Local sessions the crawl never saw were deleted while nobody was
    // listening — a delete in the TUI only reaches clients connected at the
    // time — or were missed by the listing. One direct lookup settles which:
    // a session that still answers joins the found set and is imported below;
    // a 404 goes down the same session.deleted road a live delete would have.
    //
    // A crawl that found nothing is not evidence of anything. An empty listing
    // is what a wrong port, a changed data directory, or a reinstall looks
    // like, and the per-session lookup below cannot tell those apart from a
    // genuine wipe — it answers 404 either way, because it is asking the same
    // server that just said it has nothing. Believing it would mark every
    // session the reader ever had as deleted and empty the sidebar. Losing a
    // real deletion until the next sync costs one stale row; the other way
    // round costs the entire history.
    const crawled = seen.size > 0;
    const ghosts = crawled
      ? (guard?.local?.() ?? []).filter((g) => g.id && !seen.has(g.id))
      : [];
    await mapLimit(ghosts, SYNC_CONCURRENCY, async ({ id, directory }) => {
      let res;
      try {
        res = await client.session.get({ sessionID: id, directory });
        // The stored workspace may have drifted since the session was read;
        // a miss there is not proof either, so ask once more unscoped.
        if (!res.data && directory !== undefined) {
          res = await client.session.get({ sessionID: id });
        }
      } catch {
        // An unreachable server is not proof of a delete.
        return;
      }
      if (res.data) {
        collect(res.data, res.data.directory ?? directory);
        return;
      }
      if (res.response?.status !== 404) return;
      try {
        ingestor.handle({
          id: `reconcile:${id}`,
          type: "session.deleted",
          properties: { sessionID: id },
        } as Event);
        guard?.reconciled?.(`opencode:${id}`);
      } catch (err) {
        console.error(`reconcile session ${id} failed:`, err);
      }
    });
    let imported = 0;
    let done = 0;
    guard?.progress?.(0, found.length);
    const tick = () => {
      done += 1;
      // One broadcast per session would turn a steady-state poll into a
      // stream of its own; the UI only needs landmarks.
      if (done % 8 === 0 || done === found.length) guard?.progress?.(done, found.length);
    };
    // Message bodies overlap, up to SYNC_CONCURRENCY. The write does not:
    // one transcript is one synchronous transaction, and the next waits
    // until the event loop has had a turn, so a view or a list can get in
    // between sessions. A body is released once its write finishes.
    let write = Promise.resolve();
    const turn = (fn: () => Promise<void>) => {
      const run = write.then(async () => {
        try {
          await fn();
        } finally {
          // Bun.sleep(0) resumes before timers and sockets already waiting.
          // A macrotask is what lets a view request in between transcripts.
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      });
      write = run.then(
        () => {},
        () => {},
      );
      return run;
    };
    await mapLimit(found, SYNC_CONCURRENCY, async ({ info, directory }) => {
      const updated = info.time?.updated ?? info.time?.created ?? 0;
      if (knownRevision(info.id) === updated) {
        tick();
        return;
      }
      try {
        if (guard?.stale?.(`opencode:${info.id}`)) {
          await turn(async () => {
            await rebuildSession(info.id, directory);
            noteRevision(info.id, updated);
            imported += 1;
          });
        } else {
          const snap = await fetchSnapshot(info.id, directory);
          if (snap) {
            await turn(async () => {
              ingestor.handleBatch(snap.events);
              noteRevision(info.id, snap.updated);
              imported += 1;
            });
          }
        }
      } catch (err) {
        console.error(`sync session ${info.id} failed:`, err);
      }
      tick();
    });
    return imported;
  };

  return {
    knownDirectories,
    importSession,
    rebuildSession,
    indexSessions,
    restorePendingPrompts,
    refreshSessions,
  };
}
