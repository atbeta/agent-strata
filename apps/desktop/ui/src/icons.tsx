import { createMemo, type JSX } from "solid-js";

export type Name =
  | "replay"
  | "files"
  | "download"
  | "link"
  | "shield"
  | "columns"
  | "search"
  | "folder"
  | "chevron"
  | "pencil"
  | "archive"
  | "trash"
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
  | "brain"
  | "stop"
  | "alert"
  | "plus"
  | "x"
  | "split-row"
  | "split-col"
  | "grid"
  | "single-pane"
  | "maximize"
  | "minimize";

function Glyph(props: { class?: string; children: JSX.Element }) {
  return (
    <svg
      viewBox="0 0 16 16"
      class={props.class ?? "h-4 w-4"}
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      {props.children}
    </svg>
  );
}

function glyphFor(name: Name, cls: string | undefined): JSX.Element {
  // A run of events down a rail with the current position marked. Vertical on
  // purpose: the horizontal variant read as a squashed progress bar and sat
  // badly next to the taller toolbar glyphs.
  if (name === "replay")
    return (
      <Glyph class={cls}>
        <path d="M4.5 2.6v10.8" />
        <circle cx="4.5" cy="4.2" r="1.15" fill="currentColor" stroke="none" />
        <circle cx="4.5" cy="11.8" r="1.15" fill="currentColor" stroke="none" />
        <path d="M8 4.2h4.8M8 11.8h4.8" />
        <circle cx="4.5" cy="8" r="2.1" />
        <path d="M8 8h3.2" />
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
  if (name === "download")
    return (
      <Glyph class={cls}>
        <path d="M8 2.5v7" />
        <path d="M5.2 7.2 8 10l2.8-2.8" />
        <path d="M3.5 13.5h9" />
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
  if (name === "chevron")
    return (
      <Glyph class={cls}>
        <path d="M4 6.2 8 10l4-3.8" />
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
  if (name === "gear")
    return (
      <Glyph class={cls}>
        <circle cx="8" cy="8" r="2" />
        <path d="M8 2.2v1.6M8 12.2v1.6M2.2 8h1.6M12.2 8h1.6M3.8 3.8l1.2 1.2M11 11l1.2 1.2M12.2 3.8 11 5M5 11 3.8 12.2" />
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
