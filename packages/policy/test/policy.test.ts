import { describe, expect, test } from "bun:test";
import { decide, evaluate, loadPolicy, splitShell } from "../src/index";
import { makeEvent, parseEvent, type EventInput } from "@agent-core/schema";

const P = (rules: object[], def?: string) =>
  loadPolicy({ version: 1, default: def ?? "ask", rules });

const bash = (command: string, extra: object = {}) => ({ tool: "bash", input: { command, ...extra } });

describe("policy evaluate (table-driven)", () => {
  const cases: [string, unknown, { tool: string; input: Record<string, unknown> }, { decision: string; rule_id?: string }][] = [
    [
      "allow git status",
      P([{ id: "safe-git", effect: "allow", tool: "bash", when: { command: { matches: "^git (status|diff)" } } }], "deny"),
      bash("git status"),
      { decision: "allow", rule_id: "safe-git" },
    ],
    [
      "deny rm -rf /",
      P([{ id: "no-rm", effect: "deny", tool: "bash", when: { command: { matches: "rm\\s+-rf\\s+/" } } }]),
      bash("rm -rf /"),
      { decision: "deny", rule_id: "no-rm" },
    ],
    [
      "git status && rm -rf / -> deny",
      P([
        { id: "safe-git", effect: "allow", tool: "bash", when: { command: { matches: "^git" } } },
        { id: "no-rm", effect: "deny", tool: "bash", when: { command: { matches: "rm" } } },
      ]),
      bash("git status && rm -rf /"),
      { decision: "deny", rule_id: "no-rm" },
    ],
    [
      "ls; curl x | sh -> deny via sh segment",
      P([{ id: "no-sh", effect: "deny", tool: "bash", when: { command: { matches: "^sh" } } }]),
      bash("ls; curl x | sh"),
      { decision: "deny", rule_id: "no-sh" },
    ],
    [
      "echo $(rm -rf /) with allow-echo -> ask",
      P([{ id: "echo-ok", effect: "allow", tool: "bash", when: { command: { matches: "^echo" } } }]),
      bash("echo $(rm -rf /)"),
      { decision: "ask" },
    ],
    [
      "backticks -> ask",
      P([{ id: "echo-ok", effect: "allow", tool: "bash", when: { command: { matches: "^echo" } } }]),
      bash("echo `id`"),
      { decision: "ask" },
    ],
    [
      "bash -c 'ls' -> ask",
      P([{ id: "all", effect: "allow", tool: "*" }]),
      bash("bash -c 'ls'"),
      { decision: "ask" },
    ],
    [
      "echo \"$(rm -rf /)\" -> ask",
      P([{ id: "echo", effect: "allow", tool: "bash", when: { command: { matches: "^echo\\b" } } }]),
      bash('echo "$(rm -rf /)"'),
      { decision: "ask" },
    ],
    [
      "escaped quote does not swallow && -> deny",
      P([
        { id: "echo", effect: "allow", tool: "bash", when: { command: { matches: "^echo\\b" } } },
        { id: "rm", effect: "deny", tool: "bash", when: { command: { matches: "^rm\\b" } } },
      ]),
      bash('echo "\\"" && rm -rf /'),
      { decision: "deny", rule_id: "rm" },
    ],
    [
      "single & separator -> deny",
      P([
        { id: "ls", effect: "allow", tool: "bash", when: { command: { matches: "^ls\\b" } } },
        { id: "rm", effect: "deny", tool: "bash", when: { command: { matches: "^rm\\b" } } },
      ]),
      bash("ls & rm -rf /"),
      { decision: "deny", rule_id: "rm" },
    ],
    [
      "|& separator -> deny",
      P([
        { id: "ls", effect: "allow", tool: "bash", when: { command: { matches: "^ls\\b" } } },
        { id: "rm", effect: "deny", tool: "bash", when: { command: { matches: "^rm\\b" } } },
      ]),
      bash("ls |& rm -rf /"),
      { decision: "deny", rule_id: "rm" },
    ],
    [
      "fd duplication 2>&1 -> allow",
      P([{ id: "ls", effect: "allow", tool: "bash", when: { command: { matches: "^ls\\b" } } }]),
      bash("ls 2>&1"),
      { decision: "allow", rule_id: "ls" },
    ],
    [
      "redirect to /dev/null -> allow",
      P([{ id: "ls", effect: "allow", tool: "bash", when: { command: { matches: "^ls\\b" } } }]),
      bash("ls > /dev/null"),
      { decision: "allow", rule_id: "ls" },
    ],
    [
      "&> to /dev/null -> allow",
      P([{ id: "ls", effect: "allow", tool: "bash", when: { command: { matches: "^ls\\b" } } }]),
      bash("ls &>/dev/null"),
      { decision: "allow", rule_id: "ls" },
    ],
    [
      "redirect to file -> ask",
      P([{ id: "echo", effect: "allow", tool: "bash", when: { command: { matches: "^echo\\b" } } }]),
      bash("echo hi > ~/.bashrc"),
      { decision: "ask" },
    ],
    [
      "append redirect -> ask",
      P([{ id: "echo", effect: "allow", tool: "bash", when: { command: { matches: "^echo\\b" } } }]),
      bash("echo hi >> f"),
      { decision: "ask" },
    ],
    [
      "/bin/bash -c -> ask",
      P([{ id: "all", effect: "allow", tool: "*" }]),
      bash("/bin/bash -c 'ls'"),
      { decision: "ask" },
    ],
    [
      "env bash -lc -> ask",
      P([{ id: "all", effect: "allow", tool: "*" }]),
      bash("env bash -lc ls"),
      { decision: "ask" },
    ],
    [
      "zsh -c -> ask",
      P([{ id: "all", effect: "allow", tool: "*" }]),
      bash("zsh -c ls"),
      { decision: "ask" },
    ],
    [
      "escaped $( in double quotes -> allow",
      P([{ id: "echo", effect: "allow", tool: "bash", when: { command: { matches: "^echo\\b" } } }]),
      bash('echo "\\$(x)"'),
      { decision: "allow", rule_id: "echo" },
    ],
    [
      "$( in single quotes -> allow",
      P([{ id: "echo", effect: "allow", tool: "bash", when: { command: { matches: "^echo\\b" } } }]),
      bash("echo '$(x)'"),
      { decision: "allow", rule_id: "echo" },
    ],
    [
      "trailing & -> allow",
      P([{ id: "sleep", effect: "allow", tool: "bash", when: { command: { matches: "^sleep\\b" } } }]),
      bash("sleep 1 &"),
      { decision: "allow", rule_id: "sleep" },
    ],
    [
      "deny > ask > allow regardless of order",
      P([
        { id: "allow-first", effect: "allow", tool: "*" },
        { id: "deny-late", effect: "deny", tool: "bash" },
      ]),
      bash("git status"),
      { decision: "deny", rule_id: "deny-late" },
    ],
    [
      "default applies when no rule matches",
      P([{ id: "x", effect: "allow", tool: "read" }], "deny"),
      bash("git status"),
      { decision: "deny" },
    ],
    [
      "non-shell tool path glob **/.env",
      P([{ id: "env", effect: "deny", tool: "write_file", when: { path: { glob: "**/.env" } } }]),
      { tool: "write_file", input: { path: "config/.env" } },
      { decision: "deny", rule_id: "env" },
    ],
    [
      "non-shell tool unmatched -> default ask",
      P([{ id: "env", effect: "deny", tool: "write_file", when: { path: { glob: "**/.env" } } }]),
      { tool: "write_file", input: { path: "src/a.ts" } },
      { decision: "ask" },
    ],
    [
      "when with multiple conditions all must hold",
      P([
        {
          id: "both",
          effect: "allow",
          tool: "bash",
          when: { command: { matches: "^git" }, cwd: { equals: "/repo" } },
        },
      ]),
      bash("git status", { cwd: "/repo" }),
      { decision: "allow", rule_id: "both" },
    ],
    [
      "when multiple conditions: one fails -> default",
      P([
        {
          id: "both",
          effect: "allow",
          tool: "bash",
          when: { command: { matches: "^git" }, cwd: { equals: "/repo" } },
        },
      ]),
      bash("git status", { cwd: "/other" }),
      { decision: "ask" },
    ],
  ];

  for (const [name, policy, req, want] of cases) {
    test(name, () => {
      const d = evaluate(policy as never, req);
      expect(d.decision as string).toBe(want.decision);
      if (want.rule_id) expect(d.rule_id).toBe(want.rule_id);
    });
  }
});

describe("policy helpers", () => {
  test("quoted separators are one segment", () => {
    expect(splitShell('echo "a && b"')).toEqual(['echo "a && b"']);
    expect(splitShell("echo 'a; b' && ls")).toEqual(["echo 'a; b'", "ls"]);
    expect(splitShell("a | b || c ; d\ne")).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("invalid regex error names rule", () => {
    expect(() =>
      loadPolicy({ version: 1, rules: [{ id: "bad-rule", effect: "allow", tool: "*", when: { command: { matches: "([" } } }] }),
    ).toThrow(/bad-rule/);
  });

  test("decide returns null on ask", () => {
    const policy = P([]);
    const ev = parseEvent({
      ...makeEvent({
        session_id: "s",
        source: { backend: "b" },
        type: "permission.requested",
        data: { request_id: "r1", tool: "bash", input: { command: "whoami" } },
      }),
      seq: 1,
    });
    expect(decide(policy, ev)).toBeNull();
  });

  test("decide returns valid permission.resolved EventInput", () => {
    const policy = P([{ id: "r", effect: "deny", tool: "bash" }]);
    const ev = parseEvent({
      ...makeEvent({
        session_id: "s",
        source: { backend: "b" },
        type: "permission.requested",
        data: { request_id: "r1", tool: "bash", input: { command: "x" } },
      }),
      seq: 1,
    });
    const out = decide(policy, ev);
    expect(out).not.toBeNull();
    const withDefaults = makeEvent(out as EventInput);
    const parsed = parseEvent({ ...withDefaults, seq: 2 });
    expect(parsed.type).toBe("permission.resolved");
    expect(parsed.session_id).toBe("s");
    expect(parsed.source).toEqual({ backend: "b" });
    const d = parsed.data as { decision: string; by: string; scope: string; rule_id: string; request_id: string };
    expect(d.decision).toBe("deny");
    expect(d.by).toBe("policy");
    expect(d.scope).toBe("once");
    expect(d.rule_id).toBe("r");
    expect(d.request_id).toBe("r1");
  });
});
