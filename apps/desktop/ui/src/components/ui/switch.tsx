import { splitProps } from "solid-js";
import { Switch as SwitchPrimitive } from "@kobalte/core/switch";
import type { SwitchRootProps } from "@kobalte/core/switch";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import { cn } from "@/lib/utils";

type SwitchProps = PolymorphicProps<"button", SwitchRootProps<"button">> & { class?: string };

/**
 * An on/off control, deliberately not shaped like the two-button rows it sits
 * beside: a setting with only two states should not read as a choice between
 * two named options.
 *
 * The thumb is driven from the root's `data-checked` rather than from the
 * primitive's thumb, so it moves however the state gets there.
 */
function Switch(props: SwitchProps) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <SwitchPrimitive
      class={cn(
        "group inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border border-border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-40 data-[checked]:border-ring data-[checked]:bg-ring",
        local.class,
      )}
      {...rest}
    >
      <SwitchPrimitive.Thumb class="pointer-events-none block size-3 translate-x-[2px] rounded-full bg-muted-foreground transition-transform group-data-[checked]:translate-x-[15px] group-data-[checked]:bg-background" />
    </SwitchPrimitive>
  );
}

export { Switch };
export type { SwitchProps };