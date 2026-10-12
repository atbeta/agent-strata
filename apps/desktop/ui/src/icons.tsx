import type { JSX } from "solid-js";

type Name =
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
  | "plus";

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

export function Icon(props: { name: Name; class?: string }) {
  // A run of events down a rail with the current position marked. Vertical on
  // purpose: the horizontal variant read as a squashed progress bar and sat
  // badly next to the taller toolbar glyphs.
  if (props.name === "replay")
    return (
      <Glyph class={props.class}>
        <path d="M4.5 2.6v10.8" />
        <circle cx="4.5" cy="4.2" r="1.15" fill="currentColor" stroke="none" />
        <circle cx="4.5" cy="11.8" r="1.15" fill="currentColor" stroke="none" />
        <path d="M8 4.2h4.8M8 11.8h4.8" />
        <circle cx="4.5" cy="8" r="2.1" />
        <path d="M8 8h3.2" />
      </Glyph>
    );
  // A panel with a rail, matching the drawer it opens.
  if (props.name === "files")
    return (
      <Glyph class={props.class}>
        <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
        <path d="M9.5 3v10" />
      </Glyph>
    );
  if (props.name === "download")
    return (
      <Glyph class={props.class}>
        <path d="M8 2.5v7" />
        <path d="M5.2 7.2 8 10l2.8-2.8" />
        <path d="M3.5 13.5h9" />
      </Glyph>
    );
  if (props.name === "link")
    return (
      <Glyph class={props.class}>
        <path d="M6.5 9.5 9.5 6.5" />
        <path d="M7 4.5 8.2 3.3a2.5 2.5 0 0 1 3.5 3.5L10.5 8" />
        <path d="M9 11.5 7.8 12.7a2.5 2.5 0 0 1-3.5-3.5L5.5 8" />
      </Glyph>
    );
  if (props.name === "shield")
    return (
      <Glyph class={props.class}>
        <path d="M8 2.2 12.5 4v3.6c0 2.6-1.8 4.4-4.5 5.7C5.3 12 3.5 10.2 3.5 7.6V4z" />
      </Glyph>
    );
  if (props.name === "columns")
    return (
      <Glyph class={props.class}>
        <rect x="2.5" y="3" width="4.2" height="10" rx="1" />
        <rect x="9.3" y="3" width="4.2" height="10" rx="1" />
      </Glyph>
    );
  if (props.name === "search")
    return (
      <Glyph class={props.class}>
        <circle cx="7" cy="7" r="3.2" />
        <path d="M9.4 9.4 13 13" />
      </Glyph>
    );
  if (props.name === "folder")
    return (
      <Glyph class={props.class}>
        <path d="M2.5 5.2c0-.7.5-1.2 1.2-1.2h2.2l1.2 1.3H12.3c.7 0 1.2.5 1.2 1.2v6c0 .7-.5 1.2-1.2 1.2H3.7c-.7 0-1.2-.5-1.2-1.2z" />
      </Glyph>
    );
  if (props.name === "chevron")
    return (
      <Glyph class={props.class}>
        <path d="M4 6.2 8 10l4-3.8" />
      </Glyph>
    );
  if (props.name === "pencil")
    return (
      <Glyph class={props.class}>
        <path d="M9.2 3.2 12.8 6.8 5.5 14.1 2 14.5 2.4 11z" />
      </Glyph>
    );
  if (props.name === "archive")
    return (
      <Glyph class={props.class}>
        <path d="M2.5 3.5h11v2h-11z" />
        <path d="M3.5 5.5v7h9v-7" />
        <path d="M6.5 8.5h3" />
      </Glyph>
    );
  if (props.name === "spark")
    return (
      <Glyph class={props.class}>
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
  if (props.name === "gear")
    return (
      <Glyph class={props.class}>
        <circle cx="8" cy="8" r="2" />
        <path d="M8 2.2v1.6M8 12.2v1.6M2.2 8h1.6M12.2 8h1.6M3.8 3.8l1.2 1.2M11 11l1.2 1.2M12.2 3.8 11 5M5 11 3.8 12.2" />
      </Glyph>
    );
  if (props.name === "more")
    return (
      <Glyph class={props.class}>
        <circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none" />
        <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
        <circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none" />
      </Glyph>
    );
  if (props.name === "terminal")
    return (
      <Glyph class={props.class}>
        <rect x="2.2" y="3" width="11.6" height="10" rx="1.4" />
        <path d="M4.4 6.4 6.4 8 4.4 9.6" />
        <path d="M7.6 9.6h3.2" />
      </Glyph>
    );
  if (props.name === "globe")
    return (
      <Glyph class={props.class}>
        <circle cx="8" cy="8" r="5.2" />
        <path d="M2.8 8h10.4" />
        <path d="M8 2.8c1.5 1.6 2.3 3.3 2.3 5.2s-.8 3.6-2.3 5.2c-1.5-1.6-2.3-3.3-2.3-5.2s.8-3.6 2.3-5.2z" />
      </Glyph>
    );
  if (props.name === "list")
    return (
      <Glyph class={props.class}>
        <path d="M6 4.2h7.2" />
        <path d="M6 8h7.2" />
        <path d="M6 11.8h7.2" />
        <circle cx="3.4" cy="4.2" r="0.7" fill="currentColor" stroke="none" />
        <circle cx="3.4" cy="8" r="0.7" fill="currentColor" stroke="none" />
        <circle cx="3.4" cy="11.8" r="0.7" fill="currentColor" stroke="none" />
      </Glyph>
    );
  if (props.name === "wrench")
    return (
      <Glyph class={props.class}>
        <path d="M9.6 2.6a2.3 2.3 0 0 0-2.4 3.2L3.2 9.8 6.2 12.8l4-4a2.3 2.3 0 0 0 3.2-2.4L11.2 6.6 9.4 4.8z" />
      </Glyph>
    );
  if (props.name === "branch")
    return (
      <Glyph class={props.class}>
        <circle cx="5" cy="3.8" r="1.4" />
        <circle cx="5" cy="12.2" r="1.4" />
        <circle cx="11" cy="5.8" r="1.4" />
        <path d="M5 5.2v5.6" />
        <path d="M11 7.2c0 2.4-2.2 3-6 3.6" />
      </Glyph>
    );
  // Forking a conversation reads as one stem splitting two ways — not a git
  // branch, which is why "branch" stays for the VCS glyph in the header.
  if (props.name === "fork")
    return (
      <Glyph class={props.class}>
        <path d="M8 14V9.4a2.7 2.7 0 0 0-.8-1.9L2.5 2.5" />
        <path d="M10 6l3.5-3.5" />
        <path d="M10 2.5h3.5V6" />
        <path d="M6 2.5H2.5V6" />
      </Glyph>
    );
  if (props.name === "attach")
    return (
      <Glyph class={props.class}>
        <path d="M10.5 4.5 5.6 9.4a1.6 1.6 0 0 0 2.3 2.3l5-5a3 3 0 0 0-4.3-4.3l-5 5a4.4 4.4 0 0 0 6.2 6.2l4.2-4.2" />
      </Glyph>
    );
  if (props.name === "copy")
    return (
      <Glyph class={props.class}>
        <rect x="6" y="6" width="6.6" height="6.6" rx="1.2" />
        <path d="M4.2 10.2V4.2c0-.6.5-1.1 1.1-1.1H10" />
      </Glyph>
    );
  if (props.name === "check")
    return (
      <Glyph class={props.class}>
        <path d="M3.4 8.3 6.5 11.4 12.6 4.8" />
      </Glyph>
    );
  if (props.name === "undo")
    return (
      <Glyph class={props.class}>
        <path d="M6.2 4.2 3.4 7l2.8 2.8" />
        <path d="M3.8 7h6.4a2.8 2.8 0 0 1 0 5.6H7.5" />
      </Glyph>
    );
  if (props.name === "plug")
    return (
      <Glyph class={props.class}>
        <path d="M6 2.6v3.2" />
        <path d="M10 2.6v3.2" />
        <path d="M4.2 5.8h7.6v3.6a3.8 3.8 0 0 1-3.8 3.8 3.8 3.8 0 0 1-3.8-3.8z" />
        <path d="M8 13.2v1.4" />
      </Glyph>
    );
  // Two mirrored hemispheres with inner folds — the reasoning indicator.
  if (props.name === "brain")
    return (
      <Glyph class={props.class}>
        <g stroke-width="1.25">
          <path d="M8 3.2C8 1.3 4.5 1.1 4.2 3.2C2.4 3.1 1.7 5.4 2.8 6.6C1.2 8.1 1.8 10.7 3.6 11.2C3.3 13.2 5.1 14.5 6.8 13.5C7.6 13.4 8 12.9 8 12Z" />
          <path d="M8 3.2C8 1.3 11.5 1.1 11.8 3.2C13.6 3.1 14.3 5.4 13.2 6.6C14.8 8.1 14.2 10.7 12.4 11.2C12.7 13.2 10.9 14.5 9.2 13.5C8.4 13.4 8 12.9 8 12Z" />
          <path d="M4.2 3.2v1.2c0 .8.4 1.3 1.1 1.6M2.8 6.6h1.4M3.6 11.2v-1.1c0-.9.5-1.5 1.3-1.7" />
          <path d="M11.8 3.2v1.2c0 .8-.4 1.3-1.1 1.6M13.2 6.6h-1.4M12.4 11.2v-1.1c0-.9-.5-1.5-1.3-1.7" />
        </g>
      </Glyph>
    );
  if (props.name === "stop")
    return (
      <Glyph class={props.class}>
        <rect x="4" y="4" width="8" height="8" rx="1" />
      </Glyph>
    );
  if (props.name === "plus")
    return (
      <Glyph class={props.class}>
        <path d="M8 3.5v9M3.5 8h9" />
      </Glyph>
    );
  if (props.name === "alert")
    return (
      <Glyph class={props.class}>
        <circle cx="8" cy="8" r="5.5" />
        <path d="M8 4.5v4" />
        <circle cx="8" cy="11" r=".6" fill="currentColor" stroke="none" />
      </Glyph>
    );
  return (
    <Glyph class={props.class}>
      <path d="M3.5 4.5h9" />
      <path d="M6 4.5v-1h4v1" />
      <path d="M4.5 4.5 5.2 13h5.6l.7-8.5" />
    </Glyph>
  );
}
