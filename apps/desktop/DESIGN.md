# Agent Strata design system v0.2

The shell is a dark, quiet desktop app. Visual references are Linear (one neutral surface, hairline borders, 13px UI type, accent used sparingly) and OpenCode Desktop (session sidebar, conversation, composer, custom window chrome). Tokens live in `ui/src/theme.css`. Interactive controls come from a small Solid component set in `ui/src/components/ui`, styled with those tokens. Light is available via `theme.ts`; dark stays the default.

## Components

The set is an owned copy of [solid-ui](https://github.com/stefan-karger/solid-ui) (the Solid port of the shadcn component model). Primitives are `@kobalte/core`. `cn()` in `ui/src/lib/utils.ts` merges classes. Import from `@/components/ui/*`.

Official shadcn/ui is React, so its CLI is not used here. solid-ui's own CLI targets Tailwind 3 and this app is Tailwind 4, so new pieces are copied in and adapted by hand: keep the Kobalte behavior, restyle with the tokens in `theme.css`, and skip animation class names that are not defined in this theme. Density is tighter than the solid-ui defaults (13px type, 32px fields, 28px icon buttons).

In use: `Button`, `TextField`, `DropdownMenu` on the sidebar (project switcher, search, row actions, connect). Session, compare, and policy still have hand-styled controls; they move onto this set as those screens are touched. Do not add a second styling path beside these components.

## What the references change

Linear keeps the sidebar and the document on the same background. Separation is a 1px border at about 8% white, not a second gray panel. Selection is a soft fill. Section labels are 11px and sentence case. The accent color appears on the primary action, not on every border.

OpenCode Desktop puts sessions in a left rail and the composer at the bottom of the conversation. On macOS the native title is hidden and traffic lights sit in the top of the sidebar (`titleBarStyle: Overlay`). On Windows the desktop app is frameless and draws its own title bar. Linux still ships the native title bar; that is a known gap in OpenCode, not a pattern to copy.

## Window chrome

The top 44px (`h-11`) of the sidebar and of the main column is the title strip. It uses `data-tauri-drag-region`, with both `app-region` and `-webkit-app-region`, and interactive controls inside it opt out of dragging.

macOS already overlays the traffic lights in that strip (`pl-[76px]`). Windows is a frameless shell and draws minimize, maximize, and close itself; it has no traffic lights, so the strip carries the wordmark (`AppMark`) in that corner instead. Linux still ships the native title bar.

`WindowCaptionBar` is that strip, and it spans the full window width as a row of its own, above every column. The caption therefore never shares the top-right with anything: a screen header, the files rail, or the trace drawer can push as far right as it likes, because there is nothing above the row below it. Giving the caption its own row is the fix; it does not need to be pinned, overlaid, or given a reserved gutter. Windows and macOS draw the row (the latter for the traffic lights to sit on); Linux and the browser do not.

## Token layers

### Base semantics
| Token | Use |
| --- | --- |
| `background` / `foreground` | the window, including the sidebar |
| `card` | lifted blocks inside the window (tool calls, composer well) |
| `popover` | menus |
| `primary` | the one main action (send, connect) |
| `secondary` | quiet fills (hover, fields, chips) |
| `muted` / `muted-foreground` | metadata |
| `accent` | selected row |
| `destructive` | deny, delete confirm |
| `border` / `input` / `ring` | hairline, fields, focus |

### Domain tokens
| Token | Use |
| --- | --- |
| `status-active` / `completed` / `error` / `cancelled` / `pending` | session state. Pair the color with a label or a dot that has a text alternative. |
| `event-user` / `assistant` / `tool` / `permission` / `file` | transcript markers |
| `cost-up` / `cost-down` / `cost-flat` | compare deltas |

### Type and radius
System sans for UI, mono for paths, ids, commands, and money. Radius stays small (`md` on rows and fields).

The type scale is declared once in `theme.css` and tuned to this app rather than to Tailwind's defaults, so `text-sm` — not `text-base` — is the UI size:

| Step | px | Use |
| --- | --- | --- |
| `text-2xs` | 11 | section labels, kbd hints, counts, mono metadata |
| `text-xs` | 12 | secondary copy, table cells, payload panes |
| `text-sm` | 13 | UI default: rows, buttons, fields, prose |
| `text-base` | 14 | emphasised body |
| `text-lg` / `text-xl` | 16 / 20 | `.md h2` / `.md h1`, page titles |

Use the named steps. `text-[13px]` is the same size as `text-sm` today, but only one of them survives a change to the scale. `.md` lives in the components layer so a caller can size rendered markdown with a utility; that is why the drawer passes `text-xs` and gets it.

### Payload rendering
Tool `input` and `result` arrive as raw event data and are rendered by `Payload` in `payload.tsx`, which decides the shape rather than guessing at draw time:

- An object or array — or a string that parses to one — becomes a `JsonView` tree: keyed rows, type-coloured scalars, one level open by default, collapsible below that.
- Anything else is highlighted mono: `ansi.ts` drops terminal escapes first, `highlight.ts` colours comments, strings, numbers, keywords and diff markers. Guessing is bounded — a bare version string stays plain rather than being dressed up as shell.
- Code fences inside markdown go through the same tokenizer, after DOMPurify, and carry their language in `data-lang`.

Wrapping is `break-words`, never `break-all`: breaking inside a word turns one long token into a column of fragments.

## Screens

- **Sidebar** (`App.tsx`): project switcher, search, sessions grouped by day or by project.
- **Session** (`session-detail.tsx`): transcript, composer, optional files and replay. Thinking is a quiet disclosure (`Thought` / live `Thinking`) with a one-line preview. Tool calls are separate cards: Bash shows the command, Read and Edit show the path, edits add a `+n −n` diff, Search and Fetch show the query or URL, and a plan tool lists its items. File references are chips. Failed and denied calls use the destructive border; a finished call stays collapsed.
- **Compare** (`compare.tsx`) and **policy** (`policy.tsx`): same tokens, no separate theme.
