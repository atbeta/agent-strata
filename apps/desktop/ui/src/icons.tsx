import { createMemo, type JSX } from "solid-js";

export type Name =
  | "bot"
  | "bot-off"
  | "replay"
  | "files"
  | "page"
  | "download"
  | "link"
  | "shield"
  | "shield-check"
  | "columns"
  | "compare"
  | "search"
  | "image"
  | "folder"
  | "folder-open"
  | "folder-plus"
  | "filter"
  | "sliders"
  | "collapse-all"
  | "expand-all"
  | "chevron"
  | "chevron-right"
  | "arrow-down"
  | "arrow-left"
  | "pencil"
  | "archive"
  | "trash"

  | "spark"
  | "gear"
  | "more"
  | "terminal"
  | "globe"
  | "list"
  | "overview"
  | "wrench"
  | "branch"
  | "fork"
  | "attach"
  | "copy"
  | "cube"
  | "check"
  | "undo"
  | "plug"
  | "mcp"
  | "brain"
  | "stop"
  | "alert"
  | "bell"
  | "info"
  | "target"
  | "plus"
  | "x"
  | "split-row"
  | "split-col"
  | "grid"
  | "single-pane"
  | "panel-left"
  | "panel-right"
  | "activity"
  | "maximize"
  | "minimize"
  | "monitor"
  | "server"
  | "opencode"
  | "pin"
  | "unpin"
  | "export"
  | "eye"
  | "eye-off"
  | "layout"
  // Marks a plugin contributes through its manifest. A plugin may name any of
  // these; the registry refuses anything else, so the alias table here is the
  // whole vocabulary rather than a starting point.
  | "message"
  | "code"
  // Three bars: the numbers a message cost. Used where an "i" would read as
  // help rather than "what did this one use".
  | "stats"
  // A clock, a calendar, and the two states of a thing that runs on a
  // timer. The schedules panel is the reason they exist: a time is not
  // a word, and "暂停" written out is a label where a glyph says it
  // faster.
  | "clock"
  | "calendar"
  | "play"
  | "pause";

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
 * box, so the pen is scaled with the drawing. 24-grid glyphs without their own
 * note are Lucide (lucide-static 1.77.0) verbatim.
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
  // Lucide `bot` (24 grid, verbatim): the agent can operate this terminal.
  if (name === "bot")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M12 8V4H8" />
        <rect width="16" height="12" x="4" y="8" rx="2" />
        <path d="M2 14h2" />
        <path d="M20 14h2" />
        <path d="M15 13v2" />
        <path d="M9 13v2" />
      </Glyph>
    );
  // Lucide `bot-off` (24 grid, verbatim): the agent can neither see nor
  // operate it.
  if (name === "bot-off")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M13.67 8H18a2 2 0 0 1 2 2v4.33" />
        <path d="M2 14h2" />
        <path d="M20 14h2" />
        <path d="M22 22 2 2" />
        <path d="M8 8H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 1.414-.586" />
        <path d="M9 13v2" />
        <path d="M9.67 4H12v2.33" />
      </Glyph>
    );
  // A clock hand inside a counter-clockwise arrow: replaying what already
  // happened, which is what the trace drawer it opens shows.
  if (name === "replay")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
        <path d="M3 3v5h5" />
        <path d="M12 7v5l4 2" />
      </Glyph>
    );
  // Lucide `files` (24 grid, verbatim): the drawer of files — the header's
  // own switch for that drawer is `panel-right`, which says which side it
  // opens on; this one says what is in it.
  if (name === "files")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M15 2h-4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8" />
        <path d="M16.706 2.706A2.4 2.4 0 0 0 15 2v5a1 1 0 0 0 1 1h5a2.4 2.4 0 0 0-.706-1.706z" />
        <path d="M5 7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 1.732-1" />
      </Glyph>
    );
  // Lucide `file-text` on its own 24 grid, with the short metadata line left
  // out. Two text lines keep the page quiet at activity-row size.
  if (name === "page")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
        <path d="M14 2v4a2 2 0 0 0 2 2h4" />
        <path d="M16 13H8" />
        <path d="M16 17H8" />
      </Glyph>
    );
  if (name === "download")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M12 15V3" />
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <path d="m7 10 5 5 5-5" />
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
  // Lucide `message-square` (24 grid, verbatim): a plugin answering with words.
  if (name === "message")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" />
      </Glyph>
    );
  // Lucide `chart-no-axes-column` (24 grid, verbatim): measurements, not a
  // question mark.
  if (name === "stats")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M5 21v-6" />
        <path d="M12 21V3" />
        <path d="M19 21V9" />
      </Glyph>
    );
  // Lucide `code` (24 grid, verbatim): a plugin running code.
  if (name === "code")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="m16 18 6-6-6-6" />
        <path d="m8 6-6 6 6 6" />
      </Glyph>
    );
  /**
   * Lucide `eye` and `eye-off` (24 grid, verbatim): whether a provider is
   * offered in the model picker. The eye is a display toggle, not a
   * permission lock — the struck-through version still means the provider can
   * run a session that already named it.
   */
  if (name === "eye")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
        <circle cx="12" cy="12" r="3" />
      </Glyph>
    );
  if (name === "eye-off")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
        <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
        <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
        <path d="m2 2 20 20" />
      </Glyph>
    );
  if (name === "link")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </Glyph>
    );
  if (name === "shield")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      </Glyph>
    );
  if (name === "shield-check")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
        <path d="m9 12 2 2 4-4" />
      </Glyph>
    );
  if (name === "columns")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <rect width="18" height="18" x="3" y="3" rx="2" />
        <path d="M12 3v18" />
      </Glyph>
    );
  // Lucide `chart-column` (24 grid, verbatim): the usage compare.
  if (name === "compare")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M3 3v16a2 2 0 0 0 2 2h16" />
        <path d="M18 17V9" />
        <path d="M13 17V5" />
        <path d="M8 17v-3" />
      </Glyph>
    );
  if (name === "search")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.35-4.35" />
      </Glyph>
    );
  // Lucide `image` on its own 24 grid: the framed picture with a sun and a
  // mountain ridge — reading an image file is not reading a page.
  if (name === "image")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="9" cy="9" r="2" />
        <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
      </Glyph>
    );
  if (name === "folder")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      </Glyph>
    );
  if (name === "folder-open")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
      </Glyph>
    );
  if (name === "folder-plus")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M12 10v6" />
        <path d="M9 13h6" />
        <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      </Glyph>
    );
  if (name === "filter")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z" />
      </Glyph>
    );
  if (name === "sliders")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M10 5H3" />
        <path d="M12 19H3" />
        <path d="M14 3v4" />
        <path d="M16 17v4" />
        <path d="M21 12h-9" />
        <path d="M21 19h-5" />
        <path d="M21 5h-7" />
        <path d="M8 10v4" />
        <path d="M8 12H3" />
      </Glyph>
    );
  if (name === "collapse-all")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="m7 20 5-5 5 5" />
        <path d="m7 4 5 5 5-5" />
      </Glyph>
    );
  if (name === "expand-all")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="m7 15 5 5 5-5" />
        <path d="m7 9 5-5 5 5" />
      </Glyph>
    );
  if (name === "arrow-left")
    return (
      <Glyph class={cls}>
        {/* A back arrow drawn, not typed. The text glyph `←` came out as a
            thin, high mark on Windows: the fallback font there draws it at a
            different weight and baseline than the app's face does on macOS. */}
        <path d="M13 8H3.6" />
        <path d="M7.4 3.8 3.2 8l4.2 4.2" />
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
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
        <path d="m15 5 4 4" />
      </Glyph>
    );
  if (name === "archive")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <rect width="20" height="5" x="2" y="3" rx="1" />
        <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
        <path d="M10 12h4" />
      </Glyph>
    );
  if (name === "spark")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" />
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
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <circle cx="12" cy="12" r="1" />
        <circle cx="19" cy="12" r="1" />
        <circle cx="5" cy="12" r="1" />
      </Glyph>
    );
  if (name === "terminal")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="m7 9 4 4-4 4" />
        <path d="M11 17h6" />
      </Glyph>
    );
  if (name === "globe")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
        <path d="M2 12h20" />
      </Glyph>
    );
  if (name === "list")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M3 5h.01" />
        <path d="M3 12h.01" />
        <path d="M3 19h.01" />
        <path d="M8 5h13" />
        <path d="M8 12h13" />
        <path d="M8 19h13" />
      </Glyph>
    );
  // Tabler `layout-grid` (24 grid, verbatim): four panes on one board — the
  // fleet page, where every project and session is in frame at once. Tabler's
  // smaller tiles keep the 2×2 grid, which carries roughly twice the ink of
  // the bell and ring beside it, reading at the same size at 14px.
  if (name === "overview")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M4 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4" />
        <path d="M14 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4" />
        <path d="M4 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4" />
        <path d="M14 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4" />
      </Glyph>
    );
  if (name === "wrench")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z" />
      </Glyph>
    );
  if (name === "branch")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M15 6a9 9 0 0 0-9 9V3" />
        <circle cx="18" cy="6" r="3" />
        <circle cx="6" cy="18" r="3" />
      </Glyph>
    );
  // Forking a conversation reads as one stem splitting two ways — not a git
  // branch, which is why "branch" stays for the VCS glyph in the header.
  if (name === "fork")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M16 3h5v5" />
        <path d="M8 3H3v5" />
        <path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3" />
        <path d="m15 9 6-6" />
      </Glyph>
    );
  if (name === "attach")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551" />
      </Glyph>
    );
  if (name === "copy")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
        <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
      </Glyph>
    );
  // Lucide `box` (24 grid, verbatim): the model as something you hold and
  // configure, rather than the spark that reads as "generate".
  if (name === "cube")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
        <path d="m3.3 7 8.7 5 8.7-5" />
        <path d="M12 22V12" />
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
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M9 14 4 9l5-5" />
        <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />
      </Glyph>
    );
  if (name === "plug")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        {/* A 12-unit plug reads a size smaller than the search and terminal
            marks beside it. The 16-unit body keeps the same 18-unit height. */}
        <path d="M8 7V3" />
        <path d="M16 7V3" />
        <path d="M20 7v5a8 8 0 0 1-16 0V7Z" />
        <path d="M12 21v-1" />
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
        <g transform="translate(14 7.8) scale(0.88)" stroke-width="15.9">
          <path d="M23.5996 85.2532L86.2021 22.6507C94.8457 14.0071 108.86 14.0071 117.503 22.6507C126.147 31.2942 126.147 45.3083 117.503 53.9519L70.2254 101.23" />
          <path d="M70.8789 100.578L117.504 53.952C126.148 45.3083 140.163 45.3083 148.806 53.952L149.132 54.278C157.776 62.9216 157.776 76.9357 149.132 85.5792L92.5139 142.198C89.6327 145.079 89.6327 149.75 92.5139 152.631L104.14 164.257" />
          <path d="M101.853 38.3013L55.553 84.6011C46.9094 93.2447 46.9094 107.258 55.553 115.902C64.1966 124.546 78.2106 124.546 86.8543 115.902L133.154 69.6025" />
        </g>
      </Glyph>
    );
  // Lucide `brain` on its own 24 grid (verbatim) — the reasoning indicator.
  // The hand-drawn hemispheres it replaces never sat right: dense enough to
  // blob at 14px, yet drawn small enough to read as a speck beside the
  // library marks it shares the row with.
  if (name === "brain")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M12 18V5" />
        <path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" />
        <path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" />
        <path d="M17.997 5.125a4 4 0 0 1 2.526 5.77" />
        <path d="M18 18a4 4 0 0 0 2-7.464" />
        <path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" />
        <path d="M6 18a4 4 0 0 1-2-7.464" />
        <path d="M6.003 5.125a4 4 0 0 0-2.526 5.77" />
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
  if (name === "trash")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M10 11v6" />
        <path d="M14 11v6" />
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
        <path d="M3 6h18" />
        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      </Glyph>
    );
  if (name === "single-pane")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <rect width="18" height="18" x="3" y="3" rx="2" />
      </Glyph>
    );
  if (name === "split-row")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <rect width="18" height="18" x="3" y="3" rx="2" />
        <path d="M12 3v18" />
      </Glyph>
    );
  if (name === "split-col")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <rect width="18" height="18" x="3" y="3" rx="2" />
        <path d="M3 12h18" />
      </Glyph>
    );
  if (name === "grid")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M12 3v18" />
        <path d="M3 12h18" />
        <rect x="3" y="3" width="18" height="18" rx="2" />
      </Glyph>
    );
  /**
   * Lucide `panel-left` (24 grid, verbatim): a window with a column on its
   * left — the mirror of `panel-right`, so the two fold buttons read as one
   * drawing and its reflection.
   */
  if (name === "panel-left")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <rect width="18" height="18" x="3" y="3" rx="2" />
        <path d="M9 3v18" />
      </Glyph>
    );
  /**
   * Lucide `panel-right` (24 grid, verbatim): a window with a column on its
   * right — the drawer that opens beside the session, and the mirror of
   * `panel-left`.
   */
  if (name === "panel-right")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <rect width="18" height="18" x="3" y="3" rx="2" />
        <path d="M15 3v18" />
      </Glyph>
    );
  /**
   * Lucide `loader-circle` (24 grid, verbatim): an open ring — work in
   * progress. The gap is what makes it read as motion rather than a plain
   * circle.
   */
  if (name === "activity")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </Glyph>
    );
  // Lucide `monitor` (24 grid, verbatim): the window's own look — theme,
  // language, type. A display with its stand.
  if (name === "monitor")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <rect width="20" height="14" x="2" y="3" rx="2" />
        <line x1="8" x2="16" y1="21" y2="21" />
        <line x1="12" x2="12" y1="17" y2="21" />
      </Glyph>
    );
  // Lucide `server` (24 grid, verbatim): a stacked pair of machines — the
  // places a session can run.
  if (name === "server")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
        <rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
        <line x1="6" x2="6.01" y1="6" y2="6" />
        <line x1="6" x2="6.01" y1="18" y2="18" />
      </Glyph>
    );
  // OpenCode's own mark — the square ring with the inset block — adapted from
  // the favicon at opencode.ai rather than redrawn to taste: this row names
  // that product, so the mark is theirs.
  if (name === "opencode")
    return (
      <Glyph class={cls}>
        <rect x="3" y="2" width="10" height="12" rx="1" />
        <rect x="5.5" y="6.5" width="5" height="5" rx="0.5" fill="currentColor" stroke="none" opacity="0.45" />
      </Glyph>
    );
  if (name === "maximize")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M15 3h6v6" />
        <path d="m21 3-7 7" />
        <path d="m3 21 7-7" />
        <path d="M9 21H3v-6" />
      </Glyph>
    );
  if (name === "minimize")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="m14 10 7-7" />
        <path d="M20 10h-6V4" />
        <path d="m3 21 7-7" />
        <path d="M4 14h6v6" />
      </Glyph>
    );
  /**
   * Lucide `bell` (24 grid, verbatim): something is waiting on a person —
   * dome, skirt and clapper in two strokes.
   */
  if (name === "bell")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M10.268 21a2 2 0 0 0 3.464 0" />
        <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
      </Glyph>
    );
  if (name === "alert")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" x2="12" y1="8" y2="12" />
        <line x1="12" x2="12.01" y1="16" y2="16" />
      </Glyph>
    );
  if (name === "info")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4" />
        <path d="M12 8h.01" />
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
  // Lucide `pin` (24 grid, verbatim): a session kept in reach.
  if (name === "pin")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M12 17v5" />
        <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
      </Glyph>
    );
  // Lucide `pin-off` (24 grid, verbatim): a pin crossed out — currently
  // pinned, and this takes it out.
  if (name === "unpin")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M12 17v5" />
        <path d="M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89" />
        <path d="m2 2 20 20" />
        <path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11" />
      </Glyph>
    );
  // Lucide `clock` (24 grid, verbatim): a time, not a badge.
  if (name === "clock")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 6v6l4 2" />
      </Glyph>
    );
  // Lucide `calendar` (24 grid, verbatim): a date rather than a window.
  if (name === "calendar")
    return (
      <Glyph class={cls} box="0 0 24 24" weight="2.25">
        <path d="M8 2v3" />
        <path d="M16 2v3" />
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M3 9h18" />
      </Glyph>
    );
  // A filled triangle: the one shape that means "go" without a word.
  if (name === "play")
    return (
      <Glyph class={cls}>
        <path d="M5.5 3.75v8.5l6.5-4.25z" fill="currentColor" stroke="none" />
      </Glyph>
    );
  // Two bars. Paused is the state a schedule sits in while the reader
  // has it switched off, so it is drawn solid like the play triangle.
  if (name === "pause")
    return (
      <Glyph class={cls}>
        <path d="M5.75 3.75v8.5M10.25 3.75v8.5" stroke-width="2" />
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
