import type { JSX } from "solid-js";
import { cn } from "@/lib/utils";

/**
 * The shell every clickable list row in the app shares — session list, search
 * hits, provider rows, policy entries.
 *
 * It is a `div[role=button]` rather than a `<button>` on purpose: rows contain
 * their own interactive children (an inline rename field, a per-row menu), and
 * nesting those inside a real button is invalid HTML and breaks focus order.
 *
 * That choice used to be paid for at every call site. Each row re-implemented
 * the keyboard contract on its own, and most got it half right — the session
 * row answered Enter but not Space, none of them drew a focus ring, and a
 * keyboard user tabbing the sidebar had no idea where they were. This owns the
 * contract once: Enter and Space activate, Escape and Tab do not, the focus
 * ring matches `Button`, and an `active` row is marked `aria-current` so the
 * selection is announced rather than only painted.
 */
export function ListRow(props: {
  active?: boolean;
  /** A disclosure row announces whether it is open. Omitted on a row that only navigates. */
  expanded?: boolean;
  onOpen: () => void;
  /** True while an inline editor owns the row; it must not also activate it. */
  disabled?: boolean;
  /** Extra handling for keys the row does not claim (e.g. Delete). */
  onKeyDown?: JSX.EventHandler<HTMLDivElement, KeyboardEvent>;
  /** Rows that reveal actions on hover pass these; the row owns nothing here. */
  onMouseEnter?: JSX.EventHandler<HTMLDivElement, MouseEvent>;
  onMouseLeave?: JSX.EventHandler<HTMLDivElement, MouseEvent>;
  class?: string;
  children: JSX.Element;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={props.active ? "true" : undefined}
      aria-expanded={props.expanded}
      class={cn(
        "relative flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left",
        "transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        props.active
          ? "bg-accent text-foreground"
          : "text-foreground/80 hover:bg-secondary/70",
        props.class,
      )}
      onClick={(e) => {
        if (props.disabled) return;
        const target = e.target as HTMLElement | null;
        if (target?.closest?.("[data-row-menu]")) return;
        props.onOpen();
      }}
      onMouseEnter={props.onMouseEnter}
      onMouseLeave={props.onMouseLeave}
      onKeyDown={(e) => {
        if (e.key === "Escape") return;
        if (props.disabled) return;
        if (e.key === "Enter") {
          e.preventDefault();
          props.onOpen();
          return;
        }
        // Space scrolls the page by default. A row that ignores that detail
        // jumps the transcript while the keyboard user is trying to open it.
        if (e.key === " ") {
          e.preventDefault();
          props.onOpen();
          return;
        }
        props.onKeyDown?.(e);
      }}
    >
      {props.children}
    </div>
  );
}
