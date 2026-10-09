import { splitProps } from "solid-js";
import { DropdownMenu as DropdownMenuPrimitive } from "@kobalte/core/dropdown-menu";
import type {
  DropdownMenuContentProps,
  DropdownMenuItemProps,
  DropdownMenuSeparatorProps,
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
        "inline-flex items-center justify-center rounded-md text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
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
          "surface-popover z-50 min-w-48 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground",
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
        "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        local.class,
      )}
      {...rest}
    />
  );
}

type SeparatorProps = PolymorphicProps<"hr", DropdownMenuSeparatorProps<"hr">> & { class?: string };

function DropdownMenuSeparator(props: SeparatorProps) {
  const [local, rest] = splitProps(props, ["class"]);
  return <DropdownMenuPrimitive.Separator class={cn("-mx-1 my-1 h-px bg-border", local.class)} {...rest} />;
}

export { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator };
