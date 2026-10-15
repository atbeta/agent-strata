import { splitProps } from "solid-js";
import { Button as ButtonPrimitive } from "@kobalte/core/button";
import type { ButtonRootProps } from "@kobalte/core/button";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-border bg-transparent hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        /* A trigger with no box at all: run text inside a sentence, a timestamp,
           a section link. `link` is the accent-coloured underlined form, which
           is right for a real hyperlink and too loud for these. */
        quiet: "text-muted-foreground hover:text-foreground",
        /* A bordered-icon toolbar button: header tools, find arrows, panel
           closers. Muted at rest, a quiet fill on hover — not the accent that
           `ghost` reserves for the selected row. */
        icon: "text-muted-foreground hover:bg-secondary hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        /* The ladder runs 20 → 44. It exists because the screens already used
           these heights: tool-card actions sit at h-6, dense toolbars at h-7,
           fields and default buttons at h-8/h-9. Before this scale existed only
           h-7 and up were expressible, so those call sites hand-wrote their own
           buttons instead of using this one — which is how a single screen ended
           up with four different icon-button heights. A size that a screen
           genuinely needs belongs here, not in that screen's className. */
        default: "h-9 px-3",
        sm: "h-8 px-2.5",
        xs: "h-6 px-2 text-2xs",
        lg: "h-11 px-6",
        icon: "size-9",
        "icon-sm": "size-7",
        "icon-xs": "size-6",
        "icon-2xs": "size-5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ButtonProps = PolymorphicProps<"button", ButtonRootProps<"button">> &
  VariantProps<typeof buttonVariants> & { class?: string };

function Button(props: ButtonProps) {
  const [local, others] = splitProps(props, ["variant", "size", "class"]);
  return (
    <ButtonPrimitive
      class={cn(buttonVariants({ variant: local.variant, size: local.size }), local.class)}
      {...others}
    />
  );
}

export { Button, buttonVariants };
export type { ButtonProps };
