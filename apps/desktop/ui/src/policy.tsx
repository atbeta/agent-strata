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
import { Icon } from "./icons";
import { Button } from "@/components/ui/button";
import { Picker } from "@/components/ui/picker";
import { Segmented } from "./settings-blocks";

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
  "h-8 min-w-0 rounded-md border border-border bg-transparent px-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none";

const fieldPicker =
  "h-8 max-w-none rounded-md border border-border bg-transparent px-2 font-sans text-xs text-foreground hover:bg-transparent";

function RuleCard(props: { index: number; draft: Draft; setDraft: (fn: (d: Draft) => void) => void; remove: () => void }) {
  const rule = () => props.draft.rules[props.index]!;
  const setRule = (fn: (r: RuleDraft) => void) =>
    props.setDraft((d) => {
      fn(d.rules[props.index]!);
    });

  const effectCls = () =>
    rule().effect === "deny"
      ? "text-destructive"
      : rule().effect === "allow"
        ? "text-status-active"
        : "text-event-permission";

  return (
    <div class="rounded-lg border border-border">
      <div class="flex items-center gap-2 px-3 py-2">
        <Picker
          label={t(EFFECT_LABEL[rule().effect])}
          value={rule().effect}
          class={`${fieldPicker} ${effectCls()}`}
          options={(Object.keys(EFFECT_LABEL) as RuleDraft["effect"][]).map((fx) => ({
            value: fx,
            label: t(EFFECT_LABEL[fx]),
          }))}
          onChange={(value) => setRule((r) => (r.effect = value as RuleDraft["effect"]))}
        />
        <input
          class={`${inputCls} flex-1`}
          aria-label={t("policy.field.tool")}
          placeholder="bash"
          title={t("policy.field.toolHint")}
          value={rule().tool}
          onInput={(e) => setRule((r) => (r.tool = e.currentTarget.value))}
        />
        <button
          type="button"
          class="shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          onClick={props.remove}
        >
          {t("policy.action.remove")}
        </button>
      </div>

      <div class="grid grid-cols-[4.75rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 border-t border-border px-3 py-2.5">
        <span class="text-2xs text-muted-foreground">{t("policy.field.ruleId")}</span>
        <input
          class={inputCls}
          aria-label={t("policy.field.ruleId")}
          value={rule().id}
          onInput={(e) => setRule((r) => (r.id = e.currentTarget.value))}
        />
        <span class="text-2xs text-muted-foreground">{t("policy.field.reason")}</span>
        <input
          class={`${inputCls} font-sans`}
          placeholder={t("policy.field.reasonPlaceholder")}
          value={rule().reason}
          onInput={(e) => setRule((r) => (r.reason = e.currentTarget.value))}
        />
      </div>

      <div class="border-t border-border px-3 py-2.5">
        <div class="flex items-baseline justify-between gap-3">
          <span class="text-2xs text-muted-foreground">
            {t("policy.conditions.title")}
            <span class="ml-2 text-muted-foreground/70">{t("policy.conditions.hint")}</span>
          </span>
          <button
            type="button"
            class="shrink-0 text-2xs text-muted-foreground hover:text-foreground"
            onClick={() => setRule((r) => r.conds.push({ path: "", op: "glob", value: "" }))}
          >
            {t("policy.conditions.add")}
          </button>
        </div>
        <div class={rule().conds.length ? "mt-2 space-y-1.5" : ""}>
          <For each={rule().conds}>
            {(c, ci) => (
              <div class="flex items-center gap-1.5">
                <input
                  class={`${inputCls} w-36`}
                  aria-label={t("policy.conditions.title")}
                  placeholder="command"
                  value={c.path}
                  onInput={(e) => setRule((r) => (r.conds[ci()]!.path = e.currentTarget.value))}
                />
                <Picker
                  label={t("policy.conditions.title")}
                  value={c.op}
                  class={`${fieldPicker} w-[5.5rem]`}
                  options={[
                    { value: "glob", label: "glob" },
                    { value: "matches", label: "regex" },
                    { value: "equals", label: "equals" },
                  ]}
                  onChange={(value) => setRule((r) => (r.conds[ci()]!.op = value as CondRow["op"]))}
                />
                <input
                  class={`${inputCls} flex-1`}
                  placeholder={c.op === "equals" ? "true" : c.op === "matches" ? "\\brm\\b" : "*.env"}
                  value={c.value}
                  onInput={(e) => setRule((r) => (r.conds[ci()]!.value = e.currentTarget.value))}
                />
                <button
                  type="button"
                  class="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  aria-label={t("policy.action.remove")}
                  onClick={() => setRule((r) => r.conds.splice(ci(), 1))}
                >
                  ✕
                </button>
              </div>
            )}
          </For>
        </div>
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

  /**
   * The rules that keep running are the ones the server still holds, so a
   * delete that did not land has to say so instead of announcing a clear that
   * did not happen — and the draft is only forgotten once it has. Clearing it
   * on failure told the reader their permissions were gone while every rule
   * they had just listed was still deciding what the agent was allowed to do.
   */
  const clear = async () => {
    setErr("");
    setNotice("");
    try {
      await clearPolicy();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return;
    }
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
    // No page wrapper and no heading of its own: this lives in the settings
    // page's permission section, which already names itself. A second <h1>
    // under a section label reads as two pages stacked in one.
    <div>
      <p class="text-2xs leading-4 text-muted-foreground">{t("policy.hint")}</p>
      {/* Its own line, truncated: run inline after a sentence and the wrap
          lands wherever the path happens to be wide, which on a Windows
          profile directory breaks mid-component and reads as a typo. */}
      <Show when={saved()?.file}>
        <p class="mt-1 truncate font-mono text-2xs text-muted-foreground/80" title={saved()!.file ?? undefined}>
          {saved()!.file}
        </p>
      </Show>

      <div class="mt-4 flex items-center justify-between gap-4">
        <div class="min-w-0">
          <div class="text-sm">{t("policy.default.label")}</div>
          <div class="mt-0.5 text-2xs text-muted-foreground">{tn("policy.rules.count", draft.rules.length)}</div>
        </div>
        <Segmented
          label={t("policy.default.label")}
          value={draft.default}
          options={[
            { id: "ask", label: t("policy.rule.effect.ask") },
            { id: "allow", label: t("policy.rule.effect.allow") },
            { id: "deny", label: t("policy.rule.effect.deny") },
          ]}
          onChange={(id) => setDraftRaw("default", id as Draft["default"])}
        />
      </div>
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

      <section class="mt-4 space-y-2">
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
          type="button"
          class="flex items-center gap-1.5 rounded-md px-1 py-1 text-sm text-muted-foreground hover:text-foreground"
          onClick={() =>
            setDraft((d) =>
              d.rules.push({ id: "", effect: "allow", tool: "", reason: "", conds: [] }),
            )
          }
        >
          <Icon name="plus" class="size-3.5" />
          {t("policy.action.addRule")}
        </button>
      </section>

      <div class="mt-3 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => void clear()}>
          {t("policy.action.clear")}
        </Button>
        <Button size="sm" onClick={() => void save()}>
          {t("policy.action.save")}
        </Button>
      </div>

      <section class="mt-8">
        <h2 class="text-xs text-muted-foreground">{t("policy.test.title")}</h2>
        <p class="mt-1 text-2xs leading-4 text-muted-foreground">{t("policy.test.hint")}</p>
        <div class="mt-2 flex gap-2">
          <input
            class={`${inputCls} w-28`}
            aria-label={t("policy.field.tool")}
            placeholder={t("policy.field.tool")}
            value={testTool()}
            onInput={(e) => setTestTool(e.currentTarget.value)}
          />
          <input
            class={`${inputCls} flex-1`}
            value={testInput()}
            onInput={(e) => setTestInput(e.currentTarget.value)}
          />
          <Button variant="secondary" size="sm" class="shrink-0" onClick={() => void runTest()}>
            {t("policy.test.run")}
          </Button>
        </div>
        <Show when={testResult()}>
          {(d) => (
            <div class="mt-2 text-xs">
              <span class={`font-medium ${DECISION_CLS[d().decision]}`}>
                {t(EFFECT_LABEL[d().decision])}
              </span>
              <Show when={d().rule_id}>
                <span class="text-muted-foreground">
                  {t("policy.test.via")}
                  <span class="font-mono text-foreground">{d().rule_id}</span>
                </span>
              </Show>
              <Show when={d().reason}>
                <p class="mt-1 text-2xs text-muted-foreground">{d().reason}</p>
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
    </div>
  );
}
