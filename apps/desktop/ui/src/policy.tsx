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
import { t, tn } from "./i18n";
import type { MessageKey } from "./locales/zh";

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

/**
 * Effect names are wire values as well as words. The map carries the dictionary
 * key so the `<option>` text can be translated; `value=` still sends the raw key
 * to the backend.
 */
const EFFECT_LABEL: Record<PolicyRule["effect"], MessageKey> = {
  allow: "policy.rule.effect.allow",
  deny: "policy.rule.effect.deny",
  ask: "policy.rule.effect.ask",
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
          placeholder={t("policy.field.ruleId")}
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
            {(fx) => <option value={fx}>{t(EFFECT_LABEL[fx])}</option>}
          </For>
        </select>
        <span class="text-xs text-muted-foreground">{t("policy.field.tool")}</span>
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
          {t("policy.action.remove")}
        </button>
      </div>
      <input
        class={`${inputCls} mt-2 w-full font-sans`}
        placeholder={t("policy.field.reason")}
        value={rule().reason}
        onInput={(e) => setRule((r) => (r.reason = e.currentTarget.value))}
      />

      <div class="mt-3 space-y-1.5">
        <div class="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{t("policy.conditions.hint")}</span>
          <button
            class="rounded bg-secondary px-1.5 py-0.5 text-2xs transition-colors hover:text-foreground"
            onClick={() => setRule((r) => r.conds.push({ path: "", op: "glob", value: "" }))}
          >
            {t("policy.conditions.add")}
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
      setNotice("policy.notice.saved");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const clear = async () => {
    setErr("");
    setNotice("");
    await clearPolicy().catch((e) => setErr(e instanceof Error ? e.message : String(e)));
    setDraftRaw({ default: "ask", rules: [] });
    setNotice("policy.notice.cleared");
  };

  const runTest = async () => {
    setTestErr("");
    setTestResult(null);
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(testInput()) as Record<string, unknown>;
    } catch {
      setTestErr("policy.err.invalidJson");
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
        <h1 class="text-xl font-semibold">{t("policy.title")}</h1>
        <p class="mt-1 text-xs text-muted-foreground">
          {t("policy.hint")}
          <Show when={saved()?.file}>
            <span class="font-mono"> · {saved()!.file}</span>
          </Show>
        </p>
      </header>

      <section class="mt-4 flex items-center gap-3 rounded-lg border border-border bg-muted px-4 py-3 text-sm">
        <span class="text-muted-foreground">{t("policy.default.label")}</span>
        <select
          class={inputCls}
          value={draft.default}
          onChange={(e) =>
            setDraftRaw("default", e.currentTarget.value as Draft["default"])
          }
        >
          <option value="ask">{t("policy.rule.effect.ask")}</option>
          <option value="allow">{t("policy.rule.effect.allow")}</option>
          <option value="deny">{t("policy.rule.effect.deny")}</option>
        </select>
        <span class="text-xs text-muted-foreground">
          {tn("policy.rules.count", draft.rules.length)}
        </span>
        <span class="ml-auto flex gap-2">
          <button
            class="rounded-md border border-border bg-secondary px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => void clear()}
          >
            {t("policy.action.clear")}
          </button>
          <button
            class="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            onClick={() => void save()}
          >
            {t("policy.action.save")}
          </button>
        </span>
      </section>
      <Show when={err()}>
        <p class="mt-2 font-mono text-xs text-destructive">{err()}</p>
      </Show>
      {/*
        `notice` and `testErr` carry a dictionary key when the words are ours and
        whatever the backend said otherwise. `t()` hands an unknown key back
        verbatim, so one render site covers both and nothing is translated twice.
      */}
      <Show when={notice()}>
        <p class="mt-2 text-xs text-status-active">{t(notice() as MessageKey)}</p>
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
          {t("policy.action.addRule")}
        </button>
      </section>

      <section class="mt-6 rounded-lg border border-border bg-card p-4">
        <h2 class="text-sm font-medium">{t("policy.test.title")}</h2>
        <p class="mt-1 text-xs text-muted-foreground">
          {t("policy.test.hint")}
        </p>
        <div class="mt-3 flex gap-2">
          <input
            class={`${inputCls} w-32`}
            placeholder={t("policy.field.tool")}
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
            {t("policy.test.run")}
          </button>
        </div>
        <Show when={testResult()}>
          {(d) => (
            <div class="mt-3 rounded-md bg-secondary/50 px-3 py-2 font-mono text-xs">
              <span class={`font-medium ${DECISION_CLS[d().decision]}`}>{d().decision}</span>
              <Show when={d().rule_id}>
                <span class="text-muted-foreground">{t("policy.test.via")}</span>
                <span class="text-foreground">{d().rule_id}</span>
              </Show>
              <Show when={d().reason}>
                <div class="mt-1 text-muted-foreground">{d().reason}</div>
              </Show>
            </div>
          )}
        </Show>
        <Show when={testErr()}>
          <p class="mt-2 font-mono text-xs text-destructive">
            {t(testErr() as MessageKey)}
          </p>
        </Show>
      </section>
    </main>
  );
}
