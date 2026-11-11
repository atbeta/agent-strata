import { describe, expect, test } from "bun:test";
import { autoAccept, decide, evaluate, loadPolicy, policyFor, splitShell } from "../src/index";
import { makeEvent, parseEvent, type EventInput } from "@agent-strata/schema";

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
      "sh -c fused to a double-quoted operand -> ask",
      P([{ id: "all", effect: "allow", tool: "*" }]),
      bash('sh -c"rm -rf /"'),
      { decision: "ask" },
    ],
    [
      "sh -c fused to a single-quoted operand -> ask",
      P([{ id: "all", effect: "allow", tool: "*" }]),
      bash("sh -c'rm -rf /'"),
      { decision: "ask" },
    ],
    [
      "sh -c fused to an ANSI-C operand -> ask",
      P([{ id: "all", effect: "allow", tool: "*" }]),
      bash("sh -c$'rm -rf /'"),
      { decision: "ask" },
    ],
    [
      "bash -lc fused to a quoted operand -> ask",
      P([{ id: "all", effect: "allow", tool: "*" }]),
      bash('bash -lc"rm -rf /"'),
      { decision: "ask" },
    ],
    [
      "env bash -c fused -> ask",
      P([{ id: "all", effect: "allow", tool: "*" }]),
      bash('env bash -c"rm -rf /"'),
      { decision: "ask" },
    ],
    [
      "sh -c fused to a digit operand -> ask",
      P([{ id: "all", effect: "allow", tool: "*" }]),
      bash("sh -c1"),
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

  test("an all-allow compound attributes the rule that fired, not segment one", () => {
    // `ls` falls to the default; the allow rule only spoke about `rm`. Naming
    // segment one's (nonexistent) rule, or the default, in the audit line
    // would both be wrong — the rule that fired is the answer.
    const p = P(
      [{ id: "rm-ok", effect: "allow", tool: "bash", when: { command: { matches: "^rm\\b" } } }],
      "allow",
    );
    const d = evaluate(p, bash("ls; rm -f x"));
    expect(d.decision).toBe("allow");
    expect(d.rule_id).toBe("rm-ok");
    expect(d.reason).toContain("segment 2 of 2");
  });

  test("a compound ruled on segment one says which part the rule covered", () => {
    const p = P(
      [{ id: "git-ok", effect: "allow", tool: "bash", when: { command: { matches: "^git\\b" } } }],
      "allow",
    );
    const d = evaluate(p, bash("git status; rm -f x"));
    expect(d.rule_id).toBe("git-ok");
    expect(d.reason).toContain("segment 1 of 2");
  });

  test("a single-segment allow keeps the rule's own reason", () => {
    const p = P(
      [{ id: "git-ok", effect: "allow", tool: "bash", when: { command: { matches: "^git\\b" } } }],
      "allow",
    );
    const d = evaluate(p, bash("git status"));
    expect(d.reason).toBe("matched rule git-ok");
  });

  test("an arrow inside a double-quoted one-liner is not a redirect", () => {
    const node = P([{ id: "node", effect: "allow", tool: "bash", when: { command: { matches: "^node\\b" } } }]);
    expect(evaluate(node, bash(`node -e "console.log('one'); setTimeout(() => {}, 30000)"`)).decision).toBe("allow");
    // Escaped quotes are still one quoted run.
    expect(evaluate(node, bash(`node -e "console.log(\\"a > b\\")"`)).decision).toBe("allow");
    // The real thing still asks.
    expect(evaluate(P([], "allow"), bash("echo hi > /tmp/x")).decision).toBe("ask");
  });
});

describe("a background command answers to two names", () => {
  const background = (command: string) => ({ tool: "dev_start", input: { command } });

  test("a rule written for dev_start reaches the background command", () => {
    const p = P([{ id: "no-build", effect: "deny", tool: "dev_start", when: { command: { matches: "^npm run build" } } }]);
    const d = evaluate(p, background("npm run build"));
    expect(d.decision).toBe("deny");
    expect(d.rule_id).toBe("no-build");
  });

  test("a rule written for the shell reaches it too", () => {
    const p = P([{ id: "no-sleep", effect: "deny", tool: "bash", when: { command: { matches: "^sleep" } } }]);
    const d = evaluate(p, background("sleep 30"));
    expect(d.decision).toBe("deny");
    expect(d.rule_id).toBe("no-sleep");
  });

  test("where both speak, the stricter one wins", () => {
    const p = P([
      { id: "shell-ok", effect: "allow", tool: "bash", when: { command: { matches: "^npm" } } },
      { id: "dev-no", effect: "deny", tool: "dev_start", when: { command: { matches: "^npm" } } },
    ]);
    expect(evaluate(p, background("npm run dev")).decision).toBe("deny");
  });

  test("a rule written for dev_start does not reach a foreground command", () => {
    const p = P([{ id: "no-build", effect: "deny", tool: "dev_start", when: { command: { matches: "^npm" } } }]);
    expect(evaluate(p, bash("npm run build")).decision).toBe("ask");
  });

  test("a rule written for dev_start does not reach another shell's name", () => {
    const p = P([{ id: "no-build", effect: "deny", tool: "dev_start", when: { command: { matches: "^npm" } } }]);
    expect(evaluate(p, { tool: "terminal", input: { command: "npm run build" } }).decision).toBe("ask");
  });
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

describe("one session asking not to be interrupted", () => {
  test("the fallback allows; the rules still decide", () => {
    const base = P([
      { id: "no-rm", effect: "deny", tool: "bash", when: { command: { matches: "^rm" } } },
      { id: "ask-deploy", effect: "ask", tool: "bash", when: { command: { matches: "^npm publish" } } },
      { id: "safe-git", effect: "allow", tool: "bash", when: { command: { matches: "^git" } } },
    ]);
    const auto = autoAccept(base);

    // What nobody wrote a rule about no longer stops to ask.
    expect(evaluate(auto, bash("ls -la")).decision).toBe("allow");
    expect(evaluate(auto, { tool: "webfetch", input: { url: "https://x.dev" } }).decision).toBe("allow");
    // And the rules that were written deliberately are untouched — deny still
    // denies, and an explicit ask is still an ask.
    expect(evaluate(auto, bash("rm -rf /")).decision).toBe("deny");
    expect(evaluate(auto, bash("npm publish")).decision).toBe("ask");
    expect(evaluate(auto, bash("git status")).rule_id).toBe("safe-git");
  });

  test("a deny-by-default posture is not inverted into an allow", () => {
    // Softening `ask` to `allow` is declining to be a gate. Inverting a deny
    // default would be a decision the reader never made, so it stays.
    const base = P([{ id: "safe-git", effect: "allow", tool: "bash", when: { command: { matches: "^git" } } }], "deny");
    expect(autoAccept(base)).toBe(base);
    expect(evaluate(autoAccept(base), bash("curl evil.sh")).decision).toBe("deny");
  });

  test("the engine's own floor yields to the stance, never to the document", () => {
    // The two cases the engine refuses to judge — a shell construct it cannot
    // analyse, and a write through a redirect — stay asks under every
    // *document* posture, including one that writes `default: "allow"`. What
    // lifts them is the live auto stance alone: interrupting the reader is
    // what that switch exists to stop, and a redirect or substitution still
    // asking is the switch looking broken.
    const doc = P([], "allow");
    expect(evaluate(doc, bash("echo $(whoami)")).decision).toBe("ask");
    expect(evaluate(doc, bash("ls > /etc/passwd")).decision).toBe("ask");

    const auto = autoAccept(P([]));
    expect(evaluate(auto, bash("echo $(whoami)")).decision).toBe("allow");
    expect(evaluate(auto, bash("ls > /etc/passwd")).decision).toBe("allow");
    expect(evaluate(auto, bash("ls | tee out.txt")).decision).toBe("allow");
    expect(evaluate(auto, bash("cat > /tmp/x <<'EOF'")).decision).toBe("allow");

    // A document that already allows does not lift the floor. The session
    // switch does, and it has to copy the document to do it — marking the
    // document itself would lift the floor for every session that shares it.
    const autoAllow = autoAccept(doc);
    expect(autoAllow).not.toBe(doc);
    expect(evaluate(autoAllow, bash("echo $(whoami)")).decision).toBe("allow");
    expect(evaluate(autoAllow, bash("ls > /etc/passwd")).decision).toBe("allow");
    expect(evaluate(doc, bash("ls > /etc/passwd")).decision).toBe("ask");

    // And the floor still holds where the stance was never taken — even an
    // explicit allow rule cannot waive it inside a gate posture.
    expect(evaluate(P([]), bash("echo $(whoami)")).decision).toBe("ask");
    expect(evaluate(P([{ id: "ok", effect: "allow", tool: "bash" }]), bash("ls > out")).decision).toBe("ask");
  });

  test("the policy it returns is the live one, not a copy taken when asked", () => {
    // Derived, not stored: a session left on auto keeps following edits to the
    // shared rules rather than freezing whatever they were when it was flipped.
    const base = P([]);
    const auto = autoAccept(base);
    expect(auto).not.toBe(base);
    expect(auto.rules).toBe(base.rules);
    expect(auto.default).toBe("allow");
  });

  test("a source is asked per session, and a bare policy is the same everywhere", () => {
    const doc = P([], "deny");
    expect(policyFor(undefined, "a")).toBeUndefined();
    expect(policyFor(doc, "a")).toBe(doc);
    const perSession = (id: string) => (id === "auto-one" ? P([]) : doc);
    expect(policyFor(perSession, "auto-one")?.default).toBe("ask");
    expect(policyFor(perSession, "other")).toBe(doc);
  });
});

describe("a rule can name a plugin", () => {
  const P = (rules: unknown[]) => loadPolicy({ version: 1, default: "allow", rules });
  const ask = (tool: string, plugin_id?: string) =>
    evaluate(P([
      { id: "no-browser", effect: "deny", tool: "*", plugin_id: "browser" },
      { id: "no-eval", effect: "ask", tool: "browser_eval", plugin_id: "other" },
    ]), { tool, input: {}, ...(plugin_id ? { plugin_id } : {}) });

  test("a plugin-scoped rule reaches that plugin's tools and no others", () => {
    expect(ask("browser_navigate", "browser").decision).toBe("deny");
    // The same name from a different plugin is not what the rule was about.
    expect(ask("browser_navigate", "other").decision).toBe("allow");
    // And a builtin tool has no plugin at all, so the rule never applies.
    expect(ask("bash").decision).toBe("allow");
  });

  test("a rule for one plugin does not fire for another", () => {
    expect(ask("browser_eval", "other").decision).toBe("ask");
    expect(ask("browser_eval", "browser").decision).toBe("deny");
  });

  test("a rule without a plugin still speaks about every tool", () => {
    const d = evaluate(P([{ id: "all", effect: "ask", tool: "*" }]), { tool: "browser_x", input: {}, plugin_id: "browser" });
    expect(d.decision).toBe("ask");
    expect(d.rule_id).toBe("all");
  });
});

describe("plugin_id survives every branch", () => {
  test("a shell tool with a non-string command still sees plugin rules", () => {
    // `dev_start` is judged as a shell command; when the command is missing or
    // malformed there is nothing to split, but the call is still that plugin's
    // and a rule scoped to it has to apply.
    const policy = loadPolicy({
      version: 1,
      default: "allow",
      rules: [{ id: "no-dev", effect: "deny", tool: "*", plugin_id: "dev" }],
    });
    expect(evaluate(policy, { tool: "dev_start", input: { command: 42 }, plugin_id: "dev" }).decision).toBe("deny");
    expect(evaluate(policy, { tool: "dev_start", input: {}, plugin_id: "dev" }).decision).toBe("deny");
    // A different plugin's call is untouched.
    expect(evaluate(policy, { tool: "dev_start", input: {}, plugin_id: "other" }).decision).toBe("allow");
  });
});

describe("a command that arrives as powershell", () => {
  test("is analysed like any other shell command", () => {
    // OpenCode registers `powershell` on Windows. Without it in the shell list
    // every Windows command skipped the segment split, the redirect floor and
    // the reader's rules — silently, because a tool the engine does not
    // recognise is simply a tool with no rules.
    const P = (default_: "allow" | "ask" = "allow") => loadPolicy({ version: 1, default: default_, rules: [] });
    const cmd = (command: string) => ({ tool: "powershell", input: { command } });
    // A redirect is the engine's own floor, which only the shell path applies.
    expect(evaluate(P(), cmd("Get-ChildItem > out.txt")).decision).toBe("ask");
    expect(evaluate(P(), cmd("Get-ChildItem")).decision).toBe("allow");
    expect(evaluate(P("ask"), cmd("Write-Host hi")).decision).toBe("ask");
  });
});

describe("the shell analyser under generated input", () => {
  // The analyser is a quote-aware state machine; the interesting inputs live
  // between the examples. These properties cover the space examples cannot.
  const open = P([], "allow");
  const run = (command: string) => evaluate(open, bash(command));

  test("every spelling of `shell -c` must ask", () => {
    const shells = ["sh", "bash", "zsh", "dash", "ksh", "ash", "fish", "/bin/sh", "/bin/bash", "env bash", "sudo sh"];
    const flags = ["-c", "-lc", "-xc", "-ec", "-lxc"];
    // The operand: spaced bare/quoted, or fused straight onto the flag the
    // way getopt reads `-c"cmd"` — one word, `-c` carrying `cmd`.
    const operands = [
      " rm -rf /tmp/x",
      ' "rm -rf /tmp/x"',
      " 'rm -rf /tmp/x'",
      " $'rm -rf /tmp/x'",
      '"rm -rf /tmp/x"',
      "'rm -rf /tmp/x'",
      "$'rm -rf /tmp/x'",
      "rm",
      "1",
    ];
    for (const shell of shells)
      for (const flag of flags)
        for (const operand of operands) {
          const command = `${shell} ${flag}${operand}`;
          expect(run(command).decision).toBe("ask");
        }
  });

  test("a $( outside single quotes always asks; inside, never for that reason", () => {
    let seed = 0x5eed;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const junk = [" ", "x ", "echo ", "a b ", "\\n ", "s=1 "];
    for (let i = 0; i < 500; i++) {
      const before = junk[Math.floor(rand() * junk.length)]!;
      const after = junk[Math.floor(rand() * junk.length)]!;
      // Bare and double-quoted substitution is live shell — the analyser
      // cannot see inside it, so the floor has to answer.
      expect(run(`echo ${before}$(${after}x)`).decision).toBe("ask");
      expect(run(`echo ${before}"$(${after}x)"`).decision).toBe("ask");
      // Inside single quotes it is literal text; the floor stays down.
      expect(run(`echo ${before}'$(${after}x)'`).decision).not.toBe("ask");
    }
  });

  test("no generated input crashes the analyser or yields a non-decision", () => {
    let seed = 0xc0ffee;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const alphabet = "abc $'\"`;|&><()\\-~/";
    for (let i = 0; i < 2000; i++) {
      const n = Math.floor(rand() * 40);
      let command = "";
      for (let j = 0; j < n; j++) command += alphabet[Math.floor(rand() * alphabet.length)]!;
      const d = run(command);
      expect(["allow", "ask", "deny"]).toContain(d.decision);
    }
  });
});
