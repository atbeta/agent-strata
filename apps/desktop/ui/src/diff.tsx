import { For } from "solid-js";
import { parsePatch } from "./patch";

/**
 * One change, shown as its own diff. A file changed several times reads as a
 * run of these in the order it happened, rather than one merged diff that would
 * claim to be a single edit the agent never made.
 *
 * The block never scrolls itself. A file with fifty changes would otherwise put
 * fifty scrollbars in one column; the pane around them scrolls once instead,
 * which is also how the pane decides how wide the widest line is.
 */
export function DiffBlock(props: { patch: string }) {
  const rows = () => parsePatch(props.patch);
  return (
    <pre class="w-max py-1 font-mono text-2xs leading-relaxed">
      <code>
        <For each={rows()}>
          {(row) => (
            <span
              class={
                row.kind === "add"
                  ? "block bg-diff-add-bg text-diff-add-fg"
                  : row.kind === "del"
                    ? "block bg-diff-del-bg text-diff-del-fg"
                    : "block text-muted-foreground"
              }
            >
              {row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "}
              {row.text || " "}
            </span>
          )}
        </For>
      </code>
    </pre>
  );
}