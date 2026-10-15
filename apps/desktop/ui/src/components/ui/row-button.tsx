import { splitProps, type JSX } from "solid-js";
import { cn } from "@/lib/utils";

type RowButtonProps = Omit<
  JSX.ButtonHTMLAttributes<HTMLButtonElement>,
  "class" | "children" | "onClick"
> & {
  onClick: () => void;
  /** Lists that track a cursor on hover need the row to report it. */
  onMouseEnter?: JSX.EventHandler<HTMLButtonElement, MouseEvent>;
  /** Marks the row under the keyboard cursor; search results style on this. */
  active?: boolean;
  class?: string;
  children: JSX.Element;
};

/**
 * A full-width row in a clickable list — a search hit, a session in the
 * overview, a provider, a file.
 *
 * `Button` is fixed-height and centred, which is right for a control in a
 * toolbar and wrong for a row that fills a column. These rows size to their
 * content, align left, and each of the nine call sites was re-stating that
 * with the same classes and its own padding guess.
 *
 * Unlike `ListRow` this stays a native `<button>`: a row here holds no nested
 * control — no inline rename field, no per-row menu — so there is nothing to
 * nest invalidly inside a button, and it gets Enter, Space, and the form
 * semantics for free. Reach for `ListRow` when the row does hold its own
 * controls; reach for this when it is a single action.
 *
 * Anything else a row needs — `aria-expanded` on a tree item, an indent style
 * on a file path — passes straight through.
 */
export function RowButton(raw: RowButtonProps) {
  const [local, rest] = splitProps(raw, [
    "onClick",
    "onMouseEnter",
    "active",
    "class",
    "children",
  ]);
  return (
    <button
      type="button"
      data-at={local.active ? "true" : "false"}
      class={cn(
        "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
        "text-foreground/80 transition-colors hover:bg-secondary/60 hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        local.class,
      )}
      onMouseEnter={local.onMouseEnter}
      onClick={local.onClick}
      {...rest}
    >
      {local.children}
    </button>
  );
}
