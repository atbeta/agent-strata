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
  | "spark";

export function Icon(props: { name: Name; class?: string }) {
  const cls = props.class ?? "h-4 w-4";
  const common = {
    viewBox: "0 0 16 16",
    class: cls,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.5",
    "stroke-linecap": "round" as const,
    "stroke-linejoin": "round" as const,
  };
  if (props.name === "replay")
    return (
      <svg {...common}>
        <path d="M3 8a5 5 0 1 0 1.2-3.2" />
        <path d="M3 3.2V6.2H6" />
      </svg>
    );
  if (props.name === "files")
    return (
      <svg {...common}>
        <path d="M4 2.5h5l3 3V13.5H4z" />
        <path d="M9 2.5V6h3" />
      </svg>
    );
  if (props.name === "download")
    return (
      <svg {...common}>
        <path d="M8 2.5v7" />
        <path d="M5.2 7.2 8 10l2.8-2.8" />
        <path d="M3.5 13.5h9" />
      </svg>
    );
  if (props.name === "link")
    return (
      <svg {...common}>
        <path d="M6.5 9.5 9.5 6.5" />
        <path d="M7 4.5 8.2 3.3a2.5 2.5 0 0 1 3.5 3.5L10.5 8" />
        <path d="M9 11.5 7.8 12.7a2.5 2.5 0 0 1-3.5-3.5L5.5 8" />
      </svg>
    );
  if (props.name === "shield")
    return (
      <svg {...common}>
        <path d="M8 2.2 12.5 4v3.6c0 2.6-1.8 4.4-4.5 5.7C5.3 12 3.5 10.2 3.5 7.6V4z" />
      </svg>
    );
  if (props.name === "columns")
    return (
      <svg {...common}>
        <rect x="2.5" y="3" width="4.2" height="10" rx="1" />
        <rect x="9.3" y="3" width="4.2" height="10" rx="1" />
      </svg>
    );
  if (props.name === "search")
    return (
      <svg {...common}>
        <circle cx="7" cy="7" r="3.2" />
        <path d="M9.4 9.4 13 13" />
      </svg>
    );
  if (props.name === "folder")
    return (
      <svg {...common}>
        <path d="M2.5 5.2c0-.7.5-1.2 1.2-1.2h2.2l1.2 1.3H12.3c.7 0 1.2.5 1.2 1.2v6c0 .7-.5 1.2-1.2 1.2H3.7c-.7 0-1.2-.5-1.2-1.2z" />
      </svg>
    );
  if (props.name === "chevron")
    return (
      <svg {...common}>
        <path d="M4 6.2 8 10l4-3.8" />
      </svg>
    );
  if (props.name === "pencil")
    return (
      <svg {...common}>
        <path d="M9.2 3.2 12.8 6.8 5.5 14.1 2 14.5 2.4 11z" />
      </svg>
    );
  if (props.name === "archive")
    return (
      <svg {...common}>
        <path d="M2.5 3.5h11v2h-11z" />
        <path d="M3.5 5.5v7h9v-7" />
        <path d="M6.5 8.5h3" />
      </svg>
    );
  if (props.name === "spark")
    return (
      <svg {...common}>
        <path d="M8 1.8v2.2" />
        <path d="M8 12v2.2" />
        <path d="M1.8 8h2.2" />
        <path d="M12 8h2.2" />
        <path d="M3.6 3.6 5.2 5.2" />
        <path d="M10.8 10.8l1.6 1.6" />
        <path d="M12.4 3.6 10.8 5.2" />
        <path d="M5.2 10.8 3.6 12.4" />
        <circle cx="8" cy="8" r="1.4" />
      </svg>
    );
  return (
    <svg {...common}>
      <path d="M3.5 4.5h9" />
      <path d="M6 4.5v-1h4v1" />
      <path d="M4.5 4.5 5.2 13h5.6l.7-8.5" />
    </svg>
  );
}
