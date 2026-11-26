import { Dialog as DialogPrimitive } from "@kobalte/core/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { shellPlatform } from "@/shell";

/**
 * A decision that destroys something the reader cannot get back from this screen.
 *
 * Restarting a plugin, compacting the database, and applying a clean the reader
 * has already previewed stay on the button: those are recoverable, or the
 * preview is the confirmation. This dialog is for the rest — a schedule, a
 * skill's files, a session, a backup — where a second click on a small control
 * is too easy to miss.
 */
export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  let cancelEl: HTMLButtonElement | undefined;

  return (
    <DialogPrimitive
      open={props.open}
      onOpenChange={(open) => {
        if (!open && !props.pending) props.onCancel();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          class={cn(
            "fade-in fixed inset-0 z-[60] flex items-center justify-center bg-background/60 px-4",
            shellPlatform() !== "windows" && "backdrop-blur-[2px]",
          )}
        >
          <DialogPrimitive.Content
            aria-label={props.title}
            class="dialog-pop surface-dialog w-[26rem] max-w-full rounded-xl bg-popover p-5 text-popover-foreground"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              cancelEl?.focus();
            }}
          >
            <DialogPrimitive.Title class="text-base font-semibold text-foreground">
              {props.title}
            </DialogPrimitive.Title>
            <DialogPrimitive.Description class="mt-2 text-sm leading-6 text-muted-foreground">
              {props.description}
            </DialogPrimitive.Description>
            <div class="mt-5 flex justify-end gap-2">
              <Button
                ref={(el: HTMLButtonElement) => {
                  cancelEl = el;
                }}
                type="button"
                size="sm"
                variant="outline"
                disabled={props.pending}
                onClick={() => props.onCancel()}
              >
                {props.cancelLabel}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={props.pending}
                onClick={() => props.onConfirm()}
              >
                {props.confirmLabel}
              </Button>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Overlay>
      </DialogPrimitive.Portal>
    </DialogPrimitive>
  );
}
