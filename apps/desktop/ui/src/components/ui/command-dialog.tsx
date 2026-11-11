import { type JSX } from "solid-js";
import { Dialog as DialogPrimitive } from "@kobalte/core/dialog";
import { cn } from "@/lib/utils";
import { shellPlatform } from "@/shell";

export { DialogPrimitive };

export function CommandDialog(props: {
  open: boolean;
  label: string;
  onClose: () => void;
  class?: string;
  children: JSX.Element;
}) {
  let returnFocus: HTMLElement | undefined;

  return (
    <DialogPrimitive
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          class={cn(
            "fade-in fixed inset-0 z-50 flex items-start justify-center bg-background/60 px-4 pt-[15vh]",
            shellPlatform() !== "windows" && "backdrop-blur-[2px]",
          )}
        >
          <DialogPrimitive.Content
            aria-label={props.label}
            class={cn(
              "dialog-pop surface-dialog w-[32rem] max-w-full overflow-hidden rounded-xl bg-popover text-popover-foreground",
              props.class,
            )}
            onOpenAutoFocus={() => {
              const el = document.activeElement;
              returnFocus = el instanceof HTMLElement && el.matches(":focus-visible") ? el : undefined;
            }}
            onCloseAutoFocus={() => {
              if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
              returnFocus = undefined;
            }}
          >
            {props.children}
          </DialogPrimitive.Content>
        </DialogPrimitive.Overlay>
      </DialogPrimitive.Portal>
    </DialogPrimitive>
  );
}
