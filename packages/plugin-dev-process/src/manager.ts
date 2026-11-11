import { isDirectory } from "./command";
import { Entry } from "./entry";
import { readRecords, writeRecords } from "./registry";
import { defaultSystem, systemClock, type Clock, type System } from "./system";
import type {
  DevEvent,
  DevLost,
  DevManager,
  DevManagerOptions,
  DevProcess,
  PersistedProcess,
} from "./types";

/** Bounded process table. Sessions that end take their processes with them. */
const MAX_PROCESSES = 32;

let counter = 0;
function nextID(clock: Clock): string {
  counter += 1;
  return `dev_${clock.now().toString(36)}_${counter.toString(36)}`;
}

export function createManager(
  options: DevManagerOptions = {},
  system: System = defaultSystem,
  clock: Clock = systemClock,
): DevManager {
  const entries = new Map<string, Entry>();
  const listeners = new Set<(event: DevEvent) => void>();

  /**
   * The cleanup of what the previous run left behind.
   *
   * A start waits for it. The orphan of a crashed run is holding a port, and
   * handing that port to a new command before the orphan has let go of it
   * produces a failure that looks like the caller's fault.
   */
  let cleanup: Promise<unknown> = Promise.resolve();

  const emit = (event: DevEvent) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A listener that throws is a listener that stops hearing, not a reason
        // to fail the process it was watching.
      }
    }
  };

  /**
   * The table as it is written down.
   *
   * It carries the finished commands too, not only the live ones. The table
   * used to hold nothing but running processes, so the moment a command
   * stopped its record vanished — and a record that vanishes cannot be asked
   * about afterwards. A service that is restarted then came back with an
   * empty list and no way to say what the previous run had been holding.
   *
   * The file is the only thing that survives a service that is killed
   * outright, so it is also the only thing the next run can use to find the
   * processes this one left behind.
   */
  const persist = () => {
    if (!options.pidFile) return;
    const rows: PersistedProcess[] = [...entries.values()]
      .map((entry) => ({
        id: entry.info.id,
        session_id: entry.info.session_id,
        command: entry.info.command,
        cwd: entry.info.cwd,
        pid: entry.info.pid,
        started_at: entry.info.started_at,
        port: entry.info.port,
        state: entry.info.state ?? (entry.info.exit_code === null ? "running" : "stopped"),
        exit_code: entry.info.exit_code,
        stopped_at: entry.info.exit_code === null ? undefined : entry.info.stopped_at,
        lost: entry.info.lost,
      }))
      // The newest are the ones worth keeping: the table is bounded, and an
      // old command is a story nobody is still asking about.
      .sort((a, b) => b.started_at - a.started_at)
      .slice(0, MAX_PROCESSES);
    try {
      writeRecords(options.pidFile, rows);
    } catch {
      // A table that cannot be written is a table the next run will not have;
      // losing it must not stop a command the reader asked for.
    }
  };

  const makeEntry = (info: DevProcess, restored = false): Entry =>
    new Entry(info, system, clock, { persist, emit }, restored);

  /**
   * Wait for the orphans to let go of what they held.
   *
   * The kill is a request and the process being gone is the fact, so the fact
   * is the one that is waited for. A record with no port has nothing to wait
   * for on the port, and one that is not an orphan was never running.
   */
  const settleOrphans = async (records: PersistedProcess[]) => {
    for (const record of records) {
      if (record.state !== "orphaned") continue;
      const deadline = clock.now() + 3_000;
      while (record.pid !== undefined && system.alive(record.pid) && clock.now() < deadline) {
        await clock.sleep(50);
      }
      if (record.port === undefined) continue;
      const portDeadline = clock.now() + 3_000;
      while (clock.now() < portDeadline) {
        if (!(await system.ports.accepts(record.port, 200))) break;
        await clock.sleep(100);
      }
    }
  };

  const trim = () => {
    if (entries.size <= MAX_PROCESSES) return;
    // Oldest finished process first; a running one is never evicted, because
    // evicting it would lose the only handle that can stop it.
    const finished = [...entries.values()]
      .filter((entry) => entry.info.exit_code !== null)
      .sort((a, b) => a.info.started_at - b.info.started_at);
    for (const entry of finished) {
      if (entries.size <= MAX_PROCESSES) break;
      entries.delete(entry.info.id);
    }
  };

  /**
   * Keep a record the last run left behind.
   *
   * It goes into the table like any other, so the reader can still ask about
   * it. A command that vanished on its own is lost; one that was found
   * running and cleaned up is an orphan; one that was stopped before the
   * service died is simply stopped.
   */
  const keepRestored = (record: PersistedProcess): DevProcess => {
    if (entries.has(record.id)) return entries.get(record.id)!.info;
    const info: DevProcess = {
      id: record.id,
      session_id: record.session_id,
      command: record.command,
      cwd: record.cwd,
      pid: record.pid,
      started_at: record.started_at,
      exit_code: record.exit_code ?? 1,
      stopped: record.state === "stopped" || record.state === "orphaned",
      port: record.port,
      state: record.state,
      stopped_at: record.stopped_at,
      lost: record.lost,
    };
    entries.set(record.id, makeEntry(info, true));
    return info;
  };

  /**
   * Close a lost record with the two facts a reader cannot see from the word.
   *
   * `gone` is a pid that is dead. `reused` is a pid that is alive and is not
   * the command this record is about — the number was handed out again.
   * The port is asked separately: a dead process can leave its port held,
   * and a live stranger can be holding nothing this record cares about.
   */
  const classifyLost = async (record: PersistedProcess, kind: DevLost["process"]): Promise<DevLost> => {
    const lost: DevLost = { process: kind };
    if (record.port === undefined) return lost;
    const holders = await system.ports.holders(record.port);
    const held = holders.length > 0 || (await system.ports.accepts(record.port, 200));
    lost.port_held = held;
    if (holders.length > 0) lost.port_holders = holders;
    return lost;
  };

  /**
   * Whether the pid in a record still belongs to the command it was written for.
   *
   * A pid is a number the operating system hands out again once it is free, so
   * a record left behind by an earlier run may well name a process that has
   * nothing to do with it — and killing that one takes an innocent tree with
   * it. The clock is what tells them apart: the process the record is about was
   * created when the record says the command started, and a process created
   * later than that is somebody else wearing the same number.
   */
  const stillOurs = (record: PersistedProcess): boolean => {
    const pid = record.pid;
    if (pid === undefined) return false;
    const created = system.processStartedAt(pid);
    if (created === undefined) return false;
    // A moment of slack covers the spawn itself; anything beyond that is a
    // different process.
    return created <= record.started_at + 2_000;
  };

  return {
    async start(input) {
      const command = input.command.trim();
      if (command.length === 0) throw new Error("command is required");
      if (!isDirectory(input.cwd)) throw new Error(`not a directory: ${input.cwd}`);
      // The previous run's orphans are cleaned up first: one of them may still
      // be holding the port this command wants.
      await cleanup;

      const id = nextID(clock);
      const info: DevProcess = {
        id,
        session_id: input.session_id,
        command,
        cwd: input.cwd,
        pid: undefined,
        started_at: clock.now(),
        exit_code: null,
        stopped: false,
        state: "running",
        // Recorded so a caller reading the result knows what syntax the command
        // was written in — the model writes PowerShell, and `cmd /c` would have
        // silently failed on it.
        shell: system.commandShell(),
      };

      // One port, one tree.
      //
      // A second command on a port that is already being served cannot work,
      // and starting it anyway leaves two trees fighting over the port: the
      // second one fails with an address already in use that has nothing to
      // do with the second command, and the first one is the one that looks
      // broken. Refusing is the only answer that keeps one port, one server.
      if (input.port !== undefined) {
        const holder = [...entries.values()].find(
          (entry) => entry.info.exit_code === null && entry.info.port === input.port,
        );
        if (holder) {
          throw new Error(
            `port ${input.port} is already served by ${holder.info.id} (${holder.info.command}) — stop it first`,
          );
        }
        // A port this table knows nothing about may still be taken — by a
        // command another run left behind, or by something that was never
        // ours. The operating system is the authority on who holds a port,
        // and it can answer before a second tree is created rather than
        // after it has failed.
        const holders = await system.ports.holders(input.port);
        if (holders.length > 0) {
          throw new Error(
            `port ${input.port} is already in use by pid ${holders.join(", ")} — stop it first`,
          );
        }
      }

      const entry = makeEntry(info);
      entries.set(id, entry);
      trim();
      return entry.run({ port: input.port, waitMs: input.waitMs });
    },

    list(sessionID) {
      const all = [...entries.values()].map((entry) => entry.info);
      const filtered = sessionID === undefined ? all : all.filter((info) => info.session_id === sessionID);
      return filtered.sort((a, b) => b.started_at - a.started_at);
    },

    get(id) {
      return entries.get(id)?.info;
    },

    logs(id, tail = 200) {
      return this.readLogs(id, { tail }).lines;
    },

    readLogs(id, query = {}) {
      const entry = entries.get(id);
      if (!entry) return { lines: [], next_offset: query.offset ?? 0, dropped: false };
      return entry.readLogs(query);
    },

    async restart(id) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`no process ${id}`);
      await cleanup;
      if (entry.info.exit_code === null) {
        const stopped = await entry.stop();
        if (!stopped.stopped || !stopped.clean) {
          const bits: string[] = [];
          if (stopped.residual.length > 0) bits.push(`still running: ${stopped.residual.join(", ")}`);
          if (stopped.port !== undefined && stopped.port_free === false) {
            bits.push(`port ${stopped.port} is still held`);
          }
          throw new Error(`could not restart ${id}: ${bits.join("; ") || "the command did not stop"}`);
        }
      } else if (entry.info.port !== undefined) {
        const holders = await system.ports.holders(entry.info.port);
        if (holders.length > 0 || (await system.ports.accepts(entry.info.port, 200))) {
          const who = holders.length > 0 ? ` by pid ${holders.join(", ")}` : "";
          throw new Error(`port ${entry.info.port} is still held${who} — it has to be free before ${id} can start again`);
        }
      }
      const other = [...entries.values()].find(
        (row) => row !== entry && row.info.exit_code === null && entry.info.port !== undefined && row.info.port === entry.info.port,
      );
      if (other) {
        throw new Error(
          `port ${entry.info.port} is already served by ${other.info.id} (${other.info.command}) — stop it first`,
        );
      }
      const info = entry.info;
      info.pid = undefined;
      info.started_at = clock.now();
      info.exit_code = null;
      info.stopped = false;
      info.error = undefined;
      info.ready = undefined;
      info.ready_ms = undefined;
      info.state = "running";
      info.stopped_at = undefined;
      info.lost = undefined;
      info.shell = system.commandShell();
      entry.child = undefined;
      entry.restored = false;
      entry.push("err", "--- restart ---", true);
      return entry.run({ port: info.port });
    },

    async stop(id) {
      const entry = entries.get(id);
      if (!entry) return { stopped: false, clean: false, residual: [] };
      return entry.stop();
    },

    forget(id) {
      const entry = entries.get(id);
      if (!entry) return false;
      if (entry.info.exit_code === null) {
        throw new Error(`process ${id} is still running — stop it before removing the record`);
      }
      entries.delete(id);
      persist();
      emit({ type: "dev.removed", session_id: entry.info.session_id, process_id: id });
      return true;
    },

    async stopSession(sessionID) {
      const owned = [...entries.values()].filter(
        (entry) => entry.info.session_id === sessionID && entry.info.exit_code === null,
      );
      await Promise.all(owned.map((entry) => entry.stop()));
      return owned.length;
    },

    async stopAll() {
      const running = [...entries.values()].filter((entry) => entry.info.exit_code === null);
      await Promise.all(running.map((entry) => entry.stop()));
    },

    /**
     * What the last run left behind, and what is done about it.
     *
     * The file is read at startup because it is the only thing that outlives
     * a service that was killed outright. A command that was still running
     * when that happened is an orphan: nobody is going to stop it, and it
     * holds a port the next command will want.
     *
     * Killing it is not as simple as signalling the pid, because the pid may
     * have been handed to something else in the meantime. The record carries
     * when the command started, and a pid that started later than the record
     * is a different process entirely — that one is left alone.
     */
    async reapStale(): Promise<number> {
      if (!options.pidFile) return 0;
      const records = readRecords(options.pidFile, () => clock.now());
      let killed = 0;
      for (const record of records) {
        // A command that was already stopped is history, not work: it is kept
        // in the table so the next reader can still ask what happened.
        if (record.state !== "running") {
          keepRestored(record);
          continue;
        }
        const pid = record.pid;
        const running = pid !== undefined && system.alive(pid);
        // A pid that is alive is not enough: the number may have been handed
        // to something else since the record was written. Killing that would
        // take a tree nobody here started with it.
        const ours = running && stillOurs(record);
        if (ours) {
          // The root is a supervisor holding a job object: killing it closes
          // the job and the operating system takes the tree with it.
          system.killTree(pid!);
          record.state = "orphaned";
          record.exit_code = record.exit_code ?? 1;
          killed += 1;
        } else {
          // The command is gone, or the number it had belongs to something
          // else now. Say which, and whether the port it served is still
          // taken: "lost" on its own makes the reader guess both.
          record.state = "lost";
          record.exit_code = record.exit_code ?? 1;
          record.lost = await classifyLost(record, running ? "reused" : "gone");
        }
        const info = keepRestored(record);
        // A reader that cached this row has no other way to learn it is gone;
        // tell the bus the same way a natural exit would.
        emit({ type: "dev.exited", session_id: record.session_id, process: info });
      }
      // A kill is a request; the port going quiet is the fact. A command that
      // starts before the previous run's server has let go of its port is
      // handed a failure that looks like the caller's fault.
      cleanup = settleOrphans(records);
      await cleanup;
      persist();
      return killed;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
