import { createEffect, createMemo, createSignal, For, Index, Match, on, onCleanup, onMount, Show, Switch, type JSX } from "solid-js";
import { attachmentUrl, type ContentBlock, type ToolCallView, type Turn } from "./api";
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
import { copyImage, copyText } from "./clipboard";
import { pathActions } from "./path-link";
import { Icon, type Name } from "./icons";
import { openImage } from "./image-viewer";
import { Md } from "./md";
import { Tip } from "./tip";
import { stripAnsi } from "./ansi";
import { Code, CodeTokens, CopyButton } from "./payload";
import { t, tn } from "./i18n";
import { cn } from "@/lib/utils";
import { readThinkingOpen } from "./thinking";
import { stableKeys } from "./keyed";
import { useDisclosure } from "./disclosure";
import { createDebouncer } from "./debounce";
import { attributionOf } from "./turn-attribution";
import {
  assistantNotice,
  diffStat,
  fmtElapsed,
  fmtLatency,
  thinkingDuration,
  hasMessageContent,
  goalMetReply,
  isDiff,
  isInteractiveTool,
  isLengthStop,
  isStoppedStop,
  replyInterrupted,
  waitingOnChild,
  messageText,
  silentEmptyReply,
  permissionLabel,
  permissionReason,
  permissionVerdict,
  toolStatusLabel,
  thinkingPreview,
  todoItems,
  toolHeadline,
  toolIcon,
  type ToolKind,
} from "./transcript-format";
import { MessageActions } from "./message-actions";
import type { TurnPart } from "./turn-segments";

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
  /** What the right-click actually landed on — an image asks for image
   *  actions, a path for path actions, not a copy of the text around them.
   *  Read at open time below. */
  let ctxImage: HTMLImageElement | undefined;
  let ctxPath: string | undefined;
  const paths = pathActions();
  return (
    <ContextMenu>
      <ContextMenuTrigger class="contents">
        <div
          class="contents"
          onContextMenu={(e) => {
            ctxImage = e.target instanceof HTMLImageElement ? e.target : undefined;
            ctxPath =
              e.target instanceof Element
                ? (e.target.closest("[data-path]") as HTMLElement | null)?.dataset.path
                : undefined;
          }}
        >
          {props.children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent class="min-w-40">
        {(() => {
          const raw = ctxPath;
          const api = paths;
          return raw && api ? (
            <>
              <ContextMenuItem onSelect={() => api.open(raw)}>
                <Icon name="page" class="size-3.5 text-muted-foreground" />
                {t("path.open")}
              </ContextMenuItem>
              <Show when={api.revealable(raw)}>
                <ContextMenuItem onSelect={() => api.reveal(raw)}>
                  <Icon name="folder-open" class="size-3.5 text-muted-foreground" />
                  {t("path.reveal")}
                </ContextMenuItem>
              </Show>
              <ContextMenuItem onSelect={() => void copyText(raw)}>
                <Icon name="copy" class="size-3.5 text-muted-foreground" />
                {t("path.copy")}
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          ) : null;
        })()}
        {(() => {
          const img = ctxImage;
          return img ? (
            <>
              <ContextMenuItem onSelect={() => openImage(img.currentSrc || img.src, img.alt)}>
                <Icon name="maximize" class="size-3.5 text-muted-foreground" />
                {t("transcript.image.view")}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => void copyImage(img.currentSrc || img.src)}
              >
                <Icon name="copy" class="size-3.5 text-muted-foreground" />
                {t("transcript.image.copy")}
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          ) : null;
        })()}
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

function ThinkingBlock(props: {
  text: string;
  live?: boolean;
  scope?: string;
  startedMs?: number;
  endedMs?: number;
}) {
  const disclosure = useDisclosure();
  const key = () => (props.scope === undefined ? undefined : `thinking:${props.scope}`);
  const chosen = () => {
    const k = key();
    return k === undefined ? undefined : disclosure.get(k);
  };
  const [open, setOpen] = createSignal(chosen() ?? readThinkingOpen());
  onMount(() => {
    const onPref = () => {
      if (chosen() !== undefined) return;
      setOpen(readThinkingOpen());
    };
    window.addEventListener("strata-thinking", onPref);
    onCleanup(() => window.removeEventListener("strata-thinking", onPref));
  });
  let blockEl!: HTMLDivElement;
  const toggle = () => {
    const next = !open();
    const k = key();
    if (k !== undefined) disclosure.set(k, next);
    // Collapsing from a pinned header should land on the collapsed row, not
    // wherever the thought used to end. The header being stuck means the
    // thought's own top is already above the viewport, so pull the row back.
    const stuck =
      !next &&
      blockEl.getBoundingClientRect().top <
        (blockEl.closest(".overflow-y-auto")?.getBoundingClientRect().top ?? -Infinity);
    setOpen(next);
    if (stuck) queueMicrotask(() => blockEl.scrollIntoView({ block: "nearest" }));
  };
  // A live thought shows no time at all — nothing the backend has said yet is
  // a duration, and a client-watched span is a guess. A finished one reports
  // its backend-measured span where a tool row reports its latency.
  const duration = () =>
    props.live ? undefined : thinkingDuration(props.startedMs, props.endedMs);
  return (
    // Same shape as the tool row below — one hanging indent, one inset, one
    // icon column. A thought and a tool call are both collapsed activity with
    // a chevron and they alternate down the stream, so they share the row's
    // exact geometry or the icon column drifts with every other line.
    <div class="-ml-2" ref={blockEl}>
      {/* An open thought can run for a screenful of lines, so its header pins
          to the top of the transcript while the reader scrolls through it and
          releases with the block's own end — the collapse is always at hand
          without a second scrollbar. */}
      <div class={open() ? "sticky top-0 z-10 bg-background" : undefined}>
      <RowButton class="text-xs focus-visible:ring-inset" aria-expanded={open()} onClick={toggle}>
        <Icon
          name="brain"
          class={`size-3.5 shrink-0 ${props.live ? "text-status-active motion-safe:animate-pulse" : "text-muted-foreground"}`}
        />
        <span class="shrink-0 text-xs font-medium text-muted-foreground">
          {props.live ? t("transcript.thinking") : t("transcript.thought")}
        </span>
        <Show when={!open() && thinkingPreview(props.text)}>
          {/* rtl puts the overflow on the left, so a narrow row keeps the
              newest words. The inner bdi draws those words left to right. */}
          <span dir="rtl" class="min-w-0 flex-1 truncate text-left text-xs text-muted-foreground">
            <bdi dir="ltr">{thinkingPreview(props.text)}</bdi>
          </span>
        </Show>
        {/* Duration and chevron ride the same right edge as a tool row's
            latency and chevron — one `ml-auto` cluster, the row's gap-2. */}
        <span class="ml-auto flex shrink-0 items-center gap-2">
          <Show when={duration()}>
            {(d) => (
              <span class="shrink-0 font-mono text-2xs tabular-nums text-faint-foreground">
                {d()}
              </span>
            )}
          </Show>
          <span
            class="inline-flex shrink-0 text-muted-foreground transition-transform"
            style={{ transform: open() ? "none" : "rotate(-90deg)" }}
          >
            <Icon name="chevron" class="size-3" />
          </span>
        </span>
      </RowButton>
      </div>
      <Show when={open()}>
        {/* The body scrolls with the transcript like every other block; the
            pinned header above is what keeps the collapse at hand. A live
            thought just grows — nothing here fights the scroller's follow. */}
        <div class="expand-in ml-[22px] py-1.5">
          <Md class="text-sm leading-6 text-muted-foreground" text={props.text} />
        </div>
      </Show>
    </div>
  );
}

/**
 * A file in a message: a mention is a word, an attachment is an object.
 *
 * These are two different things and they used to draw as one. An `@file`
 * mention is a reference inside a sentence, so it stays an inline chip that
 * flows with the text. An attachment is something the reader handed over — it
 * carries its own bytes — and drawing it as the same 12px inline chip made it
 * disappear into the bubble: same tint as the bubble behind it, no height to
 * speak of, nothing to say a file had been sent at all. A screenshot got a
 * thumbnail; a PDF got a line of small grey text.
 *
 * The presence of `mime` is what separates them, and that is not a heuristic:
 * the mapper only puts it on a part that arrived as an upload. A workspace
 * mention has a path instead, and a path already says what the file is.
 */
function FileChip(props: {
  path: string;
  range?: { start: number; end: number };
  mime?: string;
  /**
   * The id of an attachment too big to inline.
   *
   * A screenshot past the cap carries this instead of its bytes. Without it the
   * only trace was a filename, and the one thing a screenshot is for — looking
   * at it — was impossible.
   */
  attachment?: string;
}) {
  const name = () => {
    const parts = props.path.split(/[/\\]/);
    return parts[parts.length - 1] || props.path;
  };
  const range = () =>
    props.range ? `${props.range.start}–${props.range.end}` : undefined;
  const extension = () => {
    const dot = name().lastIndexOf(".");
    return dot > 0 ? name().slice(dot + 1).toUpperCase().slice(0, 5) : undefined;
  };
  /** The declared type, without parameters; what a person would call it. */
  const kind = () => {
    const base = props.mime?.split(";")[0]?.trim().toLowerCase();
    if (!base || base === "application/octet-stream") return undefined;
    return base;
  };
  /**
   * Whether this is a picture the reader can actually open.
   *
   * Both halves matter: a mime that says image, and an id to fetch it by. An
   * inline image never reaches here — it becomes an `image` block instead — so
   * this is specifically the too-big-for-the-event case.
   */
  const previewable = () => Boolean(props.attachment) && Boolean(props.mime?.startsWith("image/"));
  const open = () => {
    if (!props.attachment) return;
    // The URL is minted on demand and revoked by the viewer when it closes:
    // the bytes are megabytes, and a page that never lets go of them is a page
    // that grows for as long as the window stays open.
    void attachmentUrl(props.attachment)
      .then((url) => openImage(url, name()))
      .catch((err) => console.error("could not open the attachment:", err));
  };

  return (
    <Show
      when={props.mime}
      fallback={
        // A mention: part of the sentence, so it stays in the line box.
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
      }
    >
      {/* An attachment: its own block, with room for the name to be read. */}
      <span
        class={`my-1.5 flex w-fit max-w-full items-center gap-2.5 rounded-lg border border-border bg-background/60 px-2.5 py-2 ${
          previewable() ? "cursor-pointer hover:bg-secondary/70" : ""
        }`}
        title={`${props.path}\n${props.mime}`}
        role={previewable() ? "button" : undefined}
        tabindex={previewable() ? 0 : undefined}
        onClick={previewable() ? open : undefined}
        onKeyDown={
          previewable()
            ? (e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                open();
              }
            : undefined
        }
      >
        <span class="grid size-8 shrink-0 place-items-center rounded-md bg-event-file/15 text-event-file">
          <Icon name={previewable() ? "eye" : "files"} class="size-4" />
        </span>
        <span class="flex min-w-0 flex-col">
          <span class="truncate text-xs font-medium leading-tight text-foreground">{name()}</span>
          <span class="truncate text-2xs leading-tight text-muted-foreground">
            <Show when={extension()} fallback={kind()}>
              {extension()}
            </Show>
            <Show when={kind()}>
              <span class="text-faint-foreground"> · {kind()}</span>
            </Show>
            <Show when={previewable()}>
              <span class="text-faint-foreground"> · {t("transcript.image.view")}</span>
            </Show>
          </span>
        </span>
      </span>
    </Show>
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
      {(s) => (
        <img
          src={s()}
          alt=""
          role="button"
          tabindex={0}
          aria-label={t("transcript.image.view")}
          draggable={false}
          class="my-2 max-h-80 max-w-full cursor-zoom-in rounded-lg border border-border object-contain"
          onClick={() => openImage(s())}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            openImage(s());
          }}
        />
      )}
    </Show>
  );
}

function TranscriptBlock(props: {
  block: ContentBlock;
  tight?: boolean;
  live?: boolean;
  scope?: string;
  /** Render text exactly as written — no markdown, no HTML parsing. */
  plain?: boolean;
}) {
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
        {(block) => (
          <FileChip
            path={block().path}
            range={block().range}
            mime={block().mime}
            attachment={block().attachment}
          />
        )}
      </Match>
      <Match when={props.block.type === "image" ? props.block : undefined}>
        {(block) => <ImageBlock block={block()} />}
      </Match>
      <Match when={props.block.type === "text" ? props.block : undefined}>
        {(block) =>
          props.plain ? (
            <div class="whitespace-pre-wrap break-words">{block().text}</div>
          ) : (
            <Md class={props.tight ? "md-bubble" : ""} text={block().text} live={props.live} />
          )
        }
      </Match>
      <Match when={props.block.type === "subtask" ? props.block : undefined}>
        {(block) => <SubtaskBlock block={block()} />}
      </Match>
    </Switch>
  );
}

/** The task a subagent session opened with — what it was asked to do, by whom. */
function SubtaskBlock(props: { block: Extract<ContentBlock, { type: "subtask" }> }) {
  return (
    <div class="my-1 rounded-md border border-border bg-card/50 px-3 py-2">
      <p class="flex items-center gap-1.5 text-2xs font-medium text-muted-foreground">
        <Icon name="fork" class="size-3 shrink-0" />
        {props.block.agent
          ? t("message.subtask.named", { agent: props.block.agent })
          : t("message.subtask")}
        {props.block.description ? ` · ${props.block.description}` : ""}
      </p>
      <p class="mt-1 text-sm whitespace-pre-wrap">{props.block.prompt}</p>
    </div>
  );
}

export function BlockText(props: {
  blocks: ContentBlock[];
  tight?: boolean;
  live?: boolean;
  scope?: string;
  /** What the reader typed is shown as typed, never parsed as markdown. */
  plain?: boolean;
}) {
  return (
    <Index each={props.blocks}>
      {(block, index) => (
        <TranscriptBlock
          block={block()}
          tight={props.tight}
          plain={props.plain}
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
 * line and the output beneath it, in one well. The row may truncate, so the
 * well always keeps the complete command available. The copy button prefers
 * the output: the answer is the thing worth keeping, the command only when
 * there is no answer yet.
 */
function ShellWell(props: { call: ToolCallView; command?: string; running: boolean }) {
  const output = () => props.call.output;
  const copy = () => (output() ? stripAnsi(output()!) : (props.command ?? ""));
  return (
    <Show when={props.command || output() || props.running}>
      <div class="group relative overflow-hidden rounded-md border border-border bg-code-surface">
        <Show when={props.command}>
          <p class="whitespace-pre-wrap break-words bg-code-header px-3 py-2.5 pr-16 font-mono text-2xs leading-5 text-foreground/90">
            <span class="mr-2 select-none text-syntax-string">$</span>
            <CodeTokens source={props.command!} label="sh" />
          </p>
        </Show>
        <Show when={output()}>
          <div class={props.command ? "border-t border-border" : undefined}>
            <Code source={output()!} maxHeight="max-h-72" class="rounded-none border-0 bg-transparent pr-16" />
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
  if (line.startsWith("+") && !line.startsWith("+++")) return "text-diff-add-fg";
  if (line.startsWith("-") && !line.startsWith("---")) return "text-diff-del-fg";
  if (line.startsWith("@@")) return "text-syntax-keyword";
  return "text-muted-foreground";
}

/**
 * Tool output. The `break-all` here was doing damage, not wrapping: a long
 * unbroken token would break mid-word and leave fragments like `r|ecognized`
 * stacked down the card. Normal wrapping plus `break-words` breaks only where
 * the line actually overflows, and only at the last chance to do so.
 */
function OutputWell(props: { text: string; kind: ToolKind; danger?: boolean }) {
  const clean = () => stripAnsi(props.text);
  const diff = () => props.kind === "edit" && isDiff(clean());
  return (
    <div class="group relative">
      <Show
        when={diff()}
        fallback={<Code source={clean()} maxHeight="max-h-72" class="pr-16" danger={props.danger} />}
      >
        <pre class="max-h-72 overflow-auto rounded-md border border-border bg-code-surface px-3 py-2 pr-16 font-mono text-xs leading-5">
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
    const c = props.call.input?.command ?? props.call.input?.cmd;
    return typeof c === "string" ? c : undefined;
  };
  /** A pending call is only "running" while the session is. */
  const running = () => props.call.status === "pending" && props.live === true;
  const disclosure = useDisclosure();
  const choice = () => `call:${props.call.call_id}`;
  const [open, setOpen] = createSignal(disclosure.get(choice()) ?? (running() || props.call.status === "error"));
  createEffect(
    on(
      () => props.call.status,
      (status, prev) => {
        if (status === "error" || (status === "pending" && props.live)) setOpen(true);
        else if (prev === "pending" && status === "ok") setOpen(false);
      },
      // The first state is the signal's own: a choice the reader made, or the default.
      { defer: true },
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
  const permission = () => props.call.permission;
  const permissionTone = () => {
    const p = permission();
    if (p?.decision === "deny") return "text-destructive";
    if (p && !p.decision) return "text-event-permission";
    return "text-muted-foreground";
  };
  /* One quiet line, not a card: a transcript can hold a dozen of these in a
     row, and giving each one a border and a fill turned the conversation into
     a stack of chrome. The hanging indent under the icon carries the expanded
     output the way a file tree carries its children. */
  return (
    <div class="-ml-2">
      <Tip label={open() ? t("tool.output.hide") : t("tool.output.show")} class="w-full">
        <ListRow
          class="h-auto py-1.5 text-xs hover:bg-secondary/70 focus-visible:ring-inset"
          expanded={open()}
          onOpen={() => {
            const next = !open();
            disclosure.set(choice(), next);
            setOpen(next);
          }}
        >
          <Icon
            name={toolIcon(props.call.tool, props.call.input)}
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
            <span class="shrink-0 font-mono text-2xs text-faint-foreground tabular-nums">
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
                <OutputWell text={props.call.output!} kind={headline().kind} danger={denied()} />
              </Show>
            }
          >
            <ShellWell call={props.call} command={command()} running={running()} />
          </Show>
          {/* What the tool produced besides its text output — a screenshot,
              a generated file, a fetched page. */}
          <Show when={props.call.attachments?.length}>
            <div class="mt-2 border-t border-border/60 pt-2">
              <BlockText
                blocks={props.call.attachments!}
                scope={`${props.call.call_id}:att`}
              />
            </div>
          </Show>
          {/* The provenance is a footer, not a subtitle: what the tool did is
              the content, and who allowed it is what a reader checks after
              reading the result. No rule line of its own — the well above
              already draws a border, and a second one a few pixels below it
              reads as chrome. The reason stays a separate quiet token rather
              than being dashed onto the sentence: `default` is the policy's
              fallback, not a rule named default. */}
          <Show when={permissionVerdict(permission())}>
            {(verdict) => (
              <div class={cn("flex min-w-0 items-center gap-1.5 text-2xs", permissionTone())}>
                <Icon
                  name={permission()?.decision === "allow" ? "shield-check" : "shield"}
                  class="size-3 shrink-0"
                />
                <span class="shrink-0">{verdict()}</span>
                <Show when={permissionReason(permission())}>
                  {(reason) => (
                    <span class="min-w-0 truncate text-faint-foreground" title={reason()}>
                      · {reason()}
                    </span>
                  )}
                </Show>
              </div>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
}

type AssistantMessageData = Turn["assistant"][number];
type MessageRow = { kind: "message"; id: string; message: AssistantMessageData; index: number };
type ToolsRow = { kind: "tools"; id: string; calls: ToolCallView[] };
type FlowRow = MessageRow | ToolsRow;

/**
 * What a run is, for the reader.
 *
 * A run's place in the list is not its identity: while a turn streams its calls
 * arrive unattributed and draw as one run at the end, and the moment a call is
 * attributed to an earlier message that run is somewhere else entirely. Keyed
 * by its position, the reader's open panel stayed behind with the position and
 * the run was rebuilt closed (measured: 9 of 14 frames).
 *
 * The first call belongs to the run wherever it lands, so it names the run.
 * Prefixed, so a run's id can never read as a message's.
 */
function runKey(calls: readonly ToolCallView[]): string {
  return `run:${calls[0]?.call_id ?? "empty"}`;
}

/** The object the caller asked for with json_schema, drawn as the answer. */
function StructuredAnswer(props: { value: unknown }) {
  return <Code source={JSON.stringify(props.value, null, 2)} class="my-2" />;
}

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
  live?: () => boolean;
  /** The turn is parked on a child session; its provisional close is not an end. */
  waiting?: () => boolean;
  onFork?: (messageId: string) => void;
}) {
  const met = () => goalMetReply(props.message.content);
  const text = () => (met() ? t("goal.met_reply") : messageText(props.message.content));
  const notice = () => assistantNotice(props.message.error);
  const truncated = () => isLengthStop(props.message.stop_reason);
  const stopped = () => isStoppedStop(props.message.stop_reason);
  // A cut-off mark is provisional until two things have passed: the session
  // being live (the real completed final may still be in flight), and a beat
  // after idle for that final to replace the provisional close. Showing it
  // before then is a warning that appears and vanishes.
  const [cutOff, setCutOff] = createSignal(false);
  const confirmInterruption = createDebouncer(1500);
  createEffect(() => {
    // A cut-off mark waits for the child when the turn is parked on one: the
    // adapter's interrupted final is provisional there, and the real
    // completion replaces it the moment the child reports back.
    const paused = replyInterrupted(props.message) && props.waiting?.() === true;
    if ((!replyInterrupted(props.message) && !stopped()) || props.live?.() === true || paused) {
      confirmInterruption.cancel();
      setCutOff(false);
      return;
    }
    confirmInterruption.schedule(() => setCutOff(true));
  });
  onCleanup(() => confirmInterruption.cancel());
  const empty = () => silentEmptyReply(props.message);
  const forkable = () => Boolean(props.onFork && props.message.msg_id);
  const hasFooter = () => !met() && text().trim() !== "";
  return (
    <Show
      when={
        hasMessageContent(props.message.content) ||
        notice() ||
        truncated() ||
        cutOff() ||
        empty() ||
        props.message.structured !== undefined
      }
    >
      <MessageMenu
        text={text}
        onFork={forkable() ? () => props.onFork!(props.message.msg_id!) : undefined}
      >
      {/* `py-0.5` carries the beat between this paragraph and the tool row that
          follows it: `space-y-1` margins cannot reach through MessageMenu's
          `display:contents` wrapper, so the gap lives on the row itself. */}
      <div class="transcript-message py-0.5" data-message-role="assistant">
        <div class="relative">
          {/* The compaction summary arrives as an ordinary assistant message —
             the label is what keeps "everything before this was summarised"
             from reading as just another reply. */}
          <Show when={props.message.summary === true}>
            <p class="mb-1 flex items-center gap-1.5 text-2xs text-muted-foreground">
              <Icon name="archive" class="size-3 shrink-0" />
              {t("message.summary_label")}
            </p>
          </Show>
          <Show
            when={met()}
            fallback={
              <BlockText
                blocks={props.message.content}
                live={props.message.partial}
                scope={props.message.msg_id ?? `${props.turnId}:m${props.index}`}
              />
            }
          >
            <TranscriptDivider icon="check">{t("goal.met_reply")}</TranscriptDivider>
          </Show>
          {/* The caller asked for json_schema — this object IS the answer, and
              the text beside it is usually preamble. */}
          <Show when={props.message.structured !== undefined}>
            <StructuredAnswer value={props.message.structured} />
          </Show>
          <Show when={truncated()}>
            <p role="status" class="mt-2 flex items-start gap-1.5 text-xs text-event-permission">
              <span class="flex h-[1lh] shrink-0 items-center">
                <Icon name="alert" class="size-3" />
              </span>
              <span>{t("message.truncated")}</span>
            </p>
          </Show>
          <Show when={cutOff()}>
            <p role="status" class="mt-2 flex items-start gap-1.5 text-xs text-event-permission">
              <span class="flex h-[1lh] shrink-0 items-center">
                <Icon name="alert" class="size-3" />
              </span>
              <span>{stopped() ? t("message.stopped") : t("message.interrupted")}</span>
            </p>
          </Show>
          <Show when={empty()}>
            <p role="status" class="mt-2 flex items-start gap-1.5 text-xs text-event-permission">
              <span class="flex h-[1lh] shrink-0 items-center">
                <Icon name="alert" class="size-3" />
              </span>
              <span>{t("message.empty")}</span>
            </p>
          </Show>
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
                class="mt-1 flex items-start gap-1.5 whitespace-pre-wrap break-words rounded-md border border-destructive/25 bg-destructive/6 px-3 py-2 text-xs text-destructive"
              >
                <span class="flex h-[1lh] shrink-0 items-center">
                  <Icon name="alert" class="size-3" />
                </span>
                <span class="min-w-0 flex-1 whitespace-pre-wrap break-words">{n().text}</span>
              </p>
            )}
          </Show>
        </div>
        <Show when={props.footer && hasFooter()}>
          <MessageActions
            text={text()}
            align="start"
            details={props.message}
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
  /** Stable identity of this run, so the reader's choice outlives the row. */
  runId?: string;
  calls: ToolCallView[];
  /** The session is running — a `pending` call is live work, not an orphan. */
  live?: boolean;
  childOf?: (id: string) => ChildSession | undefined;
  onOpenChild?: (id: string) => void;
}) {
  // Whether this run has outgrown the text it serves. A count, not a state: it
  // only ever grows, so the header is mounted once and stays put.
  //
  // It used to also require every call to be settled, and that is what made the
  // wrench rows strobe — a call arriving pending took the header away and the
  // call finishing put it back, once per call. Measured on a run of four: five
  // distinct header buttons and four disappearances.
  const many = () => props.calls.length > 3;
  const settled = () =>
    props.calls.every((c) => c.status === "ok" && c.permission?.decision !== "deny");
  // Folded by default only once there is nothing left to watch. A call that is
  // still running, or one that ended badly, is the reason the reader is here.
  const folded = () => many() && settled();
  const disclosure = useDisclosure();
  const [open, setOpen] = createSignal(
    (props.runId === undefined ? undefined : disclosure.get(props.runId)) ?? !folded(),
  );
  const toggle = () => {
    const next = !open();
    if (props.runId !== undefined) disclosure.set(props.runId, next);
    setOpen(next);
  };
  // A run animates only while a call is still `pending` AND the session is
  // live — `pending` alone is just "no result yet", which an orphaned call
  // keeps saying forever.
  const live = () => props.live === true && props.calls.some((c) => c.status === "pending");
  // The dim-in marks a run that started working — once. Latching it off the
  // first time the run falls quiet is what keeps a run that goes pending,
  // settled, pending… from replaying the animation on every call.
  const [watching, setWatching] = createSignal(live());
  createEffect(() => {
    if (!live()) setWatching(false);
  });
  const showLive = () => watching() && live();
  return (
    <div class={`space-y-1 ${showLive() ? "tool-live-in" : ""}`}>
      <Show when={many()}>
        <RowButton
          class="-ml-2 text-xs focus-visible:ring-inset"
          aria-expanded={open()}
          onClick={toggle}
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
        <div class={`expand-in ${many() ? "ml-[22px] " : ""}space-y-1`}>
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
   * Which slice of the turn this block renders, when the turn is mounted in
   * segments. Absent means the whole turn, as before.
   */
  part?: TurnPart;
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
  const firstPart = () => props.part === undefined || props.part.part === 0;
  const lastPart = () => props.part === undefined || props.part.last;
  const flow = createMemo(() => {
    const msgs = props.turn.assistant;
    // Attribution is a property of the turn, not of a segment of it: a call's
    // msg_id names an absolute message index. It is built once per turn and
    // shared by the turn's segments, so each one emits only its own slice and
    // the loose calls land in the part that ends the turn.
    const { byMessage, loose } = attributionOf(props.turn);
    const rows: FlowRow[] = [];
    const from = props.part?.msgFrom ?? 0;
    const to = props.part?.msgTo ?? msgs.length;
    for (let i = from; i < to; i++) {
      rows.push({ kind: "message", id: `m${i}`, message: msgs[i]!, index: i });
      const mine = byMessage.get(i);
      if (mine?.length) rows.push({ kind: "tools", id: runKey(mine), calls: mine });
    }
    if (loose.length && lastPart()) rows.push({ kind: "tools", id: runKey(loose), calls: loose });
    return rows;
  });
  /** Parked on a child session: the reply is paused, not cut off. */
  const waitingChild = () => waitingOnChild(props.turn.tool_calls);
  const flowIds = createMemo<readonly string[]>((prev) => stableKeys(prev, flow().map((row) => row.id)));
  const byId = createMemo(() => new Map(flow().map((row) => [row.id, row] as const)));

  return (
    <div
      class={`${firstPart() && props.entering?.() ? "rise-in " : ""}space-y-1 ${props.part && props.part.part > 0 ? "pt-1 " : ""}${
        props.turn.reverted ? "opacity-50" : ""
      }`}
    >
      <Show when={firstPart() ? props.turn.user : undefined}>
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
              <BlockText blocks={blocks()} tight plain />
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
      <For each={flowIds()}>
        {(id) => {
          // `For` drops a row in the same update that removed its id, and
          // whatever inside reads the row before then gets the last one it had.
          const row = createMemo<FlowRow>((prev) => byId().get(id) ?? prev!);
          // An id names one kind for life — `m${i}` a message, `run:` a run —
          // so the row picks its component once.
          if (row().kind === "message") {
            const message = () => row() as MessageRow;
            return (
              <AssistantMessage
                turnId={props.turn.turn_id}
                index={message().index}
                message={message().message}
                footer={lastPart() && id === flowIds().at(-1)}
                live={props.live}
                waiting={waitingChild}
                onFork={props.onFork}
              />
            );
          }
          const run = () => row() as ToolsRow;
          return (
            <ToolRun
              runId={`${props.turn.turn_id}:${id}`}
              calls={run().calls}
              live={props.live?.()}
              childOf={props.childOf}
              onOpenChild={props.onOpenChild}
            />
          );
        }}
      </For>
      <Show when={lastPart() && props.awaiting?.()}>
        <div class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Icon name="brain" class="size-3.5 shrink-0 text-status-active motion-safe:animate-pulse" />
          {t("transcript.thinking")}
        </div>
      </Show>
      <Show when={lastPart() ? props.turn.compaction : undefined}>
        {(c) => (
          <TranscriptDivider icon="archive">
            {[
              t("message.compacted"),
              c().auto === true
                ? t("message.compacted.auto")
                : c().auto === false
                  ? t("message.compacted.manual")
                  : undefined,
              c().overflow === true ? t("message.compacted.overflow") : undefined,
            ]
              .filter((s): s is string => s !== undefined)
              .join(" · ")}
          </TranscriptDivider>
        )}
      </Show>
    </div>
  );
}
