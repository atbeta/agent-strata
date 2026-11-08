import { splitProps } from "solid-js";
import { Popover as PopoverPrimitive } from "@kobalte/core/popover";
import type {
  PopoverContentProps,
  PopoverTriggerProps,
} from "@kobalte/core/popover";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import { cn } from "@/lib/utils";
import { buttonVariants, type ButtonProps } from "./button";

const Popover = PopoverPrimitive;

type TriggerProps = PolymorphicProps<"button", PopoverTriggerProps<"button">> & {
  class?: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
};

function PopoverTrigger(props: TriggerProps) {
  const [local, rest] = splitProps(props, ["class", "variant", "size"]);
  return (
    <PopoverPrimitive.Trigger
      class={cn(
        "inline-flex items-center justify-center rounded-md text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
        (local.variant || local.size) && buttonVariants({ variant: local.variant, size: local.size }),
        local.class,
      )}
      {...rest}
    />
  );
}

type ContentProps = PolymorphicProps<"div", PopoverContentProps<"div">> & { class?: string };

function PopoverContent(props: ContentProps) {
  const [local, rest] = splitProps(props, ["class", "onOpenAutoFocus"]);
  let content: HTMLDivElement | undefined;
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={(el) => (content = el)}
        class={cn(
          "surface-popover menu-pop z-50 overflow-hidden rounded-lg bg-popover p-4 text-popover-foreground",
          // The panel takes focus on open, not its first control.
          "focus:outline-none",
          local.class,
        )}
        {...rest}
        onOpenAutoFocus={(event) => {
          local.onOpenAutoFocus?.(event);
          if (event.defaultPrevented) return;
          /* Kobalte focuses the first tabbable inside the panel. In a panel
             whose only control is a copy row, that paints a focus ring around
             16px of text the instant the popover opens — it reads as a stray
             outline, and it puts keyboard activation one Enter away from
             something nobody navigated to. Focus the dialog itself: it is
             already `tabindex="-1"`, so Escape works, and the first Tab still
             reaches the copy row, whose ring then means what a ring means. */
          event.preventDefault();
          content?.focus({ preventScroll: true });
        }}
      />
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverContent };