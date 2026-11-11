import type { DevStopResult } from "@agent-strata/api";
import { LogBuffer } from "./log-buffer";
import { announcedPort, readOutput } from "./output";
import type { Clock, DevChild, System } from "./system";
import type { DevEvent, DevLogPage, DevProcess } from "./types";

/** Default wait for a named port to accept a connection. */
const DEFAULT_WAIT_MS = 30_000;

/**
 * Grace period for a port read out of the output.
 *
 * Something that printed a URL is already listening, so this only covers the
 * gap between writing the line and accepting the socket. A long wait here would
 * be spent on ports that are never going to open.
 */
const ANNOUNCED_WAIT_MS = 2_000;

/**
 * How long a port announcement is waited for.
 *
 * This is the hard cap; the usual end of the wait comes sooner, when the
 * command stops talking. A dev server prints the port it serves on a moment
 * after it starts, and that moment is often longer than the liveness check
 * because the supervisor has to come up first — so giving up after a second
 * reports a server that is about to be ready as one that never will be.
 */
const ANNOUNCE_WINDOW_MS = 8_000;

/**
 * How long a command may be quiet before its silence is taken for an answer.
 *
 * A watcher prints a line and then says nothing for an hour. Waiting for a
 * port that is never going to be announced would make every start of one
 * look hung.
 */
const SILENCE_MS = 1_200;

/**
 * How long "no output at all" is tolerated before silence counts.
 *
 * On Windows the supervisor — a PowerShell process that compiles its job
 * helpers — has to come up before the command can print anything, and on a
 * slow machine that alone outlasts the silence window. Treating "nothing
 * said yet" as a watcher would return answers about a command that has not
 * actually started yet.
 */
const FIRST_OUTPUT_GRACE_MS = 5_000;

export interface EntryHooks {
  persist(): void;
  emit(event: DevEvent): void;
}

export class Entry {
  child: DevChild | undefined;
  readonly logs = new LogBuffer();
  generation = 0;
  restored: boolean;

  constructor(
    readonly info: DevProcess,
    private readonly system: System,
    private readonly clock: Clock,
    private readonly hooks: EntryHooks,
    restored = false,
  ) {
    this.restored = restored;
  }

  readLogs(query: { tail?: number; since?: number; offset?: number } = {}): DevLogPage {
    return this.logs.read(query);
  }

  push(stream: "out" | "err", text: string, marker = false): void {
    const line = this.logs.push(stream, text, this.clock.now(), marker);
    if (!marker) this.info.last_line = text;
    this.hooks.emit({ type: "dev.output", session_id: this.info.session_id, process_id: this.info.id, line });
  }

  /**
   * Spawn the command an entry already describes, and wait until it is honest
   * to answer. Start and restart share this: the difference is whether the
   * entry is new.
   */
  async run(wait: { port?: number; waitMs?: number }): Promise<DevProcess> {
    const info = this.info;
    this.generation += 1;
    const generation = this.generation;
    const beganAt = this.clock.now();
    let child: DevChild;
    try {
      child = this.system.spawn(info.command, info.cwd);
    } catch (e) {
      info.error = e instanceof Error ? e.message : String(e);
      this.settle(null);
      return info;
    }

    this.child = child;
    info.pid = child.pid;
    // Recorded before the first line of output: a crash between here and the
    // next write would otherwise leave a pid nobody knows about.
    this.hooks.persist();

    // Both pipes are read for as long as the process lives. A dev server that
    // writes a lot and has nobody draining it blocks on its own stdout.
    void this.read("out", child.stdout as ReadableStream<Uint8Array>, generation);
    void this.read("err", child.stderr as ReadableStream<Uint8Array>, generation);

    void child.exited.then((code) => this.settle(code, generation)).catch(() => this.settle(null, generation));

    // Wait for the port, not for a stopwatch. See start() for why the two
    // waits are one wait.
    if (info.exit_code === null) {
      info.ready = "unknown";
      const named = wait.port !== undefined;
      if (named) info.port = wait.port;
      const budget = wait.waitMs ?? (named ? DEFAULT_WAIT_MS : ANNOUNCE_WINDOW_MS);
      const deadline = this.clock.now() + budget;
      let acceptUntil = named ? deadline : undefined;
      let spoken = false;
      while (info.exit_code === null && this.clock.now() < deadline) {
        if (!spoken && this.logs.hasOutput) {
          spoken = true;
          const end = this.clock.now() + 250;
          while (info.exit_code === null && this.clock.now() < end) {
            await this.clock.sleep(25);
          }
        }
        if (info.port !== undefined) {
          if (acceptUntil === undefined) acceptUntil = this.clock.now() + ANNOUNCED_WAIT_MS;
          if (this.clock.now() > acceptUntil) break;
          if (await this.system.ports.accepts(info.port)) {
            info.ready = "yes";
            info.ready_ms = this.clock.now() - beganAt;
            break;
          }
        } else if (this.quiet(beganAt)) {
          break;
        }
        await this.clock.sleep(100);
      }
      if (info.port !== undefined && info.ready !== "yes") info.ready = "no";
    }

    if (info.exit_code !== null && info.exit_code !== 0 && !info.stopped) {
      const tail = this.logs.all.filter((line) => !line.marker).slice(-3).map((line) => line.text).join("\n");
      info.error = tail.length > 0 ? tail : `exited with ${info.exit_code}`;
    }

    this.hooks.emit({ type: "dev.started", session_id: info.session_id, process: info });
    return info;
  }

  /**
   * Stop a command and prove it stopped.
   *
   * The order matters. The supervisor is killed first — on Windows that
   * closes the job handle and the operating system takes the whole tree with
   * it — and the tree walk is only the belt to that braces. Then the port is
   * asked whether anything is still listening, because a port that is still
   * held is the part the reader will hit next.
   *
   * What comes back says what happened, not what was hoped for. A stop that
   * could not prove the port is free reports it, with the pids that are still
   * holding it.
   */
  async stop(): Promise<DevStopResult> {
    const child = this.child;
    const pid = this.info.pid;
    const port = this.info.port;
    if (this.info.exit_code !== null) {
      // The command is already finished, and its record says how it ended.
      // Stopping it again does not change that: a command that was cleaned
      // up as an orphan stays an orphan, because that is what happened to it
      // and a reader may be asking exactly that.
      const portHeld = port !== undefined && (await this.system.ports.accepts(port, 200));
      const residual = port !== undefined && portHeld ? await this.system.ports.holders(port) : [];
      if (pid !== undefined && this.system.alive(pid)) residual.push(pid);
      return {
        stopped: true,
        clean: residual.length === 0 && !portHeld,
        residual,
        port,
        port_free: port === undefined ? undefined : !portHeld,
      };
    }
    this.info.stopped = true;
    this.info.state = "stopped";
    if (!child && pid === undefined) {
      // A spawn that never produced a pid has nothing to signal.
      this.settle(null);
      return { stopped: true, clean: true, residual: [], port, port_free: port === undefined };
    }
    // The shell exits before the programs it started do, so killing the pid is
    // not killing the tree. A dev server is a shell that runs a script that
    // runs a runtime, and it is the runtime that holds the port.
    //
    // On Windows the pid is a supervisor holding a job object: killing it
    // closes the job and the operating system takes the tree with it, without
    // anyone walking links that a middle process may already have broken.
    try {
      child?.kill();
    } catch {
      // Already gone; the exit handler settles it.
    }
    if (pid !== undefined) {
      this.system.killTree(pid);
    }

    // Give the tree the moment it needs to go, then ask what is left.
    const { residual, portHeld } = await this.residualProcesses(pid, port);
    const clean = residual.length === 0 && !portHeld;
    // The command is still running if its root is: the record has to keep
    // saying what is true, because a reader who is told "stopped" stops
    // looking for the process that is still holding the port.
    const stillUp = pid !== undefined && this.system.alive(pid);
    if (stillUp) {
      this.info.stopped = false;
      this.info.state = "running";
    } else {
      // It is gone. If the port is still held, something else holds it —
      // the answer names who, because that is what will collide with the
      // next command.
      if (this.info.exit_code === null) this.settle(null);
      this.info.stopped = true;
      this.info.state = "stopped";
    }
    this.hooks.persist();
    return {
      // The answer says what happened: a root that is still standing was not
      // stopped, whatever the stop asked for.
      stopped: !stillUp,
      clean,
      residual,
      port,
      port_free: port === undefined ? undefined : !portHeld,
    };
  }

  private settle(code: number | null, generation = this.generation): void {
    if (generation !== this.generation) return;
    if (this.info.exit_code !== null) return;
    this.info.exit_code = code ?? 0;
    this.info.stopped_at = this.clock.now();
    // The process is gone, so the record is finished. It used to keep the
    // state it was given at the start, which meant a command that crashed on
    // its own still read as running — and the panel counted it as one.
    this.info.state = "stopped";
    this.child = undefined;
    this.hooks.persist();
    this.hooks.emit({ type: "dev.exited", session_id: this.info.session_id, process: this.info });
  }

  /**
   * Whether the command has stopped talking.
   *
   * Silence is what a command says when it is not going to announce
   * anything, and it is the only answer available: a watcher that has said
   * nothing for a moment is a watcher, not a server that is about to print
   * its port.
   */
  private quiet(began: number): boolean {
    // No output at all yet is "still coming up", not "silent": the supervisor
    // itself has to start before the command can print, and on a slow machine
    // that alone outlasts the silence window.
    if (!this.logs.hasOutput) return this.clock.now() - began > FIRST_OUTPUT_GRACE_MS;
    return this.clock.now() - (this.logs.lastOutputAt ?? began) > SILENCE_MS;
  }

  private async read(
    stream: "out" | "err",
    source: ReadableStream<Uint8Array>,
    generation = this.generation,
  ): Promise<void> {
    await readOutput(source, (text) => {
      // A line from the run that was just replaced is not this run's output.
      if (generation !== this.generation) return;
      this.push(stream, text);
      // A server that announces its port is telling the truth about where to
      // look; a caller who named one is not overruled.
      if (this.info.port === undefined) {
        const port = announcedPort(text);
        if (port !== undefined) this.info.port = port;
      }
    });
  }

  /**
   * What survived a stop.
   *
   * Two questions, asked in the order that costs the least. The process
   * itself is checked first, because a command that never opened a port has
   * nothing else to be wrong about. A port that is still answering is
   * checked next, and the pids holding it are the ones worth reporting: a
   * server that is still serving is the failure that will bite the next
   * start.
   *
   * The answer is a pair, not a list. A port that is still held is the fact
   * that matters even when the pids cannot be named — the reader needs to
   * know the port is taken, not only which process took it.
   */
  private async residualProcesses(
    pid: number | undefined,
    port: number | undefined,
  ): Promise<{ residual: number[]; portHeld: boolean }> {
    // The tree needs a moment to come apart. The probe is short-lived here:
    // a port that is still held answers or refuses at once, and a stop that
    // takes ten seconds is a stop the caller has stopped watching.
    for (let i = 0; i < 10; i++) {
      const rootGone = pid === undefined || !this.system.alive(pid);
      const portHeld = port !== undefined && (await this.system.ports.accepts(port, 200));
      if (rootGone && !portHeld) {
        // The root is gone, but the tree it held may still be coming apart:
        // the operating system tears a job down asynchronously, and a runtime
        // that is about to let go of its port would otherwise be reported as
        // still holding it. One more look before calling the stop clean.
        await this.clock.sleep(120);
        if (port === undefined || !(await this.system.ports.accepts(port, 200))) {
          return { residual: [], portHeld: false };
        }
      }
      if ((i === 3 || i === 6) && pid !== undefined && this.system.alive(pid)) {
        // The root is still there after the first attempts: reach it again,
        // this time by the tree walk.
        this.system.killTree(pid);
      }
      await this.clock.sleep(80);
    }
    const residual = new Set<number>();
    if (pid !== undefined && this.system.alive(pid)) residual.add(pid);
    let portHeld = false;
    if (port !== undefined) {
      portHeld = await this.system.ports.accepts(port, 200);
      for (const holder of await this.system.ports.holders(port)) residual.add(holder);
    }
    return { residual: [...residual], portHeld };
  }
}
