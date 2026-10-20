import { splitProps } from "solid-js";
import { DropdownMenu as DropdownMenuPrimitive } from "@kobalte/core/dropdown-menu";
import type {
  DropdownMenuContentProps,
  DropdownMenuGroupLabelProps,
  DropdownMenuItemProps,
  DropdownMenuSeparatorProps,
  DropdownMenuSubContentProps,
  DropdownMenuSubTriggerProps,
  DropdownMenuTriggerProps,
} from "@kobalte/core/dropdown-menu";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import { cn } from "@/lib/utils";

const DropdownMenu = DropdownMenuPrimitive;

type TriggerProps = PolymorphicProps<"button", DropdownMenuTriggerProps<"button">> & {
  class?: string;
};

function DropdownMenuTrigger(props: TriggerProps) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <DropdownMenuPrimitive.Trigger
      class={cn(
        "inline-flex items-center justify-center rounded-md text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
        local.class,
      )}
      {...rest}
    />
  );
}

type ContentProps = PolymorphicProps<"div", DropdownMenuContentProps<"div">> & { class?: string };

function DropdownMenuContent(props: ContentProps) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        class={cn(
          "surface-popover menu-pop z-50 min-w-48 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground",
          local.class,
        )}
        {...rest}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

type ItemProps = PolymorphicProps<"div", DropdownMenuItemProps<"div">> & { class?: string };

function DropdownMenuItem(props: ItemProps) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <DropdownMenuPrimitive.Item
      class={cn(
        "relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        local.class,
      )}
      {...rest}
    />
  );
}

type SeparatorProps = PolymorphicProps<"hr", DropdownMenuSeparatorProps<"hr">> & { class?: string };

function DropdownMenuSeparator(props: SeparatorProps) {
  const [local, rest] = splitProps(props, ["class"]);
  // <hr> keeps a currentColor border from the preflight, which paints a dark
  // groove over the hairline. border-0 leaves only the inset token line.
  return (
    <DropdownMenuPrimitive.Separator
      class={cn("mx-2 my-1 h-px border-0 bg-border", local.class)}
      {...rest}
    />
  );
}

type GroupLabelProps = PolymorphicProps<"div", DropdownMenuGroupLabelProps<"div">> & { class?: string };

/** Section heading inside a menu — the stand-in for <optgroup>. */
function DropdownMenuGroupLabel(props: GroupLabelProps) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <DropdownMenuPrimitive.GroupLabel
      class={cn("px-2 py-1 text-2xs font-medium text-muted-foreground", local.class)}
      {...rest}
    />
  );
}

/**
 * A row that opens another menu beside it.
 *
 * The submenu is its own portal, so it can sit over the window edge the parent
 * menu is pinned against. The trigger is a menu item like any other — the
 * reader reaches it with the same arrow keys and the same Enter.
 */
const DropdownMenuSub = DropdownMenuPrimitive.Sub;

type SubTriggerProps = PolymorphicProps<"div", DropdownMenuSubTriggerProps<"div">> & { class?: string };

function DropdownMenuSubTrigger(props: SubTriggerProps) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <DropdownMenuPrimitive.SubTrigger
      class={cn(
        "relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        local.class,
      )}
      {...rest}
    />
  );
}

type SubContentProps = PolymorphicProps<"div", DropdownMenuSubContentProps<"div">> & { class?: string };

function DropdownMenuSubContent(props: SubContentProps) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent
        class={cn(
          "surface-popover menu-pop z-50 min-w-36 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground",
          local.class,
        )}
        {...rest}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuPrimitive,
  DropdownMenuGroupLabel,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
