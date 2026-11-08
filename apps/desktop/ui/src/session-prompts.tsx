import { createSignal, For, Show } from "solid-js";
import { respondQuestion, type PendingAsk, type PendingQuestion } from "./api";
import { Icon } from "./icons";
import { questionAllowsCustom, questionGroups } from "./question-payload";
import { DiffBlock } from "./diff";
import { JsonView } from "./json-view";
import { CodeTokens } from "./payload";
import { permissionView, type PermissionView } from "./permission-card";
import { t } from "./i18n";
import { fadeSignal } from "./errors";
import { toolIcon } from "./transcript-format";
import { Button } from "@/components/ui/button";
import { ChoiceCard } from "@/components/ui/choice-card";
import { TextFieldInput } from "@/components/ui/text-field";

/**
 * The top level of an object when every value is a single fact.
 *
 * Nested arrays or objects are a document and keep the tree view; a handful of
 * scalar fields is a sentence, and the card is asking someone to read it fast.
 */
function flatRows(input: Record<string, unknown>): { key: string; value: string }[] | undefined {
  const entries = Object.entries(input);
  if (entries.length === 0) return undefined;
  const rows: { key: string; value: string }[] = [];
  for (const [key, value] of entries) {
    if (typeof value === "string") {
      if (!value.trim()) continue;
      rows.push({ key, value });
    } else if (typeof value === "number" || typeof value === "boolean") {
      rows.push({ key, value: String(value) });
    } else {
      return undefined;
    }
  }
  return rows.length > 0 ? rows : undefined;
}

function askIcon(
  detail: PermissionView,
  tool: string,
  input: Record<string, unknown>,
): ReturnType<typeof toolIcon> {
  if (detail.kind === "command") return "terminal";
  if (detail.kind === "diff") return "pencil";
  if (detail.kind === "url") return "globe";
  return toolIcon(tool, input);
}

export function AskCard(props: {
  ask: PendingAsk;
  /** Set when the ask belongs to a session this one opened, and names it. */
  from?: string;
  onRespond: (id: string, decision: "allow" | "deny", scope?: "once" | "always") => void;
}) {
  const detail = () => permissionView(props.ask);
  const body = () => {
    const view = detail();
    if (view.kind === "command") {
      return (
        <pre class="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code-surface px-3 py-2 font-mono text-xs leading-5">
          <CodeTokens source={view.command} label="sh" />
        </pre>
      );
    }
    if (view.kind === "paths") {
      // The folders are the ask; the command beside them is context, not the
      // decision. A single dump of both said neither.
      return (
        <div class="space-y-1.5">
          <ul class="max-h-32 space-y-0.5 overflow-auto">
            <For each={view.paths}>
              {(path) => (
                <li class="flex items-start gap-1.5 font-mono text-xs leading-5 text-foreground/90">
                  <Icon name="folder" class="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                  <span class="min-w-0 break-all">{path}</span>
                </li>
              )}
            </For>
          </ul>
          <Show when={view.command}>
            <pre class="max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code-surface px-2.5 py-1.5 font-mono text-2xs leading-5 text-muted-foreground">
              {view.command}
            </pre>
          </Show>
        </div>
      );
    }
    if (view.kind === "diff") {
      return (
        <div class="overflow-hidden rounded-md bg-code-surface">
          <Show when={view.path}>
            <p class="truncate border-b border-border px-2.5 py-1 font-mono text-2xs text-muted-foreground">{view.path}</p>
          </Show>
          <div class="max-h-48 overflow-auto">
            <DiffBlock patch={view.patch} />
          </div>
        </div>
      );
    }
    if (view.kind === "url") {
      return <p class="break-all font-mono text-xs leading-5 text-foreground/90">{view.url}</p>;
    }
    // A flat object reads as a list of facts, not as a document: the braces,
    // quotes and indentation were most of what the card was showing.
    const rows = flatRows(props.ask.input);
    if (rows) {
      return (
        <ul class="max-h-32 space-y-0.5 overflow-auto">
          <For each={rows}>
            {(row) => (
              <li class="flex items-baseline gap-2">
                <span class="shrink-0 font-mono text-2xs text-muted-foreground">{row.key}</span>
                <span class="min-w-0 break-words font-mono text-xs leading-5 text-foreground/90">{row.value}</span>
              </li>
            )}
          </For>
        </ul>
      );
    }
    return (
      <div class="max-h-32 overflow-auto rounded-md bg-secondary/50 px-2.5 py-1.5">
        <JsonView value={props.ask.input} />
      </div>
    );
  };
  return (
    <div class="overflow-hidden rounded-lg border border-event-permission/30 bg-card">
      <div class="flex items-center gap-2 border-b border-event-permission/15 bg-event-permission/6 px-3 py-2">
        <Icon name={askIcon(detail(), props.ask.tool, props.ask.input)} class="size-3.5 shrink-0 text-event-permission" />
        <span class="text-xs font-medium">{props.ask.tool}</span>
        <span class="text-2xs text-muted-foreground">{t("permission.wants_to_run")}</span>
        <Show when={props.from}>
          <span class="ml-auto min-w-0 truncate text-2xs text-muted-foreground">
            {t("prompt.from_child", { name: props.from ?? "" })}
          </span>
        </Show>
      </div>
      {/* No body means no frame: a tool with no arguments is its name and its
          two decisions, and an empty box under them was the whole complaint. */}
      <Show when={detail().kind !== "empty"}>
        <div class="px-3 py-2">{body()}</div>
      </Show>
      <div class="flex items-center justify-end gap-1.5 border-t border-border px-2 py-1.5">
        <Button
          variant="ghost"
          size="sm"
          class="h-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          onClick={() => props.onRespond(props.ask.request_id, "deny")}
        >
          {t("permission.deny")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          class="h-7"
          onClick={() => props.onRespond(props.ask.request_id, "allow", "always")}
        >
          {t("permission.always")}
        </Button>
        <Button size="sm" class="h-7" onClick={() => props.onRespond(props.ask.request_id, "allow", "once")}>
          {t("permission.once")}
        </Button>
      </div>
    </div>
  );
}

export function QuestionCard(props: { q: PendingQuestion; from?: string; onDone: () => void }) {
  // `/questions` arrives through a blind cast, so nothing checks its shape. An
  // entry with no `questions` used to throw on the next line — during setup,
  // before the dock could draw its error bar — and take the whole prompt area
  // with it: the agent keeps holding its turn waiting on an answer nobody can
  // see, and the region reads as empty rather than broken. Normalising here
  // keeps a malformed entry on screen and dismissible instead.
  const groups = questionGroups(props.q.questions);
  const [picks, setPicks] = createSignal<string[][]>(groups.map(() => []));
  const [custom, setCustom] = createSignal<string[]>(groups.map(() => ""));
  const [err, setErr] = fadeSignal("");

  const toggle = (qi: number, label: string, multiple?: boolean) => {
    setPicks((all) =>
      all.map((cur, i) => {
        if (i !== qi) return cur;
        if (multiple) return cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label];
        return cur[0] === label ? [] : [label];
      }),
    );
  };

  const answers = () =>
    groups.map((question, i) => {
      const selected = picks()[i] ?? [];
      const extra = questionAllowsCustom(question) ? custom()[i]?.trim() : "";
      if (selected.length && extra) return [...selected, extra];
      if (selected.length) return selected;
      return extra ? [extra] : [];
    });

  const submit = async () => {
    if (answers().some((a) => a.length === 0)) {
      setErr(t("question.err.answer_each"));
      return;
    }
    setErr("");
    await respondQuestion(props.q.request_id, "reply", answers());
    props.onDone();
  };

  return (
    <div class="overflow-hidden rounded-lg border border-event-user/40 bg-card">
      <Show when={props.from}>
        <div class="border-b border-border bg-secondary/40 px-3 py-1.5 text-2xs text-muted-foreground">
          {t("prompt.from_child", { name: props.from ?? "" })}
        </div>
      </Show>
      <Show
        when={groups.length > 0}
        fallback={
          <div class="px-3 py-2.5">
            <div class="text-sm text-destructive">{t("question.unreadable")}</div>
            <div class="mt-0.5 text-2xs leading-4 text-muted-foreground">
              {t("question.unreadable_hint")}
            </div>
          </div>
        }
      >
        <For each={groups}>
          {(question, qi) => (
            <div class={qi() > 0 ? "border-t border-border px-3 py-2.5" : "px-3 py-2.5"}>
              <Show when={question.header}>
                <div class="text-2xs text-muted-foreground">{question.header}</div>
              </Show>
              <p class="mt-0.5 text-sm">{question.question}</p>
              <div class="mt-2 space-y-1">
                <For each={question.options}>
                  {(opt) => {
                    const on = () => (picks()[qi()] ?? []).includes(opt.label);
                    return (
                      <ChoiceCard
                        mode="press"
                        check
                        selected={on()}
                        onSelect={() => toggle(qi(), opt.label, question.multiple)}
                      >
                        <span class="block text-sm">{opt.label}</span>
                        <Show when={opt.description}>
                          <span class="mt-0.5 block text-2xs leading-4 text-muted-foreground">{opt.description}</span>
                        </Show>
                      </ChoiceCard>
                    );
                  }}
                </For>
              </div>
              <Show when={questionAllowsCustom(question)}>
                <TextFieldInput
                  size="sm"
                  class="mt-2"
                  placeholder={t("question.placeholder.custom")}
                  value={custom()[qi()] ?? ""}
                  onInput={(e) =>
                    setCustom((all) => all.map((v, i) => (i === qi() ? e.currentTarget.value : v)))
                  }
                />
              </Show>
            </div>
          )}
        </For>
      </Show>
      <div class="flex items-center gap-2 border-t border-border px-2 py-1.5">
        <Show when={err()}>
          <span class="min-w-0 flex-1 text-xs text-destructive">{err()}</span>
        </Show>
        <Button
          variant="ghost"
          size="sm"
          class="ml-auto h-7 text-muted-foreground"
          onClick={() => void respondQuestion(props.q.request_id, "reject").then(props.onDone)}
        >
          {t("question.dismiss")}
        </Button>
        <Show when={groups.length > 0}>
          <Button size="sm" class="h-7" onClick={() => void submit()}>
            {t("question.reply")}
          </Button>
        </Show>
      </div>
    </div>
  );
}
