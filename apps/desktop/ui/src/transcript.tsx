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
import { Icon } from "./icons";
import { Md } from "./md";
import { Tip } from "./tip";
import { stripAnsi } from "./ansi";
import { Code, CopyButton } from "./payload";
import { t, tn } from "./i18n";
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
        <Show when={!open() && thinkingPreview(props.text)}>
          <span class="min-w-0 truncate text-xs text-muted-foreground/70">{thinkingPreview(props.text)}</span>
        </Show>
        <span
          class="ml-auto inline-flex shrink-0 text-muted-foreground transition-transform"
          style={{ transform: open() ? "none" : "rotate(-90deg)" }}
        >
          <Icon name="chevron" class="size-3" />
        </span>
      </RowButton>
      <Show when={open()}>
        <div class="ml-[22px] py-1.5">
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
                <span class="mr-1 inline-block size-1.5 motion-safe:animate-pulse rounded-full bg-status-active align-middle" />
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
        <div class="ml-[22px] space-y-2 pb-2">
          <Show when={command()}>
            <p class="break-words font-mono text-2xs leading-5 text-muted-foreground">{command()}</p>
          </Show>
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
      <MessageMenu
        text={text}
        onFork={forkable() ? () => props.onFork!(props.message.msg_id!) : undefined}
      >
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
            <span class="ml-0.5 inline-block h-[1em] w-[2px] translate-y-0.5 motion-safe:animate-pulse bg-foreground/70 align-text-bottom" />
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
  childOf?: (id: string) => ChildSession | undefined;
  onOpenChild?: (id: string) => void;
}) {
  const foldable = () =>
    props.calls.length > 3 &&
    props.calls.every((c) => c.status === "ok" && c.permission?.decision !== "deny");
  const [open, setOpen] = createSignal(!foldable());
  // A run is live while a call is still `pending` — that is the backend's word
  // for a call it has not finished, and `ok`/`error`/`interrupted` are all ways
  // of saying it is over.
  const live = () => props.calls.some((c) => c.status === "pending");
  return (
    <div class={`max-w-3xl space-y-1 ${live() ? "tool-live-in" : ""}`}>
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
        <div class={foldable() ? "ml-[22px] space-y-1" : "space-y-1"}>
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
                  onFork={props.onFork}
                />
              )}
            </Match>
            <Match when={row().kind === "tools" ? (row() as Extract<FlowRow, { kind: "tools" }>) : undefined}>
              {(r) => (
                <ToolRun calls={r().calls} childOf={props.childOf} onOpenChild={props.onOpenChild} />
              )}
            </Match>
          </Switch>
        )}
      </Index>
      <Show when={props.awaiting?.()}>
        <div class="flex max-w-3xl items-center gap-2 text-xs font-medium text-muted-foreground">
          <Icon name="brain" class="size-3.5 shrink-0 text-status-active motion-safe:animate-pulse" />
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
