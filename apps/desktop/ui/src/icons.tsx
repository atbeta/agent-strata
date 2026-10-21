import { createMemo, type JSX } from "solid-js";

export type Name =
  | "replay"
  | "files"
  | "page"
  | "download"
  | "link"
  | "shield"
  | "shield-check"
  | "columns"
  | "search"
  | "folder"
  | "folder-open"
  | "folder-plus"
  | "filter"
  | "sliders"
  | "chevron"
  | "chevron-right"
  | "arrow-down"
  | "pencil"
  | "archive"

  | "spark"
  | "gear"
  | "more"
  | "terminal"
  | "globe"
  | "list"
  | "wrench"
  | "branch"
  | "fork"
  | "attach"
  | "copy"
  | "check"
  | "undo"
  | "plug"
  | "mcp"
  | "brain"
  | "stop"
  | "alert"
  | "target"
  | "plus"
  | "x"
  | "split-row"
  | "split-col"
  | "grid"
  | "single-pane"
  | "maximize"
  | "minimize"
  | "pin"
  | "unpin"
  | "export"
  | "eye"
  | "eye-off"
  | "layout";

/**
 * `box` exists for the glyphs that are lifted from an icon library instead of
 * drawn here. Their upstream geometry is on a 24 grid and is reproduced
 * verbatim rather than re-fitted onto ours — a re-fit is a redraw with extra
 * steps, and a redraw is how we got a pushpin that read as a speck.
 *
 * `weight` follows from that. A 24-grid icon is scaled down by 16/24 to reach
 * the same rendered size, so a `stroke-width` kept at ours thins to two thirds
 * and the glyph reads lighter than every mark drawn on the 16 grid beside it.
 * Widening it by the same factor puts it back: the library drew it for its own
 * box, so the pen is scaled with the drawing.
 */
function Glyph(props: { class?: string; box?: string; weight?: string; children: JSX.Element }) {
  return (
    <svg
      viewBox={props.box ?? "0 0 16 16"}
      class={props.class ?? "h-4 w-4"}
      fill="none"
      stroke="currentColor"
      stroke-width={props.weight ?? "1.5"}
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      {props.children}
    </svg>
  );
}

function glyphFor(name: Name, cls: string | undefined): JSX.Element {
  // A clock hand inside a counter-clockwise arrow: replaying what already
  // happened, which is what the trace drawer it opens shows.
  if (name === "replay")
    return (
      <Glyph class={cls}>
        <path d="M2.6 8A5.4 5.4 0 1 0 8 2.6 5.4 5.4 0 0 0 4.3 4.3L2.6 6" />
        <path d="M2.6 2.8V6h3.2" />
        <path d="M8 5.2V8l2.2 1.5" />
      </Glyph>
    );
  // A panel with a rail, matching the drawer it opens.
  if (name === "files")
    return (
      <Glyph class={cls}>
        <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
        <path d="M9.5 3v10" />
      </Glyph>
    );
  // A sheet with a folded corner and two lines of text. Reading a file is a
  // document; the files glyph above is the drawer, and at 14px the two must
  // not be the same picture.
  if (name === "page")
    return (
      <Glyph class={cls}>
        <path d="M4 2.4h5.2L12 5.2V13.6H4z" />
        <path d="M9.2 2.6V5.2H12" />
        <path d="M6 8.2h4" />
        <path d="M6 10.6h4" />
      </Glyph>
    );
  if (name === "download")
    return (
      <Glyph class={cls}>
        <path d="M8 2.5v7" />
        <path d="M5.2 7.2 8 10l2.8-2.8" />
        <path d="M3.5 13.5h9" />
      </Glyph>
    );
  /**
   * Lucide `square-arrow-out-up-right` (24 grid, verbatim). A box with its
   * top-right corner open and an arrow leaving through the gap — which reads as
   * "this leaves the app", where a tray with a down arrow read as "this comes
   * down here", the opposite direction of the same idea.
   */
  if (name === "export")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6" />
        <path d="m21 3-9 9" />
        <path d="M15 3h6v6" />
      </Glyph>
    );
  /**
   * Tabler `layout` (24 grid, verbatim): a narrow left column split in two
   * beside one tall pane. The pane layouts in this app are one narrow side and
   * one wide side, so the icon that names the feature is that shape rather than
   * the plain divided rectangle the old hand-drawn marks were.
   */
  if (name === "layout")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M4 6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6" />
        <path d="M4 15a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3" />
        <path d="M14 6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2V6" />
      </Glyph>
    );
  /**
   * An open eye and the same eye struck through: whether a provider is offered
   * in the model picker. The eye is a display toggle, not a permission lock —
   * the struck-through version still means the provider can run a session that
   * already named it.
   */
  if (name === "eye")
    return (
      <Glyph class={cls}>
        <path d="M1.8 8s2.4-4.2 6.2-4.2S14.2 8 14.2 8s-2.4 4.2-6.2 4.2S1.8 8 1.8 8Z" />
        <circle cx="8" cy="8" r="2.1" />
      </Glyph>
    );
  if (name === "eye-off")
    return (
      <Glyph class={cls}>
        <path d="M6.4 3.9c.5-.1 1-.2 1.6-.2 3.8 0 6.2 4.3 6.2 4.3a10 10 0 0 1-2 2.4" />
        <path d="M4.1 4.9A10.6 10.6 0 0 0 1.8 8s2.4 4.2 6.2 4.2c.7 0 1.4-.1 2-.4" />
        <path d="M2.2 2.2 13.8 13.8" />
      </Glyph>
    );
  if (name === "link")
    return (
      <Glyph class={cls}>
        <path d="M6.5 9.5 9.5 6.5" />
        <path d="M7 4.5 8.2 3.3a2.5 2.5 0 0 1 3.5 3.5L10.5 8" />
        <path d="M9 11.5 7.8 12.7a2.5 2.5 0 0 1-3.5-3.5L5.5 8" />
      </Glyph>
    );
  if (name === "shield")
    return (
      <Glyph class={cls}>
        <path d="M8 2.2 12.5 4v3.6c0 2.6-1.8 4.4-4.5 5.7C5.3 12 3.5 10.2 3.5 7.6V4z" />
      </Glyph>
    );
  if (name === "shield-check")
    return (
      <Glyph class={cls}>
        <path d="M8 2.2 12.5 4v3.6c0 2.6-1.8 4.4-4.5 5.7C5.3 12 3.5 10.2 3.5 7.6V4z" />
        <path d="M6 7.9 7.4 9.3 10.1 6.6" />
      </Glyph>
    );
  if (name === "columns")
    return (
      <Glyph class={cls}>
        <rect x="2.5" y="3" width="4.2" height="10" rx="1" />
        <rect x="9.3" y="3" width="4.2" height="10" rx="1" />
      </Glyph>
    );
  if (name === "search")
    return (
      <Glyph class={cls}>
        <circle cx="7" cy="7" r="3.2" />
        <path d="M9.4 9.4 13 13" />
      </Glyph>
    );
  if (name === "folder")
    return (
      <Glyph class={cls}>
        <path d="M2.5 5.2c0-.7.5-1.2 1.2-1.2h2.2l1.2 1.3H12.3c.7 0 1.2.5 1.2 1.2v6c0 .7-.5 1.2-1.2 1.2H3.7c-.7 0-1.2-.5-1.2-1.2z" />
      </Glyph>
    );
  if (name === "folder-open")
    return (
      <Glyph class={cls}>
        {/* The closed folder's back half, cut where the flap covers it. */}
        <path d="M2.5 12V5.2c0-.7.5-1.2 1.2-1.2h2.2l1.2 1.3h5.2c.7 0 1.2.5 1.2 1.2v.8" />
        {/* The front flap: a parallelogram leaning right, its slant is what
            reads as "open" at 16px. */}
        <path d="M2.5 12l1.3-3.9c.2-.6.7-.9 1.3-.9h7.3c.7 0 1.2.7 1 1.4l-1.2 3.7c-.2.6-.7 1-1.3 1H3.6c-.7 0-1.2-.6-1.1-1.3z" />
      </Glyph>
    );
  if (name === "folder-plus")
    return (
      <Glyph class={cls}>
        <path d="M2.5 5.2c0-.7.5-1.2 1.2-1.2h2.2l1.2 1.3H12.3c.7 0 1.2.5 1.2 1.2v6c0 .7-.5 1.2-1.2 1.2H3.7c-.7 0-1.2-.5-1.2-1.2z" />
        <path d="M8 7.8v3.6M6.2 9.6h3.6" />
      </Glyph>
    );
  if (name === "filter")
    return (
      <Glyph class={cls}>
        {/* A funnel, drawn open: the wide mouth at the top and the stem that
            narrows to a point. The mouth is the part that has to read first —
            it is the shape the eye recognises as "narrowing this down". */}
        <path d="M2.6 3.4h10.8L9.5 7.9v4.2l-3 1.5V7.9z" />
      </Glyph>
    );
  if (name === "sliders")
    return (
      <Glyph class={cls}>
        {/* Three rails, a knob on each — the mixer a reader already calls a
            filter. Two rails read as a broken equals sign, and a line drawn
            through the knob turns the pair into one blob. The rail stops at
            the disc: at the size this mark is drawn, a ring's hole fills in
            and the stroke goes soft, which is the whole of why the old one
            disappeared on a dark ground. */}
        <path d="M2.5 4H7.2M12.8 4H13.5" />
        <circle cx="10" cy="4" r="1.4" fill="currentColor" stroke="none" />
        <path d="M2.5 8H3.2M8.8 8H13.5" />
        <circle cx="6" cy="8" r="1.4" fill="currentColor" stroke="none" />
        <path d="M2.5 12H6.2M11.8 12H13.5" />
        <circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none" />
      </Glyph>
    );
  if (name === "arrow-down")
    return (
      <Glyph class={cls}>
        <path d="M8 3v9.4" />
        <path d="M4.2 8.6 8 12.4l3.8-3.8" />
      </Glyph>
    );
  if (name === "chevron")
    return (
      <Glyph class={cls}>
        <path d="M4 6.2 8 10l4-3.8" />
      </Glyph>
    );
  if (name === "chevron-right")
    return (
      <Glyph class={cls}>
        <path d="M6.2 4 10 8l-3.8 4" />
      </Glyph>
    );
  if (name === "pencil")
    return (
      <Glyph class={cls}>
        <path d="M9.2 3.2 12.8 6.8 5.5 14.1 2 14.5 2.4 11z" />
      </Glyph>
    );
  if (name === "archive")
    return (
      <Glyph class={cls}>
        <path d="M2.5 3.5h11v2h-11z" />
        <path d="M3.5 5.5v7h9v-7" />
        <path d="M6.5 8.5h3" />
      </Glyph>
    );
  if (name === "spark")
    return (
      <Glyph class={cls}>
        <path d="M8 1.8v2.2" />
        <path d="M8 12v2.2" />
        <path d="M1.8 8h2.2" />
        <path d="M12 8h2.2" />
        <path d="M3.6 3.6 5.2 5.2" />
        <path d="M10.8 10.8l1.6 1.6" />
        <path d="M12.4 3.6 10.8 5.2" />
        <path d="M5.2 10.8 3.6 12.4" />
        <circle cx="8" cy="8" r="1.4" />
      </Glyph>
    );
  /**
   * Lucide `settings` (24 grid, verbatim). The old mark was a circle with
   * radial ticks, which at 14px read as a sun rather than a cog — the shape
   * everybody already knows means settings. The toothed ring is that shape.
   */
  if (name === "gear")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </Glyph>
    );
  if (name === "more")
    return (
      <Glyph class={cls}>
        <circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none" />
        <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
        <circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none" />
      </Glyph>
    );
  if (name === "terminal")
    return (
      <Glyph class={cls}>
        <rect x="2.2" y="3" width="11.6" height="10" rx="1.4" />
        <path d="M4.4 6.4 6.4 8 4.4 9.6" />
        <path d="M7.6 9.6h3.2" />
      </Glyph>
    );
  if (name === "globe")
    return (
      <Glyph class={cls}>
        <circle cx="8" cy="8" r="5.2" />
        <path d="M2.8 8h10.4" />
        <path d="M8 2.8c1.5 1.6 2.3 3.3 2.3 5.2s-.8 3.6-2.3 5.2c-1.5-1.6-2.3-3.3-2.3-5.2s.8-3.6 2.3-5.2z" />
      </Glyph>
    );
  if (name === "list")
    return (
      <Glyph class={cls}>
        <path d="M6 4.2h7.2" />
        <path d="M6 8h7.2" />
        <path d="M6 11.8h7.2" />
        <circle cx="3.4" cy="4.2" r="0.7" fill="currentColor" stroke="none" />
        <circle cx="3.4" cy="8" r="0.7" fill="currentColor" stroke="none" />
        <circle cx="3.4" cy="11.8" r="0.7" fill="currentColor" stroke="none" />
      </Glyph>
    );
  if (name === "wrench")
    return (
      <Glyph class={cls}>
        <path d="M9.6 2.6a2.3 2.3 0 0 0-2.4 3.2L3.2 9.8 6.2 12.8l4-4a2.3 2.3 0 0 0 3.2-2.4L11.2 6.6 9.4 4.8z" />
      </Glyph>
    );
  if (name === "branch")
    return (
      <Glyph class={cls}>
        <circle cx="5" cy="3.8" r="1.4" />
        <circle cx="5" cy="12.2" r="1.4" />
        <circle cx="11" cy="5.8" r="1.4" />
        <path d="M5 5.2v5.6" />
        <path d="M11 7.2c0 2.4-2.2 3-6 3.6" />
      </Glyph>
    );
  // Forking a conversation reads as one stem splitting two ways — not a git
  // branch, which is why "branch" stays for the VCS glyph in the header.
  if (name === "fork")
    return (
      <Glyph class={cls}>
        <path d="M8 14V9.4a2.7 2.7 0 0 0-.8-1.9L2.5 2.5" />
        <path d="M10 6l3.5-3.5" />
        <path d="M10 2.5h3.5V6" />
        <path d="M6 2.5H2.5V6" />
      </Glyph>
    );
  if (name === "attach")
    return (
      <Glyph class={cls}>
        <path d="M10.5 4.5 5.6 9.4a1.6 1.6 0 0 0 2.3 2.3l5-5a3 3 0 0 0-4.3-4.3l-5 5a4.4 4.4 0 0 0 6.2 6.2l4.2-4.2" />
      </Glyph>
    );
  if (name === "copy")
    return (
      <Glyph class={cls}>
        <rect x="6" y="6" width="6.6" height="6.6" rx="1.2" />
        <path d="M4.2 10.2V4.2c0-.6.5-1.1 1.1-1.1H10" />
      </Glyph>
    );
  if (name === "check")
    return (
      <Glyph class={cls}>
        <path d="M3.4 8.3 6.5 11.4 12.6 4.8" />
      </Glyph>
    );
  if (name === "undo")
    return (
      <Glyph class={cls}>
        <path d="M6.2 4.2 3.4 7l2.8 2.8" />
        <path d="M3.8 7h6.4a2.8 2.8 0 0 1 0 5.6H7.5" />
      </Glyph>
    );
  if (name === "plug")
    return (
      <Glyph class={cls}>
        <path d="M6 2.6v3.2" />
        <path d="M10 2.6v3.2" />
        <path d="M4.2 5.8h7.6v3.6a3.8 3.8 0 0 1-3.8 3.8 3.8 3.8 0 0 1-3.8-3.8z" />
        <path d="M8 13.2v1.4" />
      </Glyph>
    );
  // The official MCP mark, in its stroked form — the filled silhouette it
  // replaced weighed twice what every glyph around it does. Drawn on the
  // mark's own grid, with the pen scaled (see `box`/`weight` on `Glyph`) to
  // match the 16-grid stroke it sits beside. "plug" stays for generic
  // connection points; this one means MCP specifically.
  if (name === "mcp")
    return (
      <Glyph class={cls} box="10 10 160 160" weight="14">
        <path d="M23.5996 85.2532L86.2021 22.6507C94.8457 14.0071 108.86 14.0071 117.503 22.6507C126.147 31.2942 126.147 45.3083 117.503 53.9519L70.2254 101.23" />
        <path d="M70.8789 100.578L117.504 53.952C126.148 45.3083 140.163 45.3083 148.806 53.952L149.132 54.278C157.776 62.9216 157.776 76.9357 149.132 85.5792L92.5139 142.198C89.6327 145.079 89.6327 149.75 92.5139 152.631L104.14 164.257" />
        <path d="M101.853 38.3013L55.553 84.6011C46.9094 93.2447 46.9094 107.258 55.553 115.902C64.1966 124.546 78.2106 124.546 86.8543 115.902L133.154 69.6025" />
      </Glyph>
    );
  // Two mirrored hemispheres with inner folds — the reasoning indicator.
  if (name === "brain")
    return (
      <Glyph class={cls}>
        <g stroke-width="1.25">
          <path d="M8 3.2C8 1.3 4.5 1.1 4.2 3.2C2.4 3.1 1.7 5.4 2.8 6.6C1.2 8.1 1.8 10.7 3.6 11.2C3.3 13.2 5.1 14.5 6.8 13.5C7.6 13.4 8 12.9 8 12Z" />
          <path d="M8 3.2C8 1.3 11.5 1.1 11.8 3.2C13.6 3.1 14.3 5.4 13.2 6.6C14.8 8.1 14.2 10.7 12.4 11.2C12.7 13.2 10.9 14.5 9.2 13.5C8.4 13.4 8 12.9 8 12Z" />
          <path d="M4.2 3.2v1.2c0 .8.4 1.3 1.1 1.6M2.8 6.6h1.4M3.6 11.2v-1.1c0-.9.5-1.5 1.3-1.7" />
          <path d="M11.8 3.2v1.2c0 .8-.4 1.3-1.1 1.6M13.2 6.6h-1.4M12.4 11.2v-1.1c0-.9-.5-1.5-1.3-1.7" />
        </g>
      </Glyph>
    );
  if (name === "stop")
    return (
      <Glyph class={cls}>
        <rect x="4" y="4" width="8" height="8" rx="1" />
      </Glyph>
    );
  if (name === "plus")
    return (
      <Glyph class={cls}>
        <path d="M8 3.5v9M3.5 8h9" />
      </Glyph>
    );
  if (name === "x")
    return (
      <Glyph class={cls}>
        <path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8" />
      </Glyph>
    );
  if (name === "single-pane")
    return (
      <Glyph class={cls}>
        <rect x="2.5" y="3" width="11" height="10" rx="1.4" />
      </Glyph>
    );
  if (name === "split-row")
    return (
      <Glyph class={cls}>
        <rect x="2.5" y="3" width="11" height="10" rx="1.4" />
        <path d="M8 3v10" />
      </Glyph>
    );
  if (name === "split-col")
    return (
      <Glyph class={cls}>
        <rect x="2.5" y="3" width="11" height="10" rx="1.4" />
        <path d="M2.5 8h11" />
      </Glyph>
    );
  if (name === "grid")
    return (
      <Glyph class={cls}>
        <rect x="2.5" y="3" width="11" height="10" rx="1.4" />
        <path d="M8 3v10M2.5 8h11" />
      </Glyph>
    );
  if (name === "maximize")
    return (
      <Glyph class={cls}>
        <path d="M9.8 2.8h3.4v3.4M6.2 13.2H2.8V9.8M13.2 2.8 9.2 6.8M2.8 13.2l4-4" />
      </Glyph>
    );
  if (name === "minimize")
    return (
      <Glyph class={cls}>
        <path d="M13 6.2H9.8V3M3 9.8h3.2V13M9.8 6.2 13.5 2.5M6.2 9.8 2.5 13.5" />
      </Glyph>
    );
  if (name === "alert")
    return (
      <Glyph class={cls}>
        <circle cx="8" cy="8" r="5.5" />
        <path d="M8 4.5v4" />
        <circle cx="8" cy="11" r=".6" fill="currentColor" stroke="none" />
      </Glyph>
    );
  // Concentric rings with a filled centre: the mark a session goal is aimed at.
  if (name === "target")
    return (
      <Glyph class={cls}>
        <circle cx="8" cy="8" r="5.5" />
        <circle cx="8" cy="8" r="2.75" />
        <circle cx="8" cy="8" r="0.6" fill="currentColor" stroke="none" />
      </Glyph>
    );
  // Tabler `pin`, moved onto our 16 grid at 2/3 of its 24. It was drawn here
  // before, as a diamond with a hairline needle — which at 12px is a smudge.
  // The library's shape has a head with real width and a needle you can see.
  if (name === "pin")
    return (
      <Glyph class={cls}>
        <path d="M10 3l-2.67 2.67l-2.67 1l-1 1l4.67 4.67l1-1l1-2.67l2.67-2.67" />
        <path d="M6 10l-3 3" />
        <path d="M9.67 2.67l3.67 3.67" />
      </Glyph>
    );
  // Remix `unpin-line`, verbatim on its own 24 grid. A pin crossed out says
  // "currently pinned, this undoes it" in a way the same pin again does not.
  // It is a fill icon, so the child overrides the stroke Glyph would set.
  if (name === "unpin")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path
          fill="currentColor"
          stroke="none"
          d="m20.97 17.172l-1.414 1.414l-3.535-3.535l-.073.074l-.707 3.536l-1.415 1.414l-4.242-4.243l-4.95 4.95l-1.414-1.414l4.95-4.95l-4.243-4.243L5.34 8.761l3.536-.707l.073-.074l-3.536-3.536L6.828 3.03zM10.365 9.394l-.502.502l-2.822.565l6.5 6.5l.564-2.822l.502-.502zm8.411.074l-1.34 1.34l1.414 1.415l1.34-1.34l.707.707l1.415-1.415l-8.486-8.485l-1.414 1.414l.707.707l-1.34 1.34l1.414 1.415l1.34-1.34z"
        />
      </Glyph>
    );
  return (
    <Glyph class={cls}>
      <path d="M3.5 4.5h9" />
      <path d="M6 4.5v-1h4v1" />
      <path d="M4.5 4.5 5.2 13h5.6l.7-8.5" />
    </Glyph>
  );
}

/**
 * Draws one glyph, chosen by name.
 *
 * The choice goes through a memo because a Solid component body runs once: an
 * `if` chain read straight from props picked its branch when the button was
 * built and never looked again, so a name that changed afterwards was silently
 * dropped while the rest of that button's props kept updating. Copy turned
 * green and announced "已复制" with the copy glyph still showing — the one
 * piece of feedback that tells you whether it worked.
 */
export function Icon(props: { name: Name; class?: string }) {
  const glyph = createMemo(() => glyphFor(props.name, props.class));
  return <>{glyph()}</>;
}
