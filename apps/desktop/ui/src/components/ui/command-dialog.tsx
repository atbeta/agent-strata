import { Show, type JSX } from "solid-js";
import { cn } from "@/lib/utils";

export function CommandDialog(props: {
  open: boolean;
  label: string;
  onClose: () => void;
  class?: string;
  children: JSX.Element;
}) {
  return (
    <Show when={props.open}>
      <div
        class="fade-in fixed inset-0 z-50 flex items-start justify-center bg-background/60 px-4 pt-[15vh] backdrop-blur-[2px]"
        onMouseDown={props.onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={props.label}
          class={cn(
            "dialog-pop surface-dialog w-[32rem] max-w-full overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground",
            props.class,
          )}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {props.children}
        </div>
      </div>
    </Show>
  );
}
