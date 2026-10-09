import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import { createStore, produce } from "solid-js/store";
import {
  clearPolicy,
  getJson,
  savePolicy,
  testPolicy,
  type Policy,
  type PolicyDecision,
  type PolicyResponse,
  type PolicyRule,
} from "./api";

// editing model: `when` is a Record in CASF but easier to edit as flat rows
interface CondRow {
  path: string;
  op: "equals" | "matches" | "glob";
  value: string;
}
interface RuleDraft {
  id: string;
  effect: PolicyRule["effect"];
  tool: string;
  reason: string;
  conds: CondRow[];
}
interface Draft {
  default: Policy["default"];
  rules: RuleDraft[];
}

const parseScalar = (v: string): string | number | boolean => {
  try {
    return JSON.parse(v) as string | number | boolean;
  } catch {
    return v;
  }
};

function fromPolicy(p: Policy): Draft {
  return {
    default: p.default,
    rules: p.rules.map((r) => ({
      id: r.id,
      effect: r.effect,
      tool: r.tool,
      reason: r.reason ?? "",
      conds: Object.entries(r.when ?? {}).flatMap(([path, c]) =>
        (Object.entries(c) as [CondRow["op"], unknown][]).map(([op, v]) => ({
          path,
          op,
          value: typeof v === "string" ? v : JSON.stringify(v),
        })),
      ),
    })),
  };
}

function toPolicy(d: Draft): Policy {
  return {
    version: 1,
    default: d.default,
    rules: d.rules
      .filter((r) => r.id.trim() && r.tool.trim())
      .map((r) => {
        const when = Object.fromEntries(
          r.conds
            .filter((c) => c.path.trim())
            .map((c) => [
              c.path.trim(),
              { [c.op]: c.op === "equals" ? parseScalar(c.value) : c.value },
            ]),
        );
        return {
          id: r.id.trim(),
          effect: r.effect,
          tool: r.tool.trim(),
          reason: r.reason.trim() || undefined,
          when: Object.keys(when).length ? when : undefined,
        };
      }),
  };
}

const EFFECT_LABEL: Record<PolicyRule["effect"], string> = {
  allow: "allow",
  deny: "deny",
  ask: "ask",
};

const DECISION_CLS: Record<PolicyDecision["decision"], string> = {
  allow: "text-status-active",
  deny: "text-destructive",
  ask: "text-event-permission",
};

const inputCls =
  "rounded-md border border-input bg-secondary/50 px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none";

function RuleCard(props: { index: number; draft: Draft; setDraft: (fn: (d: Draft) => void) => void; remove: () => void }) {
  const rule = () => props.draft.rules[props.index]!;
  const setRule = (fn: (r: RuleDraft) => void) =>
    props.setDraft((d) => {
      fn(d.rules[props.index]!);
    });

  return (
    <div class="rounded-lg border border-border bg-card p-4">
      <div class="flex flex-wrap items-center gap-2">
        <input
          class={`${inputCls} w-40`}
          placeholder="rule id"
          value={rule().id}
          onInput={(e) => setRule((r) => (r.id = e.currentTarget.value))}
        />
        <select
          class={`${inputCls} ${
            rule().effect === "deny"
              ? "text-destructive"
              : rule().effect === "allow"
                ? "text-status-active"
                : "text-event-permission"
          }`}
          value={rule().effect}
          onChange={(e) => setRule((r) => (r.effect = e.currentTarget.value as RuleDraft["effect"]))}
        >
          <For each={Object.keys(EFFECT_LABEL) as RuleDraft["effect"][]}>
            {(fx) => <option value={fx}>{fx}</option>}
          </For>
        </select>
        <span class="text-xs text-muted-foreground">tool</span>
        <input
          class={`${inputCls} w-36`}
          placeholder="bash | * | edit*"
          value={rule().tool}
          onInput={(e) => setRule((r) => (r.tool = e.currentTarget.value))}
        />
        <button
          class="ml-auto rounded-md bg-destructive/20 px-2.5 py-1 text-xs font-medium text-destructive transition-opacity hover:opacity-80"
          onClick={props.remove}
        >
          remove
        </button>
      </div>
      <input
        class={`${inputCls} mt-2 w-full font-sans`}
        placeholder="reason shown to the agent when this rule fires (optional)"
        value={rule().reason}
        onInput={(e) => setRule((r) => (r.reason = e.currentTarget.value))}
      />

      <div class="mt-3 space-y-1.5">
        <div class="flex items-center gap-2 text-xs text-muted-foreground">
          <span>when — every condition must match (input path · condition · value)</span>
          <button
            class="rounded bg-secondary px-1.5 py-0.5 text-2xs transition-colors hover:text-foreground"
            onClick={() => setRule((r) => r.conds.push({ path: "", op: "glob", value: "" }))}
          >
            + condition
          </button>
        </div>
        <For each={rule().conds}>
          {(c, ci) => (
            <div class="flex items-center gap-1.5">
              <input
                class={`${inputCls} w-48`}
                placeholder="command | input.path"
                value={c.path}
                onInput={(e) =>
                  setRule((r) => (r.conds[ci()]!.path = e.currentTarget.value))
                }
              />
              <select
                class={inputCls}
                value={c.op}
                onChange={(e) =>
                  setRule((r) => (r.conds[ci()]!.op = e.currentTarget.value as CondRow["op"]))
                }
              >
                <option value="glob">glob</option>
                <option value="matches">regex</option>
                <option value="equals">equals</option>
              </select>
              <input
                class={`${inputCls} flex-1`}
                placeholder={c.op === "equals" ? "true | 5 | string" : c.op === "matches" ? "\\brm\\b" : "*.env"}
                value={c.value}
                onInput={(e) =>
                  setRule((r) => (r.conds[ci()]!.value = e.currentTarget.value))
                }
              />
              <button
                class="rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:text-destructive"
                onClick={() => setRule((r) => r.conds.splice(ci(), 1))}
              >
                ✕
              </button>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

export function PolicyEditor() {
  const [saved] = createResource(() => getJson<PolicyResponse>("/policy"));
  const [draft, setDraftRaw] = createStore<Draft>({ default: "ask", rules: [] });
  const setDraft = (fn: (d: Draft) => void) => setDraftRaw(produce(fn));
  const [err, setErr] = createSignal("");
  const [notice, setNotice] = createSignal("");
  const [testTool, setTestTool] = createSignal("bash");
  const [testInput, setTestInput] = createSignal('{"command": "ls -la"}');
  const [testResult, setTestResult] = createSignal<PolicyDecision | null>(null);
  const [testErr, setTestErr] = createSignal("");

  createEffect(() => {
    const p = saved()?.policy;
    if (p) setDraftRaw(fromPolicy(p));
  });

  const save = async () => {
    setErr("");
    setNotice("");
    try {
      await savePolicy(toPolicy(draft));
      setNotice("saved — live connections pick it up immediately");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const clear = async () => {
    setErr("");
    setNotice("");
    await clearPolicy().catch((e) => setErr(e instanceof Error ? e.message : String(e)));
    setDraftRaw({ default: "ask", rules: [] });
    setNotice("cleared — everything falls back to ask");
  };

  const runTest = async () => {
    setTestErr("");
    setTestResult(null);
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(testInput()) as Record<string, unknown>;
    } catch {
      setTestErr("input is not valid JSON");
      return;
    }
    try {
      setTestResult(
        await testPolicy({ tool: testTool(), input, policy: toPolicy(draft) }),
      );
    } catch (e) {
      setTestErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <main class="mx-auto max-w-3xl p-6">
      <header>
        <h1 class="text-xl font-semibold">policy editor</h1>
        <p class="mt-1 text-xs text-muted-foreground">
          advisory permission rules — deny &gt; ask &gt; allow among matching rules,
          no match falls back to the default. not a sandbox.
          <Show when={saved()?.file}>
            <span class="font-mono"> · {saved()!.file}</span>
          </Show>
        </p>
      </header>

      <section class="mt-4 flex items-center gap-3 rounded-lg border border-border bg-muted px-4 py-3 text-sm">
        <span class="text-muted-foreground">default effect</span>
        <select
          class={inputCls}
          value={draft.default}
          onChange={(e) =>
            setDraftRaw("default", e.currentTarget.value as Draft["default"])
          }
        >
          <option value="ask">ask</option>
          <option value="allow">allow</option>
          <option value="deny">deny</option>
        </select>
        <span class="text-xs text-muted-foreground">
          {draft.rules.length} rules
        </span>
        <span class="ml-auto flex gap-2">
          <button
            class="rounded-md border border-border bg-secondary px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => void clear()}
          >
            clear
          </button>
          <button
            class="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            onClick={() => void save()}
          >
            save policy
          </button>
        </span>
      </section>
      <Show when={err()}>
        <p class="mt-2 font-mono text-xs text-destructive">{err()}</p>
      </Show>
      <Show when={notice()}>
        <p class="mt-2 text-xs text-status-active">{notice()}</p>
      </Show>

      <section class="mt-4 space-y-3">
        <For each={draft.rules}>
          {(_r, i) => (
            <RuleCard
              index={i()}
              draft={draft}
              setDraft={setDraft}
              remove={() => setDraft((d) => d.rules.splice(i(), 1))}
            />
          )}
        </For>
        <button
          class="w-full rounded-lg border border-dashed border-border py-2.5 text-sm text-muted-foreground transition-colors hover:border-ring/50 hover:text-foreground"
          onClick={() =>
            setDraft((d) =>
              d.rules.push({ id: "", effect: "allow", tool: "", reason: "", conds: [] }),
            )
          }
        >
          + add rule
        </button>
      </section>

      <section class="mt-6 rounded-lg border border-border bg-card p-4">
        <h2 class="text-sm font-medium">test the draft</h2>
        <p class="mt-1 text-xs text-muted-foreground">
          runs the unsaved draft against a fake tool call — bash commands are
          split and analyzed like real permission checks
        </p>
        <div class="mt-3 flex gap-2">
          <input
            class={`${inputCls} w-32`}
            placeholder="tool"
            value={testTool()}
            onInput={(e) => setTestTool(e.currentTarget.value)}
          />
          <input
            class={`${inputCls} flex-1`}
            value={testInput()}
            onInput={(e) => setTestInput(e.currentTarget.value)}
          />
          <button
            class="rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
            onClick={() => void runTest()}
          >
            run
          </button>
        </div>
        <Show when={testResult()}>
          {(d) => (
            <div class="mt-3 rounded-md bg-secondary/50 px-3 py-2 font-mono text-xs">
              <span class={`font-medium ${DECISION_CLS[d().decision]}`}>{d().decision}</span>
              <Show when={d().rule_id}>
                <span class="text-muted-foreground"> via </span>
                <span class="text-foreground">{d().rule_id}</span>
              </Show>
              <Show when={d().reason}>
                <div class="mt-1 text-muted-foreground">{d().reason}</div>
              </Show>
            </div>
          )}
        </Show>
        <Show when={testErr()}>
          <p class="mt-2 font-mono text-xs text-destructive">{testErr()}</p>
        </Show>
      </section>
    </main>
  );
}
