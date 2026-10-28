import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { copyText } from "./clipboard";
import { stripAnsi } from "./ansi";
import { grammarFor, guessGrammar, tokenize, tokenizeDiff } from "./highlight";
import { asStructure, looksStructured } from "./structure";
import { JsonView } from "./json-view";
import { t } from "./i18n";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { enqueuePaint } from "./paint-queue";
import { useRowPaintMode } from "./paint-mode";

/**
 * A framed block for a tool payload. Structure renders as a tree, text renders
 * as highlighted mono, and terminal escapes are gone before either sees it.
 */

function CopyButton(props: { text: string }) {
  const [done, setDone] = createSignal(false);
  return (
    <Button
      type="button"
      variant="icon"
      size="xs"
      // Hidden until the block is hovered or the button itself is focused —
      // a keyboard user tabbing in must be able to see where they landed.
      class="rounded px-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      onClick={async () => {
        if (await copyText(props.text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        }
      }}
    >
      {done() ? t("payload.copied") : t("payload.copy")}
    </Button>
  );
}

function Code(props: { source: string; label?: string; maxHeight?: string; class?: string }) {
  // Highlighting runs when the row is on screen. An off-screen code block
  // tokenizes on a later frame, same as markdown, so a scroll that mounts a
  // window of tool output does not colour all of it before the next paint.
  const mode = useRowPaintMode();
  const [shown, setShown] = createSignal(mode() === "now");
  createEffect(() => {
    if (shown()) return;
    if (mode() === "now") {
      setShown(true);
      return;
    }
    onCleanup(enqueuePaint(() => setShown(true)));
  });
  const tokens = createMemo(() => {
    if (!shown()) return [];
    const src = stripAnsi(props.source);
    const diff = tokenizeDiff(src);
    if (diff) return diff;
    const grammar = grammarFor(props.label) ?? guessGrammar(src);
    return tokenize(src, grammar);
  });

  return (
    <pre
      class={cn(
        "group overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-secondary/40 p-2.5 font-mono text-2xs leading-5 text-foreground/85",
        props.class,
        props.maxHeight ?? "max-h-96",
      )}
    >
      <code>
        <For each={tokens()}>
          {(t) => (
            <Show when={t.kind !== "plain"} fallback={t.text}>
              <span class={`tok-${t.kind}`}>{t.text}</span>
            </Show>
          )}
        </For>
      </code>
    </pre>
  );
}

/**
 * Render whatever a tool call carried. `input` and `result` reach the UI as raw
 * event data, so the shape is decided here rather than upstream: anything that
 * parses as a JSON object or array becomes a tree, everything else stays text.
 */
export function Payload(props: {
  value: unknown;
  label?: string;
  maxHeight?: string;
  empty?: string;
}) {
  const structured = createMemo(() => looksStructured(props.value));
  const parsed = createMemo(() => (structured() ? asStructure(props.value) : undefined));

  return (
    <Show
      when={props.value !== undefined && props.value !== null && props.value !== ""}
      fallback={<p class="text-xs text-muted-foreground">{props.empty ?? t("payload.empty")}</p>}
    >
      <Show
        when={structured()}
        fallback={
          <Code
            source={String(props.value)}
            label={props.label}
            maxHeight={props.maxHeight}
          />
        }
      >
        <div
          class={`overflow-auto rounded-md border border-border bg-secondary/40 p-1.5 ${
            props.maxHeight ?? "max-h-96"
          }`}
        >
          <JsonView value={parsed()} />
        </div>
      </Show>
    </Show>
  );
}

export { Code, CopyButton };