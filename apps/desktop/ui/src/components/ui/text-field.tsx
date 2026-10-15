import { createContext, createUniqueId, splitProps, useContext, type JSX } from "solid-js";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { fieldVariants, type FieldSize } from "./field";

/**
 * Three pieces of one idea: the box, the field, and the caption above it.
 *
 * This used to wrap Kobalte's `TextField`, which meant the input could only
 * be rendered inside a root — `useFormControlContext` throws otherwise, and
 * nothing in the file said so. Nineteen call sites use a field on its own,
 * because a field inside a table row or a toolbar has no caption to put above
 * it; all nineteen took the whole page down with a blank screen until this was
 * caught. The app was never using Kobalte's validation, descriptions or
 * controlled-state plumbing, only the three class lists, so the dependency was
 * pure cost. These are plain elements now and the one piece of shared state —
 * which id the label points at — is explicit.
 */

const FieldIdContext = createContext<string>();

function TextField(props: {
  class?: string;
  children: JSX.Element;
  /** Only needed when the input or label wants to reference the pairing itself. */
  id?: string;
}) {
  const [local, others] = splitProps(props, ["class", "children", "id"]);
  // Stable across re-renders, which `createUniqueId` is; a random id per pass
  // would break the label association on every keystroke that re-renders it.
  const id = () => local.id ?? generated;
  const generated = createUniqueId();
  return (
    <div class={cn("flex flex-col gap-1", local.class)} {...others}>
      <FieldIdContext.Provider value={id()}>{local.children}</FieldIdContext.Provider>
    </div>
  );
}

type InputProps = Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "class" | "type"> & {
  class?: string;
  type?: "text" | "password" | "search" | "url" | "email";
  size?: FieldSize;
  bare?: boolean;
  mono?: boolean;
};

/**
 * The field. It stands alone: without a `TextField` above it there is no
 * caption, and a caption is what `TextField` is for.
 */
function TextFieldInput(rawProps: InputProps) {
  const fieldId = useContext(FieldIdContext);
  const [local, others] = splitProps(rawProps, ["type", "class", "size", "bare", "mono", "id"]);
  return (
    <input
      type={local.type ?? "text"}
      id={local.id ?? fieldId}
      class={cn(fieldVariants({ size: local.size, bare: local.bare, mono: local.mono }), local.class)}
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

function TextFieldLabel(props: {
  class?: string;
  variant?: "label" | "description" | "error";
  children: JSX.Element;
}) {
  const fieldId = useContext(FieldIdContext);
  const [local, others] = splitProps(props, ["class", "variant", "children"]);
  return (
    <label for={fieldId} class={cn(labelVariants({ variant: local.variant }), local.class)} {...others}>
      {local.children}
    </label>
  );
}

export { TextField, TextFieldInput, TextFieldLabel };
