/**
 * How a header toggle says it is on.
 *
 * A ring, not a background. `variant="icon"` already spends `bg-secondary` and
 * `text-foreground` on hover, and the lit state used to spend exactly the same
 * two — so a closed button under the cursor and an open button without it were
 * the same picture. The pointer is over one of these whenever you are deciding
 * which one to press, so that is the one moment the difference had to be
 * readable in. It was also the one moment it was not.
 *
 * A background on its own would have been enough had hover not already claimed
 * that channel. The ring is what survives it: it is a box-shadow, and no hover
 * variant in the button sets one.
 *
 * Shared with the pane menu rather than restated there, because the two were
 * already written apart and that is how the header came to look like the menu
 * did not apply.
 *
 * Kept free of JSX so it can be exercised directly rather than asserted about
 * in a test.
 */
export function toggleClasses(on: boolean): string {
  return on ? "bg-accent text-foreground ring-1 ring-border" : "";
}
