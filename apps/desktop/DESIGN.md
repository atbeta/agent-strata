# Agent Strata design system v0.2

The shell is a dark, quiet desktop app. Visual references are Linear (one neutral surface, hairline borders, 13px UI type, accent used sparingly) and OpenCode Desktop (session sidebar, conversation, composer, custom window chrome). Tokens live in `ui/src/theme.css`. Interactive controls come from a small Solid component set in `ui/src/components/ui`, styled with those tokens.

## Components

The set is an owned copy of [solid-ui](https://github.com/stefan-karger/solid-ui) (the Solid port of the shadcn component model). Primitives are `@kobalte/core`. `cn()` in `ui/src/lib/utils.ts` merges classes. Import from `@/components/ui/*`.

Official shadcn/ui is React, so its CLI is not used here. solid-ui's own CLI targets Tailwind 3 and this app is Tailwind 4, so new pieces are copied in and adapted by hand: keep the Kobalte behavior, restyle with the tokens in `theme.css`, and skip animation class names that are not defined in this theme. Density is tighter than the solid-ui defaults (13px type, 32px fields, 28px icon buttons).

In use: `Button`, `TextField`, `DropdownMenu` on the sidebar (project switcher, search, row actions, connect). Session, compare, and policy still have hand-styled controls; they move onto this set as those screens are touched. Do not add a second styling path beside these components.

## What the references change

Linear keeps the sidebar and the document on the same background. Separation is a 1px border at about 8% white, not a second gray panel. Selection is a soft fill. Section labels are 11px and sentence case. The accent color appears on the primary action, not on every border.

OpenCode Desktop puts sessions in a left rail and the composer at the bottom of the conversation. On macOS the native title is hidden and traffic lights sit in the top of the sidebar (`titleBarStyle: Overlay`). On Windows the desktop app is frameless and draws its own title bar. Linux still ships the native title bar; that is a known gap in OpenCode, not a pattern to copy.

## Window chrome

The top 44px (`h-11`) of the sidebar and of the main column is the title strip. It uses `data-tauri-drag-region`, with both `app-region` and `-webkit-app-region`, and interactive controls inside it opt out of dragging.

macOS already overlays the traffic lights in that strip (`pl-[76px]`). Windows and Linux still show the native title bar. The next shell step is a frameless window on those platforms, with minimize, maximize, and close drawn in this strip. Do not remove native decorations until those controls exist.

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
System sans for UI, mono for paths, ids, commands, and money. UI copy is 13px; section labels are 11px. Radius stays small (`md` on rows and fields).

## Screens

- **Sidebar** (`App.tsx`): project switcher, search, sessions grouped by day or by project.
- **Session** (`session-detail.tsx`): transcript, composer, optional files and replay.
- **Compare** (`compare.tsx`) and **policy** (`policy.tsx`): same tokens, no separate theme.
