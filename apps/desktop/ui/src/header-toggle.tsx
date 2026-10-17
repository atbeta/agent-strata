import type { JSX } from "solid-js";

/**
 * The icon's own colour, set on the icon rather than the button.
 *
 * An inherited hover colour reaches every descendant, so a button told to turn
 * bright on hover turns its icon bright too — the same collision the ring
 * settles for the background. A colour set directly here wins over one it would
 * otherwise inherit, so a lit toggle keeps its colour while the pointer sits on
 * it and an unlit one does not borrow it.
 *
 * `tone` replaces both states rather than decorating the lit one, because the
 * toggle in this row that needs one has a third state: its switch cannot be
 * read at all, which is neither on nor off and must not be drawn as either. The
 * ring still comes from `on`, so that state reads as an unlit button in alarm
 * colour — visible, and not claiming to be enabled.
 */
export function ToggleIcon(props: { on: boolean; tone?: string; children: JSX.Element }) {
  return (
    // 18px inside the 28px buttons: the row reads at toolbar weight, not at
    // the smaller menu-item scale the 16px default belongs to.
    <span class={`[&_svg]:size-4.5 transition-colors ${props.tone ?? (props.on ? "text-foreground" : "text-muted-foreground")}`}>
      {props.children}
    </span>
  );
}
