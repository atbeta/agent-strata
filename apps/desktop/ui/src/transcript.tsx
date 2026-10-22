import { createEffect, createMemo, createSignal, For, Index, Match, on, onCleanup, onMount, Show, Switch, type JSX } from "solid-js";
import type { ContentBlock, ToolCallView, Turn } from "./api";
import { Button } from "@/components/ui/button";
import { ListRow } from "@/components/ui/list-row";
import { RowButton } from "@/components/ui/row-button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { copyText } from "./clipboard";
import { Icon, type Name } from "./icons";
import { Md } from "./md";
import { Tip } from "./tip";
import { stripAnsi } from "./ansi";
import { Code, CopyButton } from "./payload";
import { t, tn } from "./i18n";
import { cn } from "@/lib/utils";
import { readThinkingOpen } from "./thinking";
import {
  assistantNotice,
  diffStat,
  fmtElapsed,
  fmtLatency,
  formatThinkingClock,
  hasMessageContent,
  isDiff,
  isInteractiveTool,
  messageText,
  permissionLabel,
  toolStatusLabel,
  thinkingElapsed,
  thinkingPreview,
  todoItems,
  toolHeadline,
  toolIcon,
  type ToolKind,
} from "./transcript-format";
import { MessageActions } from "./message-actions";

/**
 * A right-click on a message gets the same things the action row under it
 * offers, plus what a pointer gesture makes natural: copy just the marked
 * text. The trigger keeps `contents` so the message's own box is the surface
 * the menu opens on.
 */
function MessageMenu(props: {
  text: () => string;
  onEdit?: () => void;
  onRevert?: () => void;
  onFork?: () => void;
  children: JSX.Element;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger class="contents">{props.children}</ContextMenuTrigger>
      <ContextMenuContent class="min-w-40">
        {(() => {
          // Read at open time: a selection the pointer just made is what a
          // "copy selection" item is for, and the menu renders lazily.
          const sel = window.getSelection()?.toString().trim() ?? "";
          return sel ? (
            <ContextMenuItem onSelect={() => void copyText(sel)}>
              <Icon name="copy" class="size-3.5 text-muted-foreground" />
              {t("message.copySelection")}
            </ContextMenuItem>
          ) : null;
        })()}
        <Show when={props.text().trim()}>
          <ContextMenuItem onSelect={() => void copyText(props.text())}>
            <Icon name="copy" class="size-3.5 text-muted-foreground" />
            {t("message.copy")}
          </ContextMenuItem>
        </Show>
        <Show when={props.onEdit || props.onRevert || props.onFork}>
          <ContextMenuSeparator />
        </Show>
        <Show when={props.onEdit}>
          {(edit) => (
            <ContextMenuItem onSelect={() => edit()()}>
              <Icon name="pencil" class="size-3.5 text-muted-foreground" />
              {t("message.edit")}
            </ContextMenuItem>
          )}
        </Show>
        <Show when={props.onRevert}>
          {(revert) => (
            <ContextMenuItem onSelect={() => revert()()}>
              <Icon name="undo" class="size-3.5 text-muted-foreground" />
              {t("message.revert")}
            </ContextMenuItem>
          )}
        </Show>
        <Show when={props.onFork}>
          {(fork) => (
            <ContextMenuItem onSelect={() => fork()()}>
              <Icon name="fork" class="size-3.5 text-muted-foreground" />
              {t("message.fork")}
            </ContextMenuItem>
          )}
        </Show>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** A reader's own open/closed choice, so a refresh does not snap it back. */
const thinkingChoice = new Map<string, boolean>();

function ThinkingBlock(props: {
  text: string;
  live?: boolean;
  scope?: string;
  startedMs?: number;
  endedMs?: number;
}) {
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
  // A thought we watched live still has a duration when the backend sent no
  // end. One that arrives already finished, with no span, stays blank.
  const [now, setNow] = createSignal(Date.now());
  const [seenAt, setSeenAt] = createSignal<number | undefined>(props.live ? Date.now() : undefined);
  const [frozenAt, setFrozenAt] = createSignal<number>();
  createEffect(() => {
    if (props.live) {
      if (seenAt() == null) setSeenAt(Date.now());
      const id = setInterval(() => setNow(Date.now()), 1000);
      onCleanup(() => clearInterval(id));
      return;
    }
    if (seenAt() != null) setFrozenAt((v) => v ?? Date.now());
  });
  const clock = () => {
    const live = props.live === true;
    const backend = thinkingElapsed({
      startedMs: props.startedMs,
      endedMs: props.endedMs,
      live,
      now: now(),
    });
    if (backend != null) return formatThinkingClock(backend, live);
    const start = seenAt();
    if (start == null) return undefined;
    const end = live ? now() : frozenAt();
    if (end == null) return undefined;
    return formatThinkingClock(Math.max(0, end - start), live);
  };
  return (
    // Same shape as the tool row below — one hanging indent, one inset, one
    // icon column. A thought and a tool call are both collapsed activity with
    // a chevron and they alternate down the stream, so they share the row's
    // exact geometry or the icon column drifts with every other line.
    <div class="-ml-2">
      <RowButton class="text-xs focus-visible:ring-inset" aria-expanded={open()} onClick={toggle}>
        <Icon
          name="brain"
          class={`size-3.5 shrink-0 ${props.live ? "text-status-active motion-safe:animate-pulse" : "text-muted-foreground"}`}
        />
        <span class="shrink-0 text-xs font-medium text-muted-foreground">
          {props.live ? t("transcript.thinking") : t("transcript.thought")}
        </span>
        <Show when={clock()}>
          {(c) => (
            <span
              class={`shrink-0 font-mono text-2xs tabular-nums ${props.live ? "text-status-active" : "text-muted-foreground"}`}
            >
              {c()}
            </span>
          )}
        </Show>
        <Show when={!open() && thinkingPreview(props.text)}>
          {/* rtl puts the overflow on the left, so a narrow row keeps the
              newest words. The inner bdi draws those words left to right. */}
          <span dir="rtl" class="min-w-0 truncate text-left text-xs text-muted-foreground/70">
            <bdi dir="ltr">{thinkingPreview(props.text)}</bdi>
          </span>
        </Show>
        <span
          class="ml-auto inline-flex shrink-0 text-muted-foreground transition-transform"
          style={{ transform: open() ? "none" : "rotate(-90deg)" }}
        >
          <Icon name="chevron" class="size-3" />
        </span>
      </RowButton>
      <Show when={open()}>
        {/* The collapse stays on the row. A long thought scrolls in this box,
            so the control is never a page above the words being read. */}
        <div class="expand-in ml-[22px] max-h-72 overflow-y-auto overscroll-y-contain py-1.5">
          <Md class="text-sm leading-6 text-muted-foreground" text={props.text} />
        </div>
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
        {(block) => (
          <ThinkingBlock
            text={block().text}
            live={props.live}
            scope={props.scope}
            startedMs={block().started_ms}
            endedMs={block().ended_ms}
          />
        )}
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

/**
 * A note that stands apart from the message flow — "generation stopped",
 * "context compacted". A rule on both sides rather than the pill and the
 * bare centred line it replaces: one shape for every thing that is a seam
 * in the transcript rather than part of what was said.
 */
function TranscriptDivider(props: { icon?: Name; children: JSX.Element }) {
  return (
    <div role="status" class="flex items-center gap-2.5 py-1 text-2xs text-muted-foreground">
      <span class="h-px flex-1 bg-border" />
      <Show when={props.icon}>
        {(name) => <Icon name={name()} class="size-3 shrink-0" />}
      </Show>
      {props.children}
      <span class="h-px flex-1 bg-border" />
    </div>
  );
}

/** The three dots a call that has not answered yet writes under itself —
 *  quieter than naming the state, which the row's status already did. */
function PendingDots() {
  return (
    <p class="flex items-center gap-1 px-2.5 py-2" aria-hidden="true">
      <span class="tool-dot size-1 rounded-full bg-muted-foreground/50" />
      <span class="tool-dot size-1 rounded-full bg-muted-foreground/50" style={{ "animation-delay": "150ms" }} />
      <span class="tool-dot size-1 rounded-full bg-muted-foreground/50" style={{ "animation-delay": "300ms" }} />
    </p>
  );
}

/**
 * A shell call reads as the terminal it ran in: the command echoed on a `$`
 * line and the output beneath it, in one well. The command only repeats when
 * the row's one line could not hold it — a short command already sits in the
 * row, so echoing it again is noise. The copy button prefers the output the
 * way a reader does: the answer is the thing worth keeping, the command only
 * when there is no answer yet.
 */
function ShellWell(props: { call: ToolCallView; command?: string; running: boolean }) {
  const output = () => props.call.output;
  const copy = () => (output() ? stripAnsi(output()!) : (props.command ?? ""));
  return (
    <Show when={props.command || output() || props.running}>
      <div class="group relative overflow-hidden rounded-md border border-border bg-secondary/40">
        <Show when={props.command}>
          <p class="whitespace-pre-wrap break-words px-2.5 pb-1.5 pt-2 font-mono text-2xs leading-5 text-muted-foreground">
            <span class="select-none text-muted-foreground/60">$ </span>
            {props.command}
          </p>
        </Show>
        <Show when={output()}>
          <div class={props.command ? "border-t border-border" : undefined}>
            <Code source={output()!} maxHeight="max-h-72" class="rounded-none border-0 bg-transparent" />
          </div>
        </Show>
        <Show when={!output() && props.running}>
          <PendingDots />
        </Show>
        <Show when={copy()}>
          <div class="absolute right-1.5 top-1.5">
            <CopyButton text={copy()} />
          </div>
        </Show>
      </div>
    </Show>
  );
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
    <div class="group relative">
      <Show
        when={diff()}
        fallback={<Code source={clean()} maxHeight="max-h-72" />}
      >
        <pre class="max-h-72 overflow-auto rounded-md border border-border bg-secondary/40 px-3 py-2 font-mono text-xs leading-5">
        <For each={clean().split("\n")}>
          {(line) => <div class={`break-words whitespace-pre-wrap ${diffLineClass(line)}`}>{line || " "}</div>}
        </For>
      </pre>
      </Show>
      <div class="absolute right-1.5 top-1.5">
        <CopyButton text={clean()} />
      </div>
    </div>
  );
}

type ChildSession = { title: string; status: string; busy?: boolean };

function ToolCallCard(props: {
  call: ToolCallView;
  /** The session is running, so a `pending` call is work in progress. Without
   *  it `pending` is an orphaned state — the app died mid-call — and reads as
   *  unfinished rather than running. */
  live?: boolean;
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
  // Same gate the well uses: only an edit whose output parses as a diff earns
  // a change count. `ls -l` rows start with `-` too — counting them painted a
  // fake "+0 −24" on a plain directory listing.
  const stat = () => {
    const out = props.call.output;
    return out && headline().kind === "edit" && isDiff(stripAnsi(out)) ? diffStat(out) : undefined;
  };
  const denied = () => props.call.permission?.decision === "deny" || props.call.status === "error";
  // The row keeps one line and truncates; the well is where the full command
  // belongs, echoing what the shell actually ran.
  const command = () => {
    if (headline().kind !== "shell") return undefined;
    const c = props.call.input?.command;
    if (typeof c !== "string") return undefined;
    // A short single-line command already fits the row — echoing it again is
    // noise. Only multiline or truncation-length commands earn the repeat.
    return c.includes("\n") || c.length > 60 ? c : undefined;
  };
  /** A pending call is only "running" while the session is. */
  const running = () => props.call.status === "pending" && props.live === true;
  const [open, setOpen] = createSignal(running() || props.call.status === "error");
  createEffect(
    on(
      () => props.call.status,
      (status, prev) => {
        if (status === "error" || (status === "pending" && props.live)) setOpen(true);
        else if (prev === "pending" && status === "ok") setOpen(false);
      },
    ),
  );
  /**
   * A running call says how long it has been running, not just that it is.
   * The ticker exists only while this row is pending — a settled call has a
   * latency and nothing to count — and it counts from the call's own `ts`,
   * so a slow open does not restart the clock. A call parked at a permission
   * prompt or waiting on a reader is waiting on a person, not running, so it
   * keeps the word instead of the number.
   */
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (!running()) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(id));
  });
  const elapsed = () => {
    if (!running()) return undefined;
    if (props.call.permission && !props.call.permission.decision) return undefined;
    if (isInteractiveTool(props.call.tool)) return undefined;
    return fmtElapsed(props.call.ts ?? "", now());
  };
  const todos = () => todoItems(props.call.input);
  const status = () => toolStatusLabel(props.call, props.live === true);
  // A person saying yes marks the row; policy and auto approvals say nothing
  // new, and a deny already reads in the row's red.
  const userAllowed = () =>
    props.call.permission?.decision === "allow" && props.call.permission.by === "user";
  const permLabel = () =>
    props.call.permission?.decision || props.call.status === "pending"
      ? permissionLabel(props.call.permission)
      : undefined;
  /* One quiet line, not a card: a transcript can hold a dozen of these in a
     row, and giving each one a border and a fill turned the conversation into
     a stack of chrome. The hanging indent under the icon carries the expanded
     output the way a file tree carries its children. */
  return (
    <div class="-ml-2">
      <Tip label={open() ? t("tool.output.hide") : t("tool.output.show")} class="w-full">
        <ListRow
          class="h-auto py-1.5 text-xs hover:bg-secondary/60 focus-visible:ring-inset"
          expanded={open()}
          onOpen={() => setOpen((v) => !v)}
        >
          <Icon
            name={toolIcon(props.call.tool)}
            class={`size-3.5 shrink-0 ${denied() ? "text-destructive" : "text-muted-foreground"}`}
          />
          <span class={`shrink-0 text-xs font-medium ${denied() ? "text-destructive" : "text-muted-foreground"}`}>
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
          <Show when={userAllowed()}>
            <Tip label={permLabel() ?? ""}>
              <Icon name="shield-check" class="size-3 shrink-0 text-muted-foreground" />
            </Tip>
          </Show>
          <Show when={elapsed()}>
            {(s) => (
              <Tip label={t("status.running")}>
                <span
                  class="shrink-0 font-mono text-2xs tabular-nums text-status-active"
                  aria-label={t("status.running")}
                >
                  <span class="mr-1 inline-block size-1.5 motion-safe:animate-pulse rounded-full bg-status-active align-middle" />
                  {s()}
                </span>
              </Tip>
            )}
          </Show>
          <Show when={!elapsed() && (status() || childBusy() || childError())}>
            <span
              class={`shrink-0 text-2xs ${
                childError() || status()?.tone === "danger"
                  ? "text-destructive"
                  : childBusy() || status()?.tone === "live"
                    ? "text-status-active"
                    : "text-muted-foreground"
              }`}
            >
              <Show when={running() || childBusy()}>
                <span class="mr-1 inline-block size-1.5 motion-safe:animate-pulse rounded-full bg-status-active align-middle" />
              </Show>
              {status()?.text}
            </span>
          </Show>
          {/* Interactive tools wait on the reader, so their latency is a
              person's pause, not a runtime — there is nothing to report. */}
          <Show when={!status() && !isInteractiveTool(props.call.tool) && fmtLatency(props.call.latency_ms)}>
            <span class="shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
              {fmtLatency(props.call.latency_ms)}
            </span>
          </Show>
          <Show when={props.call.child_session_id}>
            {(id) => (
              <Button
                type="button"
                variant="quiet"
                size="sm"
                class="h-auto shrink-0 px-0"
                data-row-menu=""
                onClick={(e) => {
                  e.stopPropagation();
                  props.onOpenChild?.(id());
                }}
                onKeyDown={(e) => e.stopPropagation()}
              >
                {t("session.child.open")}
              </Button>
            )}
          </Show>
          <span
            class="inline-flex shrink-0 text-muted-foreground transition-transform"
            style={{ transform: open() ? "none" : "rotate(-90deg)" }}
          >
            <Icon name="chevron" class="size-3" />
          </span>
        </ListRow>
      </Tip>
      <Show when={open()}>
        {/* Expanded content aligns under the row's text, past the icon and its
            gap — a box carries the boundary now, so no rail is needed. */}
        <div class="expand-in ml-[22px] space-y-2 pb-2">
          <Show when={permLabel()}>
            {(label) => (
              <p
                class={cn(
                  "flex items-center gap-1.5 text-2xs",
                  props.call.permission?.decision === "deny"
                    ? "text-destructive"
                    : props.call.permission && !props.call.permission.decision
                      ? "text-event-permission"
                      : "text-muted-foreground",
                )}
              >
                <Icon
                  name={props.call.permission?.decision === "allow" ? "shield-check" : "shield"}
                  class="size-3 shrink-0"
                />
                {label()}
              </p>
            )}
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
          <Show
            when={headline().kind === "shell"}
            fallback={
              <Show
                when={props.call.output}
                fallback={
                  <Show when={running()}>
                    <PendingDots />
                  </Show>
                }
              >
                <OutputWell text={props.call.output!} kind={headline().kind} />
              </Show>
            }
          >
            <ShellWell call={props.call} command={command()} running={running()} />
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
  /** Whether the copy/fork row keeps its space under this message. Only the
   *  turn's closing row carries one — between a paragraph and the tools it
   *  called, a reserved-but-hidden action row reads as a hole in the text.
   *  The actions stay reachable through the right-click menu regardless. */
  footer?: boolean;
  onFork?: (messageId: string) => void;
}) {
  const text = () => messageText(props.message.content);
  const notice = () => assistantNotice(props.message.error);
  const forkable = () => Boolean(props.onFork && props.message.msg_id);
  const hasFooter = () => text().trim() !== "";
  return (
    <Show when={hasMessageContent(props.message.content) || notice()}>
      <MessageMenu
        text={text}
        onFork={forkable() ? () => props.onFork!(props.message.msg_id!) : undefined}
      >
      {/* `py-1` carries the beat between this paragraph and the tool row that
          follows it: `space-y-2` margins cannot reach through MessageMenu's
          `display:contents` wrapper, so the gap lives on the row itself. */}
      <div class="transcript-message py-1" data-message-role="assistant">
        <div class="relative">
          <BlockText
            blocks={props.message.content}
            live={props.message.partial}
            scope={props.message.msg_id ?? `${props.turnId}:m${props.index}`}
          />
          <Show when={notice()?.kind === "stopped" ? notice() : undefined}>
            {(n) => (
              <div class="mt-2">
                <TranscriptDivider icon="stop">{n().text}</TranscriptDivider>
              </div>
            )}
          </Show>
          <Show when={notice()?.kind === "error" ? notice() : undefined}>
            {(n) => (
              <p
                role="alert"
                class="mt-1 flex items-start gap-1.5 whitespace-pre-wrap break-words rounded-md bg-destructive/6 px-3 py-2 text-xs text-destructive"
              >
                <Icon name="alert" class="mt-0.5 size-3 shrink-0" />
                <span class="min-w-0 flex-1 whitespace-pre-wrap break-words">{n().text}</span>
              </p>
            )}
          </Show>
          <Show when={props.message.partial && props.message.content.some((block) => block.type === "text")}>
            <span class="ml-0.5 inline-block h-[1em] w-[2px] translate-y-0.5 motion-safe:animate-pulse bg-foreground/70 align-text-bottom" />
          </Show>
        </div>
        <Show when={props.footer && hasFooter()}>
          <MessageActions
            text={text()}
            align="start"
            disabled={props.message.partial === true}
            onFork={forkable() ? () => props.onFork!(props.message.msg_id!) : undefined}
          />
        </Show>
      </div>
      </MessageMenu>
    </Show>
  );
}

/**
 * A settled run of calls folds behind one line once it outweighs the text it
 * serves — four compact rows already cost more reading than the paragraph
 * around them. A run that is still moving or ended in failure stays expanded:
 * pending is live state and an error is the thing the reader came looking
 * for. Expanded calls hang under the header's icon, same rail the output
 * inside one call uses.
 */
function ToolRun(props: {
  calls: ToolCallView[];
  /** The session is running — a `pending` call is live work, not an orphan. */
  live?: boolean;
  childOf?: (id: string) => ChildSession | undefined;
  onOpenChild?: (id: string) => void;
}) {
  const foldable = () =>
    props.calls.length > 3 &&
    props.calls.every((c) => c.status === "ok" && c.permission?.decision !== "deny");
  const [open, setOpen] = createSignal(!foldable());
  // A run animates only while a call is still `pending` AND the session is
  // live — `pending` alone is just "no result yet", which an orphaned call
  // keeps saying forever.
  const live = () => props.live === true && props.calls.some((c) => c.status === "pending");
  return (
    <div class={`space-y-1 ${live() ? "tool-live-in" : ""}`}>
      <Show when={foldable()}>
        <RowButton
          class="-ml-2 text-xs focus-visible:ring-inset"
          aria-expanded={open()}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name="wrench" class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="min-w-0 truncate text-xs font-medium text-muted-foreground">
            {tn("transcript.toolRun", props.calls.length)}
          </span>
          <span
            class="ml-auto inline-flex shrink-0 text-muted-foreground transition-transform"
            style={{ transform: open() ? "none" : "rotate(-90deg)" }}
          >
            <Icon name="chevron" class="size-3" />
          </span>
        </RowButton>
      </Show>
      <Show when={open()}>
        <div class={`expand-in ${foldable() ? "ml-[22px] " : ""}space-y-1`}>
          {/*
           * `<Index>`, not `<For>`. A run is built while it works — calls arrive
           * one at a time — and `<For>` maps by identity, so it tore down and
           * rebuilt every card each time the array changed. That reset each
           * card's internal state, and it would have replayed their entrance on
           * every arrival, which is a strobe rather than a transition.
           * `<Index>` maps by position: a new call adds one node and the rest
           * are left alone.
           */}
          <Index each={props.calls}>
            {(call) => (
              <ToolCallCard
                call={call()}
                live={props.live}
                childOf={props.childOf}
                onOpenChild={props.onOpenChild}
              />
            )}
          </Index>
        </div>
      </Show>
    </div>
  );
}

export function TurnBlock(props: {
  turn: Turn;
  /**
   * Whether this turn arrived while the reader was already in this session.
   * Anything built in one pass — opening a conversation, switching to one, or
   * scrolling a long one back into view — is not arriving, and must paint
   * still. See `entrance.ts`.
   */
  entering?: () => boolean;
  /** the agent has been asked but has said nothing yet */
  awaiting?: () => boolean;
  /** The session is running and this is its working turn, so `pending` calls
   *  in it are live work rather than orphans of a dead run. */
  live?: () => boolean;
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
    <div
      class={`${props.entering?.() ? "rise-in " : ""}space-y-2 ${props.turn.reverted ? "opacity-50" : ""}`}
    >
      <Show when={props.turn.user}>
        {(blocks) => (
          <MessageMenu
            text={() => messageText(blocks())}
            onEdit={
              props.onEdit
                ? () => props.onEdit!(props.turn.turn_id, messageText(blocks()))
                : undefined
            }
            onRevert={props.onRevert ? () => props.onRevert!(props.turn.turn_id) : undefined}
            onFork={props.onFork ? () => props.onFork!(props.turn.turn_id) : undefined}
          >
          <div class="transcript-message flex w-full flex-col items-end" data-message-role="user">
            <Show when={props.turn.reverted}>
              <p class="text-2xs text-muted-foreground">{t("message.reverted")}</p>
            </Show>
            <div class="max-w-[min(85%,36rem)] rounded-xl bg-secondary px-3.5 py-2 text-secondary-foreground">
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
          </MessageMenu>
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
                  footer={index === flow().length - 1}
                  onFork={props.onFork}
                />
              )}
            </Match>
            <Match when={row().kind === "tools" ? (row() as Extract<FlowRow, { kind: "tools" }>) : undefined}>
              {(r) => (
                <ToolRun
                  calls={r().calls}
                  live={props.live?.()}
                  childOf={props.childOf}
                  onOpenChild={props.onOpenChild}
                />
              )}
            </Match>
          </Switch>
        )}
      </Index>
      <Show when={props.awaiting?.()}>
        <div class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Icon name="brain" class="size-3.5 shrink-0 text-status-active motion-safe:animate-pulse" />
          {t("transcript.thinking")}
        </div>
      </Show>
      <Show when={props.turn.compaction}>
        <TranscriptDivider>{t("message.compacted")}</TranscriptDivider>
      </Show>
    </div>
  );
}
