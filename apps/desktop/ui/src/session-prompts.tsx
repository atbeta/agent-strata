import { createSignal, For, Show } from "solid-js";
import { respondQuestion, type PendingAsk, type PendingQuestion } from "./api";
import { Icon } from "./icons";
import { questionGroups } from "./question-payload";
import { DiffBlock } from "./diff";
import { JsonView } from "./json-view";
import { permissionView, type PermissionView } from "./permission-card";
import { t } from "./i18n";
import { Button } from "@/components/ui/button";
import { ChoiceCard } from "@/components/ui/choice-card";
import { TextFieldInput } from "@/components/ui/text-field";

function askIcon(detail: PermissionView, tool: string): "terminal" | "pencil" | "globe" | "files" | "wrench" {
  if (detail.kind === "command") return "terminal";
  if (detail.kind === "diff") return "pencil";
  if (detail.kind === "url") return "globe";
  if (tool === "read") return "files";
  return "wrench";
}

export function AskCard(props: {
  ask: PendingAsk;
  onRespond: (id: string, decision: "allow" | "deny", scope?: "once" | "always") => void;
}) {
  const detail = () => permissionView(props.ask);
  const body = () => {
    const view = detail();
    if (view.kind === "command") {
      return (
        <pre class="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-secondary/50 px-2.5 py-1.5 font-mono text-xs leading-5">
          {view.command}
        </pre>
      );
    }
    if (view.kind === "diff") {
      return (
        <div class="overflow-hidden rounded-md border border-border">
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
    return (
      <div class="max-h-32 overflow-auto rounded-md bg-secondary/50 px-2.5 py-1.5">
        <JsonView value={props.ask.input} />
      </div>
    );
  };
  return (
    <div class="overflow-hidden rounded-lg border border-event-permission/40 bg-card">
      <div class="flex items-center gap-2 bg-event-permission/8 px-3 py-2">
        <Icon name={askIcon(detail(), props.ask.tool)} class="size-3.5 shrink-0 text-event-permission" />
        <span class="text-xs font-medium">{props.ask.tool}</span>
        <span class="text-2xs text-muted-foreground">{t("permission.wants_to_run")}</span>
      </div>
      <div class="px-3 py-2">{body()}</div>
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

export function QuestionCard(props: { q: PendingQuestion; onDone: () => void }) {
  // `/questions` arrives through a blind cast, so nothing checks its shape. An
  // entry with no `questions` used to throw on the next line — during setup,
  // before the dock could draw its error bar — and take the whole prompt area
  // with it: the agent keeps holding its turn waiting on an answer nobody can
  // see, and the region reads as empty rather than broken. Normalising here
  // keeps a malformed entry on screen and dismissible instead.
  const groups = questionGroups(props.q.questions);
  const [picks, setPicks] = createSignal<string[][]>(groups.map(() => []));
  const [custom, setCustom] = createSignal<string[]>(groups.map(() => ""));
  const [err, setErr] = createSignal("");

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
      const extra = custom()[i]?.trim();
      if (selected.length && extra && question.custom) return [...selected, extra];
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
              <Show when={question.custom}>
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
