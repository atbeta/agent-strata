import { createEffect, onCleanup } from "solid-js";

/**
 * Whether a press landed outside everything that counts as "still here".
 *
 * Split out from the listener because this is the part with a decision in it,
 * and the part that is easy to get wrong: forget the trigger and the press that
 * dismisses and the press that reopens both arrive, and the button reads as
 * stuck. A `contains` walk alone is not enough either — a press on the trigger
 * itself is inside by `contains`, but a press on the boundary between a panel
 * and the page is only outside if every named element agrees.
 */
export function isOutside(
  target: Element | null,
  inside: (Element | undefined)[],
): boolean {
  if (!target) return false;
  for (const el of inside) {
    // An element that detached between the press and this read belongs to
    // nobody, and treating it as inside would make the panel undismissable.
    if (!el) continue;
    if (el === target || el.contains(target)) return false;
  }
  return true;
}

/**
 * Close an anchored panel when a press lands outside it and its trigger.
 *
 * The panels in the session header are not menus: they hold inputs, a list and
 * connect buttons, so a dismiss-on-blur would throw away a half-typed query and
 * a half-finished connect. The only exit they had was the trigger itself, which
 * means a reader who opened one and then reached for something else had to find
 * the same button again with the pointer to put it away.
 *
 * `pointerdown` on the capture phase rather than `click`, for two reasons. It
 * lands before the click a control inside the panel would handle, so a press
 * that lands on one is decided by that control and not by this; and a press
 * that starts inside the panel and ends outside it still belongs to the panel,
 * which a click listener — fired on the nearest common ancestor — gets wrong.
 */
export function useDismiss(
  open: () => boolean,
  onDismiss: () => void,
  ...inside: (() => Element | undefined)[]
): void {
  createEffect(() => {
    if (!open()) return;
    const onPointerDown = (e: PointerEvent) => {
      if (isOutside(e.target as Element | null, inside.map((ref) => ref()))) onDismiss();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    onCleanup(() => document.removeEventListener("pointerdown", onPointerDown, true));
  });
}
