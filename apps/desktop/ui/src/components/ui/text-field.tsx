import { mergeProps, splitProps } from "solid-js";
import { TextField as TextFieldPrimitive } from "@kobalte/core/text-field";
import type { TextFieldInputProps, TextFieldLabelProps, TextFieldRootProps } from "@kobalte/core/text-field";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

type TextFieldProps = PolymorphicProps<"div", TextFieldRootProps<"div">> & { class?: string };

function TextField(props: TextFieldProps) {
  const [local, others] = splitProps(props, ["class"]);
  return <TextFieldPrimitive class={cn("flex flex-col gap-1", local.class)} {...others} />;
}

type InputProps = PolymorphicProps<"input", TextFieldInputProps<"input">> & {
  class?: string;
  type?: "text" | "password" | "search" | "url" | "email";
};

function TextFieldInput(rawProps: InputProps) {
  const props = mergeProps<InputProps[]>({ type: "text" }, rawProps);
  const [local, others] = splitProps(props, ["type", "class"]);
  return (
    <TextFieldPrimitive.Input
      type={local.type}
      class={cn(
        "flex h-9 w-full rounded-md border border-border bg-secondary/40 px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40",
        local.class,
      )}
      {...others}
    />
  );
}

const labelVariants = cva("text-sm font-medium leading-none", {
  variants: {
    variant: {
      label: "",
      description: "font-normal text-muted-foreground",
      error: "text-2xs text-destructive",
    },
  },
  defaultVariants: { variant: "label" },
});

type LabelProps = PolymorphicProps<"label", TextFieldLabelProps<"label">> & { class?: string };

function TextFieldLabel(props: LabelProps) {
  const [local, others] = splitProps(props, ["class"]);
  return <TextFieldPrimitive.Label class={cn(labelVariants(), local.class)} {...others} />;
}

export { TextField, TextFieldInput, TextFieldLabel };
