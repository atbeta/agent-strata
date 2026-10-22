import { describe, expect, test } from "bun:test";
import { runningShell, type RunningShellView } from "../src/shell";

const view = (patch: Partial<RunningShellView> = {}): RunningShellView => ({
  status: "active",
  turns: [
    {
      tool_calls: [
        {
          tool: "bash",
          status: "pending",
          input: { command: "bun dev" },
          ts: "2026-10-22T10:00:00.000Z",
        },
      ],
    },
  ],
  ...patch,
});

describe("a session with a dev server still in its shell", () => {
  test("a pending dev command names the session", () => {
    expect(runningShell(view())).toEqual({
      command: "bun dev",
      detail: "bun dev",
      since: "2026-10-22T10:00:00.000Z",
    });
    expect(runningShell(view({
      turns: [{
        tool_calls: [{
          tool: "bash",
          status: "pending",
          input: { command: "cd web && npm run dev -- --port 5173" },
          ts: "2026-10-22T10:00:00.000Z",
        }],
      }],
    }))).toMatchObject({ command: "npm run dev -- --port 5173" });
    expect(runningShell(view({
      turns: [{
        tool_calls: [{
          tool: "bash",
          status: "pending",
          input: { command: "PORT=3000 vite --host" },
          ts: "2026-10-22T10:00:00.000Z",
        }],
      }],
    }))).toMatchObject({ command: "vite --host" });
  });

  test("a finished, ended, or reverted command says nothing", () => {
    expect(runningShell(view({
      turns: [{
        tool_calls: [{ tool: "bash", status: "ok", input: { command: "bun dev" }, ts: "2026-10-22T10:00:00.000Z" }],
      }],
    }))).toBeUndefined();
    expect(runningShell(view({ status: "completed" }))).toBeUndefined();
    expect(runningShell(view({ status: "error" }))).toBeUndefined();
    expect(runningShell(view({
      turns: [{
        reverted: true,
        tool_calls: [{ tool: "bash", status: "pending", input: { command: "bun dev" }, ts: "2026-10-22T10:00:00.000Z" }],
      }],
    }))).toBeUndefined();
    expect(runningShell(view({
      turns: [{
        tool_calls: [{ tool: "bash", status: "interrupted", input: { command: "bun dev" }, ts: "2026-10-22T10:00:00.000Z" }],
      }],
    }))).toBeUndefined();
  });

  test("an ordinary command that is merely in progress is not a server", () => {
    for (const command of [
      "git status",
      "bun test",
      "npm install",
      "npm run build",
      "npm run dev:check",
      "echo bun dev",
      "vite build",
      "next build",
      "docker compose up -d",
      "docker compose up --detach",
      "cat src/dev.ts",
      'git commit -m "start the dev server"',
      "sleep 100",
      "cargo run",
      "bun test && bun dev",
    ]) {
      expect(runningShell(view({
        turns: [{
          tool_calls: [{ tool: "bash", status: "pending", input: { command }, ts: "2026-10-22T10:00:00.000Z" }],
        }],
      })), command).toBeUndefined();
    }
  });

  test("a non-shell tool is not a shell, and the newest server wins", () => {
    expect(runningShell(view({
      turns: [{
        tool_calls: [{ tool: "read", status: "pending", input: { command: "bun dev" }, ts: "2026-10-22T10:00:00.000Z" }],
      }],
    }))).toBeUndefined();
    expect(runningShell(view({
      turns: [{
        tool_calls: [
          { tool: "bash", status: "pending", input: { command: "npm run dev" }, ts: "2026-10-22T10:00:00.000Z" },
          { tool: "bash", status: "pending", input: { command: "bun dev" }, ts: "2026-10-22T10:05:00.000Z" },
        ],
      }],
    }))).toMatchObject({ command: "bun dev", since: "2026-10-22T10:05:00.000Z" });
  });
});
