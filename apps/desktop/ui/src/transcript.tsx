import { createEffect, createSignal, For, Index, Match, on, Show, Switch } from "solid-js";
import type { ContentBlock, ToolCallView, Turn } from "./api";
import { Icon } from "./icons";
import { Md } from "./md";
import { stripAnsi } from "./ansi";
import { Code } from "./payload";
import {
  diffStat,
  fmtLatency,
  isDiff,
  permissionLabel,
  statusLabel,
  thinkingPreview,
  todoItems,
  toolHeadline,
  type ToolKind,
} from "./transcript-format";

function ThinkingBlock(props: { text: string; live?: boolean }) {
  const [open, setOpen] = createSignal(props.live === true);
  createEffect(
    on(
      () => props.live,
      (live, prev) => {
        if (live) setOpen(true);
        else if (prev) setOpen(false);
      },
    ),
  );
  return (
    <div class="my-2">
      <button
        class="flex max-w-full items-center gap-1.5 text-left text-sm text-muted-foreground hover:text-foreground"
        aria-expanded={open()}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="spark" class={`size-3.5 shrink-0 ${props.live ? "animate-pulse text-event-assistant" : ""}`} />
        <span class="shrink-0 font-medium">{props.live ? "Thinking" : "Thought"}</span>
        <Show when={!open() && thinkingPreview(props.text)}>
          <span class="min-w-0 truncate font-normal">{thinkingPreview(props.text)}</span>
        </Show>
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
    <Show when={src()} fallback={<p class="my-1 text-xs text-muted-foreground">image</p>}>
      <img
        src={src()}
        alt=""
        class="my-2 max-h-80 max-w-full rounded-lg border border-border object-contain"
      />
    </Show>
  );
}

function TranscriptBlock(props: { block: ContentBlock; tight?: boolean; live?: boolean }) {
  return (
    <Switch>
      <Match when={props.block.type === "thinking" ? props.block : undefined}>
        {(block) => <ThinkingBlock text={block().text} live={props.live} />}
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

export function BlockText(props: { blocks: ContentBlock[]; tight?: boolean; live?: boolean }) {
  return (
    <Index each={props.blocks}>
      {(block, index) => (
        <TranscriptBlock
          block={block()}
          tight={props.tight}
          live={props.live === true && index === props.blocks.length - 1}
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

function ToolCallCard(props: { call: ToolCallView }) {
  const headline = () => toolHeadline(props.call);
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
    if (props.call.permission?.decision === "deny") return "Denied";
    if (props.call.permission && !props.call.permission.decision) return "Needs permission";
    return statusLabel(props.call.status);
  };
  return (
    <div class={`overflow-hidden rounded-lg border bg-card ${denied() ? "border-destructive/35" : "border-border"}`}>
      <button
        class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-secondary/50"
        aria-expanded={open()}
        title={open() ? "Hide output" : "Show output"}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon
          name={toolIcon(headline().kind)}
          class={`size-3.5 shrink-0 ${denied() ? "text-destructive" : "text-event-tool"}`}
        />
        <span class={`shrink-0 text-2xs font-medium ${denied() ? "text-destructive" : "text-muted-foreground"}`}>
          {headline().verb}
        </span>
        <span class="min-w-0 flex-1 truncate font-mono text-xs text-foreground/90" title={headline().title}>
          {headline().title}
        </span>
        <Show when={stat()}>
          {(s) => (
            <span class="shrink-0 font-mono text-2xs tabular-nums">
              <span class="text-status-active">+{s().add}</span>{" "}
              <span class="text-destructive">−{s().del}</span>
            </span>
          )}
        </Show>
        <Show when={label()}>
          <span
            class={`shrink-0 text-2xs ${
              props.call.status === "pending"
                ? "text-status-active"
                : denied()
                  ? "text-destructive"
                  : "text-muted-foreground"
            }`}
          >
            <Show when={props.call.status === "pending"}>
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
        <span
          class="inline-flex shrink-0 text-muted-foreground transition-transform"
          style={{ transform: open() ? "none" : "rotate(-90deg)" }}
        >
          <Icon name="chevron" class="size-3" />
        </span>
      </button>
      <Show when={open()}>
        <div class="space-y-2 border-t border-border px-2.5 py-2">
          <Show when={permissionLabel(props.call.permission)}>
            <p class="text-2xs text-event-permission">{permissionLabel(props.call.permission)}</p>
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
              <p class="text-xs text-muted-foreground">Running…</p>
            </Show>
          }>
            <OutputWell text={props.call.output!} kind={headline().kind} />
          </Show>
        </div>
      </Show>
    </div>
  );
}

export function TurnBlock(props: { turn: Turn }) {
  return (
    <div class="space-y-3">
      <Show when={props.turn.user}>
        {(blocks) => (
          <div class="flex justify-end">
            <div class="max-w-[min(85%,36rem)] rounded-2xl rounded-br-md bg-secondary px-3.5 py-2 text-secondary-foreground">
              <BlockText blocks={blocks()} tight />
            </div>
          </div>
        )}
      </Show>
      <Index each={props.turn.assistant}>
        {(message) => (
          <div class="max-w-3xl">
            <div class="relative">
              <BlockText blocks={message().content} live={message().partial} />
              <Show when={message().partial && message().content.some((block) => block.type === "text")}>
                <span class="ml-0.5 inline-block h-[1em] w-[2px] translate-y-0.5 animate-pulse bg-foreground/70 align-text-bottom" />
              </Show>
            </div>
          </div>
        )}
      </Index>
      <Show when={props.turn.tool_calls.length > 0}>
        <div class="max-w-3xl space-y-1.5">
          <Index each={props.turn.tool_calls}>{(call) => <ToolCallCard call={call()} />}</Index>
        </div>
      </Show>
    </div>
  );
}
