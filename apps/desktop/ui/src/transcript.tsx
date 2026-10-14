import { createEffect, createMemo, createSignal, For, Index, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import type { ContentBlock, ToolCallView, Turn } from "./api";
import { Icon } from "./icons";
import { Md } from "./md";
import { Tip } from "./tip";
import { stripAnsi } from "./ansi";
import { Code } from "./payload";
import { t } from "./i18n";
import { readThinkingOpen } from "./thinking";
import {
  assistantNotice,
  diffStat,
  fmtLatency,
  hasMessageContent,
  isDiff,
  messageText,
  permissionLabel,
  statusLabel,
  thinkingPreview,
  todoItems,
  toolHeadline,
  type ToolKind,
} from "./transcript-format";
import { MessageActions } from "./message-actions";

/** A reader's own open/closed choice, so a refresh does not snap it back. */
const thinkingChoice = new Map<string, boolean>();

function ThinkingBlock(props: { text: string; live?: boolean; scope?: string }) {
  const [open, setOpen] = createSignal(
    props.scope !== undefined && thinkingChoice.has(props.scope)
      ? thinkingChoice.get(props.scope)!
      : readThinkingOpen(),
  );
  onMount(() => {
    const onPref = () => {
      if (props.scope !== undefined && thinkingChoice.has(props.scope)) return;
      setOpen(readThinkingOpen());
    };
    window.addEventListener("strata-thinking", onPref);
    onCleanup(() => window.removeEventListener("strata-thinking", onPref));
  });
  const toggle = () => {
    const next = !open();
    if (props.scope !== undefined) thinkingChoice.set(props.scope, next);
    setOpen(next);
  };
  return (
    // `px-2.5` and `gap-2` are the tool card's own insets (below), not the
    // transcript's. A thought row and a tool card are the same kind of thing —
    // collapsed activity with a chevron — and they alternate down the stream, so
    // their icons have to share one column. Sized identically but set at the
    // content edge, the brain sat 11px left of every terminal.
    <div class="my-2 px-2.5">
      <button
        class="flex max-w-full items-center gap-2 text-left text-sm text-muted-foreground hover:text-foreground"
        aria-expanded={open()}
        onClick={toggle}
      >
        <Icon name="brain" class={`size-3.5 shrink-0 ${props.live ? "motion-safe:animate-pulse" : ""}`} />
        <span class="shrink-0 font-medium">
          {props.live ? t("transcript.thinking") : t("transcript.thought")}
        </span>
        <Show when={!open() && thinkingPreview(props.text)}>
          <span class="min-w-0 truncate font-normal">{thinkingPreview(props.text)}</span>
        </Show>
        <span
          class="inline-flex shrink-0 transition-transform"
          style={{ transform: open() ? "none" : "rotate(-90deg)" }}
        >
          <Icon name="chevron" class="size-3" />
        </span>
      </button>
      <Show when={open()}>
        <Md
          class="mt-1.5 border-l border-border pl-3 text-sm leading-6 text-muted-foreground"
          text={props.text}
        />
      </Show>
    </div>
  );
}

function FileChip(props: { path: string; range?: { start: number; end: number } }) {
  const name = () => {
    const parts = props.path.split(/[/\\]/);
    return parts[parts.length - 1] || props.path;
  };
  const range = () =>
    props.range ? `${props.range.start}–${props.range.end}` : undefined;
  return (
    <span
      class="my-1 inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-secondary/50 px-2 py-0.5 align-middle font-mono text-2xs text-event-file"
      title={props.path}
    >
      <Icon name="files" class="size-3 shrink-0" />
      <span class="truncate">{name()}</span>
      <Show when={range()}>
        <span class="shrink-0 text-muted-foreground">{range()}</span>
      </Show>
    </span>
  );
}

function imageSrc(block: Extract<ContentBlock, { type: "image" }>): string | undefined {
  if (block.uri) return block.uri;
  if (!block.data) return undefined;
  if (block.data.startsWith("data:")) return block.data;
  return `data:${block.mime};base64,${block.data}`;
}

function ImageBlock(props: { block: Extract<ContentBlock, { type: "image" }> }) {
  const src = () => imageSrc(props.block);
  return (
    <Show when={src()} fallback={<p class="my-1 text-xs text-muted-foreground">{t("transcript.image")}</p>}>
      <img
        src={src()}
        alt=""
        class="my-2 max-h-80 max-w-full rounded-lg border border-border object-contain"
      />
    </Show>
  );
}

function TranscriptBlock(props: { block: ContentBlock; tight?: boolean; live?: boolean; scope?: string }) {
  return (
    <Switch>
      <Match when={props.block.type === "thinking" ? props.block : undefined}>
        {(block) => <ThinkingBlock text={block().text} live={props.live} scope={props.scope} />}
      </Match>
      <Match when={props.block.type === "file_ref" ? props.block : undefined}>
        {(block) => <FileChip path={block().path} range={block().range} />}
      </Match>
      <Match when={props.block.type === "image" ? props.block : undefined}>
        {(block) => <ImageBlock block={block()} />}
      </Match>
      <Match when={props.block.type === "text" ? props.block : undefined}>
        {(block) => <Md class={props.tight ? "md-bubble" : ""} text={block().text} />}
      </Match>
    </Switch>
  );
}

export function BlockText(props: { blocks: ContentBlock[]; tight?: boolean; live?: boolean; scope?: string }) {
  return (
    <Index each={props.blocks}>
      {(block, index) => (
        <TranscriptBlock
          block={block()}
          tight={props.tight}
          live={props.live === true && index === props.blocks.length - 1}
          scope={props.scope === undefined ? undefined : `${props.scope}:${index}`}
        />
      )}
    </Index>
  );
}

function toolIcon(kind: ToolKind): "terminal" | "files" | "pencil" | "search" | "globe" | "list" | "wrench" {
  if (kind === "shell") return "terminal";
  if (kind === "read") return "files";
  if (kind === "edit") return "pencil";
  if (kind === "search") return "search";
  if (kind === "web") return "globe";
  if (kind === "todo") return "list";
  return "wrench";
}

function diffLineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "text-status-active";
  if (line.startsWith("-") && !line.startsWith("---")) return "text-destructive";
  if (line.startsWith("@@")) return "text-event-tool";
  return "text-muted-foreground";
}

/**
 * Tool output. The `break-all` here was doing damage, not wrapping: a long
 * unbroken token would break mid-word and leave fragments like `r|ecognized`
 * stacked down the card. Normal wrapping plus `break-words` breaks only where
 * the line actually overflows, and only at the last chance to do so.
 */
function OutputWell(props: { text: string; kind: ToolKind }) {
  const clean = () => stripAnsi(props.text);
  const diff = () => props.kind === "edit" && isDiff(clean());
  return (
    <Show
      when={diff()}
      fallback={<Code source={clean()} maxHeight="max-h-72" class="bg-background" />}
    >
      <pre class="max-h-72 overflow-auto rounded-md bg-background px-3 py-2 font-mono text-xs leading-5">
        <For each={clean().split("\n")}>
          {(line) => <div class={`break-words whitespace-pre-wrap ${diffLineClass(line)}`}>{line || " "}</div>}
        </For>
      </pre>
    </Show>
  );
}

type ChildSession = { title: string; status: string; busy?: boolean };

function ToolCallCard(props: {
  call: ToolCallView;
  childOf?: (id: string) => ChildSession | undefined;
  onOpenChild?: (id: string) => void;
}) {
  const headline = () => toolHeadline(props.call);
  const child = () => {
    const id = props.call.child_session_id;
    return id ? props.childOf?.(id) : undefined;
  };
  const title = () => child()?.title || headline().title;
  const childBusy = () => child()?.busy === true;
  const childError = () => child()?.status === "error";
  const stat = () => (props.call.output ? diffStat(props.call.output) : undefined);
  const denied = () => props.call.permission?.decision === "deny" || props.call.status === "error";
  const [open, setOpen] = createSignal(props.call.status === "pending" || props.call.status === "error");
  createEffect(
    on(
      () => props.call.status,
      (status, prev) => {
        if (status === "error" || status === "pending") setOpen(true);
        else if (prev === "pending" && status === "ok") setOpen(false);
      },
    ),
  );
  const todos = () => todoItems(props.call.input);
  const label = () => {
    if (props.call.permission?.decision === "deny") return t("tool.status.denied");
    if (props.call.permission && !props.call.permission.decision && props.call.status === "pending")
      return t("tool.status.needs_permission");
    return statusLabel(props.call.status);
  };
  return (
    <div class={`overflow-hidden rounded-lg border bg-card ${denied() ? "border-destructive/35" : "border-border"}`}>
      <Tip label={open() ? t("tool.output.hide") : t("tool.output.show")} class="w-full">
        <div
          class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-secondary/50"
          role="button"
          tabIndex={0}
          aria-expanded={open()}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            setOpen((v) => !v);
          }}
        >
          <Icon
            name={toolIcon(headline().kind)}
            class={`size-3.5 shrink-0 ${denied() ? "text-destructive" : "text-event-tool"}`}
          />
          <span class={`shrink-0 text-2xs font-medium ${denied() ? "text-destructive" : "text-muted-foreground"}`}>
            {headline().verb}
          </span>
          {/* One line, always. Wrapping a long command was tried and is worse
              than the information it costs: the label and the stats stay
              vertically centred, so the second line reads as an orphan, and the
              row loses its shape. The tail of a long command is in the title. */}
          <span class="min-w-0 flex-1 truncate font-mono text-xs text-foreground/90" title={title()}>
            {title()}
          </span>
          <Show when={stat()}>
            {(s) => (
              <span class="shrink-0 font-mono text-2xs tabular-nums">
                <span class="text-status-active">+{s().add}</span>{" "}
                {/* A zero deletion is not a deletion: painting it destructive
                    spent the reader's eye on a change that did not happen. */}
                <span class={s().del > 0 ? "text-destructive" : "text-muted-foreground"}>
                  −{s().del}
                </span>
              </span>
            )}
          </Show>
          <Show when={label() || childBusy() || childError()}>
            <span
              class={`shrink-0 text-2xs ${
                childError() || denied()
                  ? "text-destructive"
                  : props.call.status === "pending" || childBusy()
                    ? "text-status-active"
                    : "text-muted-foreground"
              }`}
            >
              <Show when={props.call.status === "pending" || childBusy()}>
                <span class="mr-1 inline-block size-1.5 animate-pulse rounded-full bg-status-active align-middle" />
              </Show>
              {label()}
            </span>
          </Show>
          <Show when={!label() && fmtLatency(props.call.latency_ms)}>
            <span class="shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
              {fmtLatency(props.call.latency_ms)}
            </span>
          </Show>
          <Show when={props.call.child_session_id}>
            {(id) => (
              <button
                type="button"
                class="shrink-0 text-sm text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onOpenChild?.(id());
                }}
                onKeyDown={(e) => e.stopPropagation()}
              >
                {t("session.child.open")}
              </button>
            )}
          </Show>
          <span
            class="inline-flex shrink-0 text-muted-foreground transition-transform"
            style={{ transform: open() ? "none" : "rotate(-90deg)" }}
          >
            <Icon name="chevron" class="size-3" />
          </span>
        </div>
      </Tip>
      <Show when={open()}>
        <div class="space-y-2 border-t border-border px-2.5 py-2">
          <Show
            when={
              props.call.permission?.decision || props.call.status === "pending"
                ? permissionLabel(props.call.permission)
                : undefined
            }
          >
            {(label) => <p class="text-2xs text-event-permission">{label()}</p>}
          </Show>
          <Show when={headline().kind === "todo" && todos().length > 0}>
            <ul class="space-y-1">
              <For each={todos()}>
                {(item) => (
                  <li class="flex items-start gap-2 text-sm">
                    <span
                      class={`mt-1.5 size-1.5 shrink-0 rounded-full ${
                        item.status === "completed"
                          ? "bg-status-completed"
                          : item.status === "in_progress"
                            ? "bg-status-active"
                            : "bg-status-pending"
                      }`}
                    />
                    <span class={item.status === "completed" ? "text-muted-foreground line-through" : ""}>
                      {item.content}
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={props.call.output} fallback={
            <Show when={props.call.status === "pending"}>
              <p class="text-xs text-muted-foreground">{t("tool.running")}</p>
            </Show>
          }>
            <OutputWell text={props.call.output!} kind={headline().kind} />
          </Show>
        </div>
      </Show>
    </div>
  );
}

type AssistantMessageData = Turn["assistant"][number];
type FlowRow = { kind: "message"; message: AssistantMessageData } | { kind: "tools"; calls: ToolCallView[] };

/**
 * One assistant message and its action footer. Props stay reactive — the row's
 * partial flag and error arrive later than first render, so everything reads
 * the message through the accessor instead of a frozen local.
 */
function AssistantMessage(props: {
  turnId: string;
  index: number;
  message: AssistantMessageData;
  onFork?: (messageId: string) => void;
}) {
  const text = () => messageText(props.message.content);
  const notice = () => assistantNotice(props.message.error);
  const forkable = () => Boolean(props.onFork && props.message.msg_id);
  const hasFooter = () => text().trim() !== "";
  return (
    <Show when={hasMessageContent(props.message.content) || notice()}>
      <div class="transcript-message max-w-3xl" data-message-role="assistant">
        <div class="relative">
          <BlockText
            blocks={props.message.content}
            live={props.message.partial}
            scope={props.message.msg_id ?? `${props.turnId}:m${props.index}`}
          />
          <Show when={notice()?.kind === "stopped" ? notice() : undefined}>
            {(n) => (
              <p
                role="status"
                class="mt-1 inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/30 px-2 py-1 text-xs text-muted-foreground"
              >
                <Icon name="stop" class="size-3" />
                {n().text}
              </p>
            )}
          </Show>
          <Show when={notice()?.kind === "error" ? notice() : undefined}>
            {(n) => (
              <p
                role="alert"
                class="mt-1 flex items-start gap-1.5 whitespace-pre-wrap break-words rounded-md border border-destructive/20 bg-destructive/5 px-2.5 py-2 text-xs text-destructive"
              >
                <Icon name="alert" class="mt-0.5 size-3 shrink-0" />
                <span class="min-w-0 flex-1 whitespace-pre-wrap break-words">{n().text}</span>
              </p>
            )}
          </Show>
          <Show when={props.message.partial && props.message.content.some((block) => block.type === "text")}>
            <span class="ml-0.5 inline-block h-[1em] w-[2px] translate-y-0.5 animate-pulse bg-foreground/70 align-text-bottom" />
          </Show>
        </div>
        <Show when={hasFooter()}>
          <MessageActions
            text={text()}
            align="start"
            disabled={props.message.partial === true}
            onFork={forkable() ? () => props.onFork!(props.message.msg_id!) : undefined}
          />
        </Show>
      </div>
    </Show>
  );
}

export function TurnBlock(props: {
  turn: Turn;
  /** the agent has been asked but has said nothing yet */
  awaiting?: () => boolean;
  childOf?: (id: string) => ChildSession | undefined;
  onOpenChild?: (id: string) => void;
  onEdit?: (turnId: string, text: string) => void;
  onRevert?: (turnId: string) => void;
  onFork?: (turnId: string) => void;
}) {
  /**
   * One stream: the assistant writes, calls a tool, reads the result, writes
   * again — and the reader should see that, not a wall of prose followed by a
   * pile of cards. `order` only counts within one assistant message and a turn
   * can hold several, so a call is placed by the message that made it and then
   * by its ordinal inside that message. A call the backend never attributed
   * stays at the end, which is the honest place for one of unknown origin.
   */
  const flow = createMemo(() => {
    const msgs = props.turn.assistant;
    const at = new Map<string, number>();
    msgs.forEach((m, i) => {
      if (m.msg_id !== undefined) at.set(m.msg_id, i);
    });
    const calls = new Map<number, ToolCallView[]>();
    const loose: ToolCallView[] = [];
    for (const c of props.turn.tool_calls) {
      const i = c.msg_id === undefined ? undefined : at.get(c.msg_id);
      if (i === undefined) {
        loose.push(c);
        continue;
      }
      const list = calls.get(i) ?? [];
      list.push(c);
      calls.set(i, list);
    }
    const rows: FlowRow[] = [];
    msgs.forEach((message, i) => {
      rows.push({ kind: "message", message });
      const mine = calls.get(i);
      if (mine?.length) rows.push({ kind: "tools", calls: mine });
    });
    if (loose.length) rows.push({ kind: "tools", calls: loose });
    return rows;
  });

  return (
    <div class={`space-y-3 ${props.turn.reverted ? "opacity-50" : ""}`}>
      <Show when={props.turn.user}>
        {(blocks) => (
          <div class="transcript-message flex w-full flex-col items-end" data-message-role="user">
            <Show when={props.turn.reverted}>
              <p class="text-2xs text-muted-foreground">{t("message.reverted")}</p>
            </Show>
            <div class="max-w-[min(85%,36rem)] rounded-2xl rounded-br-md bg-secondary px-3.5 py-2 text-secondary-foreground">
              <BlockText blocks={blocks()} tight />
            </div>
            <Show
              when={
                messageText(blocks()).trim() !== "" || props.onEdit || props.onRevert || props.onFork
              }
            >
              <MessageActions
                text={messageText(blocks())}
                align="end"
                onEdit={
                  props.onEdit
                    ? () => props.onEdit!(props.turn.turn_id, messageText(blocks()))
                    : undefined
                }
                onRevert={props.onRevert ? () => props.onRevert!(props.turn.turn_id) : undefined}
                onFork={props.onFork ? () => props.onFork!(props.turn.turn_id) : undefined}
              />
            </Show>
          </div>
        )}
      </Show>
      <Index each={flow()}>
        {(row, index) => (
          <Switch>
            <Match when={row().kind === "message" ? (row() as Extract<FlowRow, { kind: "message" }>) : undefined}>
              {(r) => (
                <AssistantMessage
                  turnId={props.turn.turn_id}
                  index={index}
                  message={r().message}
                  onFork={props.onFork}
                />
              )}
            </Match>
            <Match when={row().kind === "tools" ? (row() as Extract<FlowRow, { kind: "tools" }>) : undefined}>
              {(r) => (
                <div class="max-w-3xl space-y-1.5">
                  <For each={r().calls}>
                    {(call) => (
                      <ToolCallCard call={call} childOf={props.childOf} onOpenChild={props.onOpenChild} />
                    )}
                  </For>
                </div>
              )}
            </Match>
          </Switch>
        )}
      </Index>
      <Show when={props.awaiting?.()}>
        <div class="flex max-w-3xl items-center gap-2 text-sm text-muted-foreground">
          <Icon name="brain" class="size-3.5 shrink-0 motion-safe:animate-pulse" />
          {t("transcript.thinking")}
        </div>
      </Show>
      <Show when={props.turn.compaction}>
        <div class="border-t border-border pt-3 text-center text-2xs text-muted-foreground">
          {t("message.compacted")}
        </div>
      </Show>
    </div>
  );
}
