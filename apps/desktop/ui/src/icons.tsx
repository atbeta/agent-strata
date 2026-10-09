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
  | "wrench";

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
  if (props.name === "replay")
    return (
      <Glyph class={props.class}>
        <path d="M3 8a5 5 0 1 0 1.2-3.2" />
        <path d="M3 3.2V6.2H6" />
      </Glyph>
    );
  if (props.name === "files")
    return (
      <Glyph class={props.class}>
        <path d="M4 2.5h5l3 3V13.5H4z" />
        <path d="M9 2.5V6h3" />
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
  return (
    <Glyph class={props.class}>
      <path d="M3.5 4.5h9" />
      <path d="M6 4.5v-1h4v1" />
      <path d="M4.5 4.5 5.2 13h5.6l.7-8.5" />
    </Glyph>
  );
}
