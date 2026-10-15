import { Show, type JSX } from "solid-js";
import { Icon, type Name } from "@/icons";
import { cn } from "@/lib/utils";

/**
 * The one way this app says "there is nothing here yet" or "that did not work".
 *
 * Before this existed every empty branch wrote its own paragraph: a session with
 * no turns printed one muted line at `pt-16`, a failed service connection
 * printed another at `px-8 pt-24` next to a hand-styled button, and a stalled
 * transcript printed a third. None of them had an icon, a hierarchy, or a
 * shared position, so the app looked unfinished in three slightly different
 * ways depending on which screen you landed on. A viewer cannot tell a designed
 * empty state from an unfinished one, which is most of why the shell read as
 * provisional.
 *
 * The shape is fixed — icon, title, optional description, optional action,
 * centred as a column — so the three states now differ only in tone and copy.
 */
export function EmptyState(props: {
  icon?: Name;
  title: string;
  description?: string;
  /** `danger` tints the icon and title for a failure rather than a blank slate. */
  tone?: "neutral" | "danger";
  action?: JSX.Element;
  /** `panel` centres inside the available space; `inline` hugs the top-left. */
  layout?: "panel" | "inline";
  class?: string;
}) {
  const tone = () => props.tone ?? "neutral";
  return (
    <div
      class={cn(
        "flex flex-col items-center gap-2 px-8 py-16 text-center",
        props.layout === "inline" && "items-start px-0 py-0 text-left",
        props.class,
      )}
      role="status"
      aria-live="polite"
    >
      <Show when={props.icon}>
        {(name) => (
          <span
            class={cn(
              "mb-1 grid size-9 shrink-0 place-items-center rounded-full",
              tone() === "danger"
                ? "bg-destructive/10 text-destructive"
                : "bg-secondary/70 text-muted-foreground",
            )}
          >
            <Icon name={name()} class="size-4" />
          </span>
        )}
      </Show>
      <p
        class={cn(
          "text-sm",
          tone() === "danger" ? "text-destructive" : "text-foreground",
        )}
      >
        {props.title}
      </p>
      <Show when={props.description}>
        <p class="max-w-sm text-xs leading-relaxed text-muted-foreground">
          {props.description}
        </p>
      </Show>
      <Show when={props.action}>
        <div class="mt-2">{props.action}</div>
      </Show>
    </div>
  );
}
