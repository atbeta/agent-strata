import { splitProps, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import { cn } from "@/lib/utils";

type CardProps = JSX.HTMLAttributes<HTMLElement> & {
  as?: "div" | "section" | "ul";
  class?: string;
};

export function Card(raw: CardProps) {
  const [local, rest] = splitProps(raw, ["as", "class"]);
  return (
    <Dynamic
      component={local.as ?? "div"}
      class={cn("rounded-lg border border-border bg-card", local.class)}
      {...rest}
    />
  );
}
