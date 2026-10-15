import { splitProps } from "solid-js";
import { ContextMenu as ContextMenuPrimitive } from "@kobalte/core/context-menu";
import type {
  ContextMenuContentProps,
  ContextMenuGroupLabelProps,
  ContextMenuItemProps,
  ContextMenuSeparatorProps,
  ContextMenuTriggerProps,
} from "@kobalte/core/context-menu";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import { cn } from "@/lib/utils";

const ContextMenu = ContextMenuPrimitive;

type TriggerProps = PolymorphicProps<"div", ContextMenuTriggerProps<"div">> & {
  class?: string;
};

/**
 * The element a right-click belongs to. `class="contents"` is the usual
 * answer when the trigger must not grow a box around an already-laid-out row.
 */
function ContextMenuTrigger(props: TriggerProps) {
  const [local, rest] = splitProps(props, ["class"]);
  return <ContextMenuPrimitive.Trigger class={local.class} {...rest} />;
}

type ContentProps = PolymorphicProps<"div", ContextMenuContentProps<"div">> & { class?: string };

function ContextMenuContent(props: ContentProps) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        class={cn(
          "surface-popover z-50 min-w-48 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground",
          local.class,
        )}
        {...rest}
      />
    </ContextMenuPrimitive.Portal>
  );
}

type ItemProps = PolymorphicProps<"div", ContextMenuItemProps<"div">> & { class?: string };

function ContextMenuItem(props: ItemProps) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <ContextMenuPrimitive.Item
      class={cn(
        "relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        local.class,
      )}
      {...rest}
    />
  );
}

type SeparatorProps = PolymorphicProps<"hr", ContextMenuSeparatorProps<"hr">> & { class?: string };

function ContextMenuSeparator(props: SeparatorProps) {
  const [local, rest] = splitProps(props, ["class"]);
  // <hr> keeps a currentColor border from the preflight, which paints a dark
  // groove over the hairline. border-0 leaves only the inset token line.
  return (
    <ContextMenuPrimitive.Separator
      class={cn("mx-2 my-1 h-px border-0 bg-border", local.class)}
      {...rest}
    />
  );
}

type GroupLabelProps = PolymorphicProps<"div", ContextMenuGroupLabelProps<"div">> & { class?: string };

/** Section heading inside a menu — the stand-in for <optgroup>. */
function ContextMenuGroupLabel(props: GroupLabelProps) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <ContextMenuPrimitive.GroupLabel
      class={cn("px-2 py-1 text-2xs font-medium text-muted-foreground", local.class)}
      {...rest}
    />
  );
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuPrimitive,
  ContextMenuGroupLabel,
};
