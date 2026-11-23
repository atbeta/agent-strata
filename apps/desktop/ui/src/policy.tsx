import { createEffect, createMemo, createResource, createSignal, For, Show, type JSX } from "solid-js";
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
import { fadeSignal } from "./errors";
import { copyText } from "./clipboard";
import type { MessageKey } from "./locales/zh";
import { Icon } from "./icons";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { TextFieldInput } from "@/components/ui/text-field";
import { Picker } from "@/components/ui/picker";
import { Card, Group, Row, Segmented } from "./settings-blocks";

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

/** Every field in the policy editor holds a command, a path or a pattern, so
 *  they are dense and set in the mono face. The rule's reason is the exception
 *  — it is a sentence, and it does not say `mono`. */

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
    // No chrome of its own: it is one cell in the policy card's divide-y, and
    // the hairlines between its parts are the card's language too.
    <div>
      <div class="flex items-center gap-2 py-2">
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
        <TextFieldInput
          size="sm"
          mono
          class="flex-1"
          aria-label={t("policy.field.tool")}
          placeholder="bash"
          title={t("policy.field.toolHint")}
          value={rule().tool}
          onInput={(e) => setRule((r) => (r.tool = e.currentTarget.value))}
        />
        <Button
          type="button"
          size="xs"
          variant="quiet"
          class="shrink-0 hover:bg-destructive/10 hover:text-destructive"
          onClick={props.remove}
        >
          {t("policy.action.remove")}
        </Button>
      </div>

      <div class="grid grid-cols-[4.75rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 border-t border-border py-2.5">
        <span class="text-2xs text-muted-foreground">{t("policy.field.ruleId")}</span>
        <TextFieldInput
          size="sm"
          mono
          aria-label={t("policy.field.ruleId")}
          value={rule().id}
          onInput={(e) => setRule((r) => (r.id = e.currentTarget.value))}
        />
        <span class="text-2xs text-muted-foreground">{t("policy.field.reason")}</span>
        <TextFieldInput
          size="sm"
          placeholder={t("policy.field.reasonPlaceholder")}
          value={rule().reason}
          onInput={(e) => setRule((r) => (r.reason = e.currentTarget.value))}
        />
      </div>

      <div class="border-t border-border py-2.5">
        <div class="flex items-baseline justify-between gap-3">
          <span class="text-2xs text-muted-foreground">
            {t("policy.conditions.title")}
            <span class="ml-2 text-faint-foreground">{t("policy.conditions.hint")}</span>
          </span>
          <Button
            type="button"
            size="xs"
            variant="quiet"
            class="shrink-0"
            onClick={() => setRule((r) => r.conds.push({ path: "", op: "glob", value: "" }))}
          >
            {t("policy.conditions.add")}
          </Button>
        </div>
        <div class={rule().conds.length ? "mt-2 space-y-1.5" : ""}>
          <For each={rule().conds}>
            {(c, ci) => (
              <div class="flex items-center gap-1.5">
                <TextFieldInput
                  size="sm"
                  mono
                  class="w-36"
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
                <TextFieldInput
                  size="sm"
                  mono
                  class="flex-1"
                  placeholder={c.op === "equals" ? "true" : c.op === "matches" ? "\\brm\\b" : "*.env"}
                  value={c.value}
                  onInput={(e) => setRule((r) => (r.conds[ci()]!.value = e.currentTarget.value))}
                />
                <Button
                  type="button"
                  size="icon-sm"
                  variant="quiet"
                  class="shrink-0 hover:bg-destructive/10 hover:text-destructive"
                  aria-label={t("policy.action.remove")}
                  onClick={() => setRule((r) => r.conds.splice(ci(), 1))}
                >
                  ✕
                </Button>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}

export function PolicyEditor() {
  const [saved, { refetch }] = createResource(() => getJson<PolicyResponse>("/policy"));
  const [draft, setDraftRaw] = createStore<Draft>({ default: "ask", rules: [] });
  const setDraft = (fn: (d: Draft) => void) => setDraftRaw(produce(fn));
  const [err, setErr] = fadeSignal("");
  const [notice, setNotice] = fadeSignal("");
  const [fileNotice, setFileNotice] = fadeSignal("");
  const [saving, setSaving] = createSignal(false);
  const [clearing, setClearing] = createSignal(false);
  const [confirmClear, setConfirmClear] = createSignal(false);
  const [testTool, setTestTool] = createSignal("bash");
  const [testInput, setTestInput] = createSignal('{"command": "ls -la"}');
  const [testResult, setTestResult] = createSignal<PolicyDecision | null>(null);
  const [testErr, setTestErr] = fadeSignal("");

  const dirty = createMemo(() => {
    const response = saved();
    if (!response) return false;
    const baseline = response.policy ? fromPolicy(response.policy) : { default: "ask", rules: [] };
    return JSON.stringify(draft) !== JSON.stringify(baseline);
  });
  const postureHint = (): MessageKey => `policy.posture.${draft.default}.hint`;

  createEffect(() => {
    const policy = saved()?.policy;
    if (policy) setDraftRaw(fromPolicy(policy));
  });

  const addRule = () => {
    setErr("");
    setNotice("");
    setDraft((d) => d.rules.push({ id: "", effect: "allow", tool: "", reason: "", conds: [] }));
  };

  const reset = () => {
    const policy = saved()?.policy;
    setDraftRaw(policy ? fromPolicy(policy) : { default: "ask", rules: [] });
    setErr("");
    setNotice("");
  };

  const save = async () => {
    setSaving(true);
    setErr("");
    setNotice("");
    try {
      await savePolicy(toPolicy(draft));
      await refetch();
      setNotice("policy.notice.saved");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setClearing(true);
    setErr("");
    setNotice("");
    try {
      await clearPolicy();
      await refetch();
      setDraftRaw({ default: "ask", rules: [] });
      setNotice("policy.notice.cleared");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setClearing(false);
      setConfirmClear(false);
    }
  };

  const copyFile = async () => {
    const file = saved()?.file;
    if (file && (await copyText(file))) setFileNotice("policy.file.copied");
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
      setTestResult(await testPolicy({ tool: testTool(), input, policy: toPolicy(draft) }));
    } catch (e) {
      setTestErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Show
      when={saved()}
      fallback={
        <Group label={t("settings.permission.title")} hint={t("policy.hint")}>
          <Card><p class="py-3 text-sm text-muted-foreground">{t("policy.loading")}</p></Card>
        </Group>
      }
    >
      <Group label={t("settings.permission.title")} hint={t("policy.hint")}>
        <Card>
          <Row label={t("policy.default.label")} hint={t(postureHint())}>
            <Segmented
              label={t("policy.default.label")}
              value={draft.default}
              options={[
                { id: "ask", label: t("policy.posture.ask") },
                { id: "allow", label: t("policy.posture.allow") },
                { id: "deny", label: t("policy.posture.deny") },
              ]}
              onChange={(id) => {
                setDraftRaw("default", id as Draft["default"]);
                setNotice("");
              }}
            />
          </Row>
        </Card>
      </Group>

      <Group
        label={t("policy.rules.title")}
        hint={tn("policy.rules.count", draft.rules.length)}
        aside={
          <Button type="button" size="sm" variant="outline" onClick={addRule}>
            <Icon name="plus" class="size-3.5" />
            {t("policy.action.addRule")}
          </Button>
        }
      >
        <Card>
          <Show
            when={draft.rules.length > 0}
            fallback={
              <EmptyState
                icon="shield"
                class="py-10"
                title={t("policy.rules.emptyTitle")}
                description={t("policy.rules.empty")}
                action={
                  <Button type="button" size="sm" onClick={addRule}>
                    <Icon name="plus" class="size-3.5" />
                    {t("policy.action.addRule")}
                  </Button>
                }
              />
            }
          >
            <For each={draft.rules}>
              {(_r, i) => (
                <div class="py-2.5">
                  <RuleCard
                    index={i()}
                    draft={draft}
                    setDraft={setDraft}
                    remove={() => setDraft((d) => d.rules.splice(i(), 1))}
                  />
                </div>
              )}
            </For>
          </Show>
        </Card>
      </Group>

      <Show when={err() || notice()}>
        <div class="mt-3">
          <Show when={err()}>
            <p class="flex items-center gap-1.5 text-2xs text-destructive">
              <Icon name="alert" class="size-3 shrink-0" />
              {err()}
            </p>
          </Show>
          <Show when={notice()}>
            <p role="status" class="flex items-center gap-1.5 text-2xs text-muted-foreground">
              <Icon name="check" class="size-3 shrink-0" />
              {t(notice() as MessageKey)}
            </p>
          </Show>
        </div>
      </Show>

      <div class="mt-6 space-y-3">
        <Disclosure title={t("policy.test.title")} hint={t("policy.test.hint")}>
          <div class="flex flex-col gap-3 @min-[560px]/main:flex-row @min-[560px]/main:items-end">
            <div>
              <label class="mb-1 block text-2xs text-muted-foreground" for="policy-test-tool">
                {t("policy.test.tool")}
              </label>
              <TextFieldInput
                id="policy-test-tool"
                size="sm"
                mono
                class="w-28"
                placeholder="bash"
                value={testTool()}
                onInput={(e) => setTestTool(e.currentTarget.value)}
              />
            </div>
            <div class="min-w-0 flex-1">
              <label class="mb-1 block text-2xs text-muted-foreground" for="policy-test-input">
                {t("policy.test.input")}
              </label>
              <TextFieldInput
                id="policy-test-input"
                size="sm"
                mono
                class="w-full"
                value={testInput()}
                onInput={(e) => setTestInput(e.currentTarget.value)}
              />
            </div>
            <Button variant="outline" size="sm" class="shrink-0" onClick={() => void runTest()}>
              {t("policy.test.run")}
            </Button>
          </div>

          <Show when={testResult() || testErr()}>
            <div class="mt-3 border-t border-border pt-3">
              <Show when={testResult()}>
                {(d) => (
                  <div class="text-xs">
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
                <p class="flex items-center gap-1.5 text-2xs text-destructive">
                  <Icon name="alert" class="size-3 shrink-0" />
                  {t(testErr() as MessageKey)}
                </p>
              </Show>
            </div>
          </Show>
        </Disclosure>

        <Disclosure title={t("policy.advanced.title")} hint={t("policy.advanced.hint")}>
          <div class="flex flex-col gap-3 @min-[560px]/main:flex-row @min-[560px]/main:items-center @min-[560px]/main:justify-between">
            <div class="min-w-0">
              <p class="text-sm font-medium text-foreground">{t("policy.file.title")}</p>
              <p class="mt-0.5 text-2xs leading-4 text-muted-foreground">{t("policy.file.hint")}</p>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <Show when={saved()?.file}>
                <code class="max-w-40 truncate font-mono text-2xs text-muted-foreground" title={saved()!.file!}>
                  policy.json
                </code>
                <Button type="button" size="sm" variant="outline" onClick={() => void copyFile()}>
                  {fileNotice() ? t(fileNotice() as MessageKey) : t("policy.file.copy")}
                </Button>
              </Show>
            </div>
          </div>

          <Show when={draft.rules.length > 0 || draft.default !== "ask"}>
            <div class="mt-4 flex flex-col gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-3 @min-[560px]/main:flex-row @min-[560px]/main:items-center @min-[560px]/main:justify-between">
              <div>
                <p class="text-sm font-medium text-foreground">{t("policy.danger.title")}</p>
                <p class="mt-0.5 text-2xs leading-4 text-muted-foreground">{t("policy.danger.hint")}</p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                class="shrink-0"
                onClick={() => setConfirmClear(true)}
              >
                {t("policy.action.clear")}
              </Button>
            </div>
          </Show>
        </Disclosure>
      </div>

      <Show when={dirty()}>
        <div class="sticky bottom-0 z-10 -mx-1 mt-4 flex items-center justify-between gap-3 border-t border-border bg-background/95 px-1 py-3 backdrop-blur">
          <span class="text-2xs text-muted-foreground">{t("policy.dirty")}</span>
          <div class="flex shrink-0 items-center gap-2">
            <Button type="button" size="sm" variant="quiet" disabled={saving()} onClick={reset}>
              {t("confirm.cancel")}
            </Button>
            <Button type="button" size="sm" disabled={saving()} aria-busy={saving()} onClick={() => void save()}>
              {saving() ? t("policy.action.saving") : t("policy.action.save")}
            </Button>
          </div>
        </div>
      </Show>

      <ConfirmDialog
        open={confirmClear()}
        title={t("policy.clear.title")}
        description={t("policy.clear.description")}
        confirmLabel={clearing() ? t("policy.action.clearing") : t("policy.action.clear")}
        cancelLabel={t("confirm.cancel")}
        pending={clearing()}
        onConfirm={() => void clear()}
        onCancel={() => setConfirmClear(false)}
      />
    </Show>
  );
}

function Disclosure(props: { title: string; hint: string; children: JSX.Element }) {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="rounded-lg border border-border bg-card">
      <Button
        type="button"
        variant="quiet"
        class="h-auto w-full items-start justify-between gap-4 whitespace-normal p-4 text-left"
        aria-expanded={open()}
        onClick={() => setOpen((value) => !value)}
      >
        <span>
          <span class="block text-sm font-medium text-foreground">{props.title}</span>
          <span class="mt-0.5 block text-2xs leading-4 text-muted-foreground">{props.hint}</span>
        </span>
        <Icon
          name="chevron-right"
          class={`mt-0.5 size-3.5 shrink-0 transition-transform ${open() ? "rotate-90" : ""}`}
        />
      </Button>
      <Show when={open()}>
        <div class="border-t border-border p-4">{props.children}</div>
      </Show>
    </div>
  );
}
