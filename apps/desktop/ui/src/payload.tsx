import { createMemo, createSignal, For, Show } from "solid-js";
import { stripAnsi } from "./ansi";
import { grammarFor, guessGrammar, tokenize, tokenizeDiff } from "./highlight";
import { asStructure, looksStructured } from "./structure";
import { JsonView } from "./json-view";

/**
 * A framed block for a tool payload. Structure renders as a tree, text renders
 * as highlighted mono, and terminal escapes are gone before either sees it.
 */

function CopyButton(props: { text: string }) {
  const [done, setDone] = createSignal(false);
  return (
    <button
      type="button"
      class="rounded px-1.5 py-0.5 text-2xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(props.text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          // Clipboard is unavailable in some webview contexts; nothing to do.
        }
      }}
    >
      {done() ? "已复制" : "复制"}
    </button>
  );
}

function Code(props: { source: string; label?: string; maxHeight?: string; class?: string }) {
  const text = createMemo(() => stripAnsi(props.source));
  const tokens = createMemo(() => {
    const src = text();
    const diff = tokenizeDiff(src);
    if (diff) return diff;
    const grammar = grammarFor(props.label) ?? guessGrammar(src);
    return tokenize(src, grammar);
  });

  return (
    <pre
      class={`group overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-secondary/40 p-2.5 font-mono text-2xs leading-5 text-foreground/85 ${
        props.class ?? ""
      } ${props.maxHeight ?? "max-h-96"}`}
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
      fallback={<p class="text-xs text-muted-foreground">{props.empty ?? "无"}</p>}
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