import { cva } from "class-variance-authority";

/**
 * The one place a field's box is described.
 *
 * This lives apart from `text-field.tsx` because it is the half of the
 * primitive that has no JSX in it, and that is the half worth asserting on.
 * A test cannot import a `.tsx` here — bun compiles those with the React JSX
 * runtime and the repo has no solid transform configured for tests — but it
 * can import this, and this is the file nineteen call sites now depend on to
 * agree with each other.
 */
export const fieldVariants = cva(
  "w-full rounded-md border border-border px-2.5 text-foreground placeholder:text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40",
  {
    variants: {
      /* Two densities, because the app has two kinds of place a field goes.
         The policy editor and the MCP and provider forms sit inside panels that
         are already dense; a 36px field there made the form read as settings
         rather than as part of the surface it belongs to. The ladder runs 28 →
         36 for the same reason `Button` runs 20 → 44. */
      size: {
        xs: "h-7 text-xs",
        sm: "h-8 text-sm",
        default: "h-9 bg-secondary/40 text-sm",
      },
      /* `bare` has no border and no fill: the field is already sitting inside a
         bordered, filled shell — the global search overlay, the command
         palette, the in-session find bar. Drawing a second box inside the first
         one is what made those three read as different controls. */
      bare: { true: "border-0 bg-transparent px-0 focus-visible:ring-0" },
      /* A field holding a command, a path or a token is set in the mono face
         whether or not anyone remembered: the policy rules, the MCP command,
         the OAuth code. Three screens had this as a separate one-off class
         before. */
      mono: { true: "font-mono" },
    },
    defaultVariants: { size: "default" },
  },
);

export type FieldSize = NonNullable<Parameters<typeof fieldVariants>[0]>["size"];
