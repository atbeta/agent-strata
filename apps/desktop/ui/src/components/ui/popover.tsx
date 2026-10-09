import { splitProps } from "solid-js";
import { Popover as PopoverPrimitive } from "@kobalte/core/popover";
import type {
  PopoverContentProps,
  PopoverTriggerProps,
} from "@kobalte/core/popover";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import { cn } from "@/lib/utils";

const Popover = PopoverPrimitive;

type TriggerProps = PolymorphicProps<"button", PopoverTriggerProps<"button">> & {
  class?: string;
};

function PopoverTrigger(props: TriggerProps) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <PopoverPrimitive.Trigger
      class={cn(
        "inline-flex items-center justify-center rounded-md text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
        local.class,
      )}
      {...rest}
    />
  );
}

type ContentProps = PolymorphicProps<"div", PopoverContentProps<"div">> & { class?: string };

function PopoverContent(props: ContentProps) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        class={cn(
          "surface-popover z-50 overflow-hidden rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-[0_12px_40px_-20px_rgba(0,0,0,0.6)]",
          local.class,
        )}
        {...rest}
      />
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverContent };