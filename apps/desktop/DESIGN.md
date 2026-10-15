# Agent Strata design system v0.3

The shell is a dark, quiet desktop app. Visual references are Linear (one neutral surface, hairline borders, 13px UI type, accent used sparingly) and OpenCode Desktop (session sidebar, conversation, composer, custom window chrome). Tokens live in `ui/src/theme.css`. Interactive controls come from a small Solid component set in `ui/src/components/ui`, styled with those tokens. Light is available via `theme.ts`; dark stays the default.

## Components

The set is an owned copy of [solid-ui](https://github.com/stefan-karger/solid-ui) (the Solid port of the shadcn component model). Primitives are `@kobalte/core`. `cn()` in `ui/src/lib/utils.ts` merges classes. Import from `@/components/ui/*`.

Official shadcn/ui is React, so its CLI is not used here. solid-ui's own CLI targets Tailwind 3 and this app is Tailwind 4, so new pieces are copied in and adapted by hand: keep the Kobalte behavior, restyle with the tokens in `theme.css`, and skip animation class names that are not defined in this theme. Density is tighter than the solid-ui defaults (13px type, 32px fields, 28px icon buttons).

In use: `Button`, `TextField`, `DropdownMenu` on the sidebar (project switcher, search, row actions, connect). The rest of the screens still carry hand-styled controls; they move onto this set as those screens are touched. Do not add a second styling path beside these components.

`primitive-adoption.test.ts` enforces this. It counts hand-written `<button>` and `<input>` outside `components/ui` and fails when the count rises above a fixed budget. The budget only moves down, and a screen that converts its controls lowers it in the same commit — so "do not add a second styling path" is a red build rather than a sentence in this file. See *Controls left hand-written* below for what the remaining budget is spent on.

## Patterns

The primitives cover controls. These cover the recurring *shapes* the screens otherwise re-invented, each of which had drifted per screen.

- **`ListRow`** — the shell for any clickable list row (session, search hit, provider, policy). A `div[role=button]`, because rows contain their own interactive children (inline rename, per-row menu) and nesting those in a real `<button>` is invalid. It therefore owns the keyboard contract once: Enter and Space activate, Escape and Tab do not, the focus ring matches `Button`, and `active` sets `aria-current`. Per-row menus mark themselves `data-row-menu` so clicking one does not also open the row.
- **`SectionHeader`** — a sidebar group's label, count and optional hint. The count follows the label directly; only the hint takes the far side. An `ml-auto` count left the label and its number ~250px apart with nothing between them, which read as unrelated chrome.
- **`EmptyState`** — the one way this app says "nothing here yet" or "that did not work". Fixed shape: icon in a muted disc, title, optional description, optional action, centred. `tone="danger"` tints it for a failure. Loading stays `LoadingTranscript`'s skeleton; `EmptyState` is for states that will not resolve on their own.
- **`PillGroup`** (in `settings-blocks.tsx`) — the pill idiom as a whole, for sets too wide for one control: six font sizes, four leading presets. `Segmented` covers the two- and three-option case. It wraps deliberately — a set too wide for its column folds instead of spilling past the edge — so the column it sits in has to be wide enough for the widest set, not the average one.
- **`RowButton`** — a clickable list row that is a *single action*, so unlike `ListRow` it stays a native `<button>` and gets Enter, Space and form semantics for free. Full width, left-aligned, content-sized, one hover shade, one focus ring. Callers override geometry (`rounded-none` for the flush fleet rows, `flex-col items-stretch` for the stacked search hits) and pass `style` / `aria-*` straight through, which is what lets the file tree keep its depth indent and the provider row keep its `aria-expanded`. Reach for `ListRow` when the row holds its own controls; for this when it does not.
- **`MiniTabs`** — the compact switcher at panel scale: two or three words, one on, no container. Not a variant of `Segmented`, which is the same idea at settings scale with a border and room for a swatch. `kind` is not decoration — `tabs` answers `aria-selected` inside a `tablist` because it reveals a panel that stays mounted, `radio` answers `aria-checked` inside a `radiogroup` because it picks one value out of a set. They look the same; collapsing that would mean lying to one of them.
- **`ChoiceCard`** — a bordered card that picks one thing: a pending-question option, the OpenCode launch mode. It carries two lines of text where `Button` carries one and a fill, so it earns its border. `mode` again separates the honest contracts — `radio` for one-of-N, `press` for a question that may take several answers at once. `check` draws the corner tick where the border does not already say it.

### Controls left hand-written

Ten `<button>`s and two `<input>`s stay outside `components/ui`, each because the primitive would be wrong rather than merely redundant. `primitive-adoption.test.ts` names them in full; the categories:

- **Definitions** — `Segmented` and `PillGroup` in `settings-blocks.tsx` are what the other screens are being converted onto.
- **Sub-ladder sizes** — a 14px JSON tree caret and a 16px attachment-removal badge, both below the 20px floor of the size ladder, which exists so a screen does not invent its own icon-button height.
- **Absolute-positioned marks** — the trace timeline block and its two 20×16 scroll arrows, which are pinned to a scroll container and driven by opacity.
- **Cells that already look like something** — a diff cell whose background carries the add/delete colour; the button is only the click target.
- **Inputs that draw nothing** — the hidden `type="file"` behind the composer's attach button, and the inline rename field inside a sidebar `ListRow`. The second one is the documented reason `ListRow` is a `div[role=button]` rather than a real button: a field cannot legally nest inside one, and it has to be borderless so the edit does not reflow the row.

A new one has to argue its way in against that list, not against the budget.

### Fields

`TextFieldInput` runs 28 → 36 for the same reason `Button` runs 20 → 44: the policy editor and the MCP and provider forms sit inside panels that are already dense, and a 36px field there made the form read as settings rather than as part of the surface it belongs to. `mono` is a face rather than a size — a field holding a command, a path or a token is set in mono, and three screens had each invented that class for itself. `bare` drops the box entirely for a field already inside one: the global search overlay, the command palette, the in-session find bar.

`TextField` exists only to give `TextFieldLabel` something to point at. A field with no caption above it — a table row, a toolbar — takes `TextFieldInput` alone, which is what nineteen of the call sites do.

Patterns with one consumer live next to it rather than in `components/ui`: `PanelToggle` (the session header's five panel controls, `session-detail.tsx`), `CaptionButton` (the frameless-window caption controls, `chrome.tsx`). They are the shapes, not primitives, and a second screen asking for one is when they move.

### Size ladder

`Button` runs 20 → 44 because the screens already used those heights: tool-card actions at 20/24, dense toolbars at 28, fields and default buttons at 32/36. Only 28 and up were expressible before, so the denser call sites hand-wrote their own buttons — which is how one screen ended up with four icon-button heights. A size a screen genuinely needs belongs in `buttonVariants`, not in that screen's `className`.

| Size | Height | Use |
| --- | --- | --- |
| `icon-2xs` | 20 | inline remove, inside a card row |
| `xs` | 24 | tool-card actions, MCP row buttons |
| `icon-xs` / `icon-sm` | 24 / 28 | find arrows, header tools, panel closers |
| `sm` | 32 | dense fields and toolbars |
| `default` / `lg` | 36 / 44 | primary action |

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
