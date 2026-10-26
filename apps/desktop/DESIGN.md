# Agent Strata design system v0.3

The shell is a dark, quiet desktop app. Visual references are Linear (one neutral surface, hairline borders, compact UI type, accent used sparingly) and OpenCode Desktop (session sidebar, conversation, composer, custom window chrome). Tokens live in `ui/src/theme.css`. Interactive controls come from a small Solid component set in `ui/src/components/ui`, styled with those tokens. Light is available via `theme.ts`; dark stays the default.

## Components

The set is an owned copy of [solid-ui](https://github.com/stefan-karger/solid-ui) (the Solid port of the shadcn component model). Primitives are `@kobalte/core`. `cn()` in `ui/src/lib/utils.ts` merges classes. Import from `@/components/ui/*`.

Official shadcn/ui is React, so its CLI is not used here. solid-ui's own CLI targets Tailwind 3 and this app is Tailwind 4, so new pieces are copied in and adapted by hand: keep the Kobalte behavior, restyle with the tokens in `theme.css`, and skip animation class names that are not defined in this theme. Density is tighter than the solid-ui defaults (14px type, 32px fields, 28px icon buttons).

In use: `Button`, `TextField`, `DropdownMenu` on the sidebar (project switcher, search, row actions, connect). The rest of the screens still carry hand-styled controls; they move onto this set as those screens are touched. Do not add a second styling path beside these components.

`primitive-adoption.test.ts` enforces this. It counts hand-written `<button>` and `<input>` outside `components/ui` and fails when the count rises above a fixed budget. The budget only moves down, and a screen that converts its controls lowers it in the same commit — so "do not add a second styling path" is a red build rather than a sentence in this file. See *Controls left hand-written* below for what the remaining budget is spent on.

## Patterns

The primitives cover controls. These cover the recurring *shapes* the screens otherwise re-invented, each of which had drifted per screen.

- **`ListRow`** — the shell for any clickable list row (session, search hit, provider, policy). A `div[role=button]`, because rows contain their own interactive children (inline rename, per-row menu) and nesting those in a real `<button>` is invalid. It therefore owns the keyboard contract once: Enter and Space activate, Escape and Tab do not, the focus ring matches `Button`, and `active` sets `aria-current`. Per-row menus mark themselves `data-row-menu` so clicking one does not also open the row.
- **`SectionHeader`** — a sidebar group's label, count and optional hint. The count follows the label directly; only the hint takes the far side. An `ml-auto` count left the label and its number ~250px apart with nothing between them, which read as unrelated chrome.
- **`EmptyState`** — the one way this app says "nothing here yet" or "that did not work". Fixed shape: icon in a muted disc, title, optional description, optional action, centred. `tone="danger"` tints it for a failure. `LoadingTranscript` owns the transcript skeleton; `EmptyState` covers empty, connection and failure states instead of each screen writing a one-off paragraph.
- **`CommandDialog`** — the shared modal shell for global search, the command palette and the session switcher. It owns the dimmed backdrop, panel width constraint, radius, elevation, entry motion and outside-click dismissal. Callers keep their own input, results and keyboard model; `class` is for a different panel width, not a new visual treatment.
- **`PillGroup`** (in `settings-blocks.tsx`) — the pill idiom as a whole, for sets too wide for one control: six font sizes, four leading presets. `Segmented` covers the two- and three-option case. It wraps deliberately — a set too wide for its column folds instead of spilling past the edge — so the column it sits in has to be wide enough for the widest set, not the average one.
- **`RowButton`** — a clickable list row that is a *single action*, so unlike `ListRow` it stays a native `<button>` and gets Enter, Space and form semantics for free. Full width, left-aligned, content-sized, one hover shade, one focus ring. Callers override geometry (`rounded-none` for the flush fleet rows, `flex-col items-stretch` for the stacked search hits) and pass `style` / `aria-*` straight through, which is what lets the file tree keep its depth indent and the provider row keep its `aria-expanded`. Reach for `ListRow` when the row holds its own controls; for this when it does not.
- **`MiniTabs`** — the compact switcher at panel scale: two or three words, one on, no container. Not a variant of `Segmented`, which is the same idea at settings scale with a border and room for a swatch. `kind` is not decoration — `tabs` answers `aria-selected` inside a `tablist` because it reveals a panel that stays mounted, `radio` answers `aria-checked` inside a `radiogroup` because it picks one value out of a set. They look the same; collapsing that would mean lying to one of them.
- **`ChoiceCard`** — a bordered card that picks one thing: a pending-question option, the OpenCode launch mode. It carries two lines of text where `Button` carries one and a fill, so it earns its border. `mode` again separates the honest contracts — `radio` for one-of-N, `press` for a question that may take several answers at once. `check` draws the corner tick where the border does not already say it.
- **`SessionStatusMark`** — a session's state as a dot, plus the word beside it only where the word earns the row width. The decision lives in `sessionStatus()` (`ui/src/session-status.ts`, pure, so it is testable without Solid) because `GET /sessions` sends three independent fields — `status`, `busy`, `needs_input` — and every caller that read them separately got a different answer: the sidebar drew a bare six-pixel dot with no name on it anywhere, the fleet attention list drew a badge that called one session 待处理 and another 进行中 for states that are not the same, and `status` itself had no reader at all, so a session that ended in an error drew exactly what a session that ended cleanly drew — nothing. Only two states take a badge, **needs input** (the reader is what is holding the turn up) and **failed** (it ended, and nothing else on the row would say so). Running says itself with a breathing dot; stopped, done and idle say nothing, because a finished session is the normal case for every row in a list of four hundred and marking all of them marks none. Those three still carry their word to a screen reader. `session-status.test.ts` holds the precedence and stops either list from picking a status colour again.

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

Linear keeps the sidebar and the document on the same background. Separation is a 1px border at about 8% white, not a second gray panel. Selection is a soft fill. Section labels are 12px and sentence case. The accent color appears on the primary action, not on every border.

Light mode is the one exception to the shared surface: it tints the sidebar (`--sidebar`, ~96.5% lightness against the 99% window) because on a near-white window the hairline alone does not separate the columns; dark keeps one surface.

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

### Elevation, motion and responsive layout

`surface-popover`, `surface-dialog`, `surface-composer` and `surface-action` read their shadows from `--popover-shadow`, `--dialog-shadow`, `--composer-shadow` and `--action-shadow`. Floating surfaces draw no CSS border — a 0.5px ring inside the shadow is the edge (the opencode recipe), which is why the composer keeps a transparent border only as a focus indicator. `surface-action` is the contrast-button treatment (send, stop, every `default` Button): tiny drop, edge ring, inset top highlight. A screen does not invent an RGBA shadow of its own; light and dark change the tokens together. Command overlays use one backdrop and one `dialog-pop` entrance. Entrance animations and status pulses only run under `prefers-reduced-motion: no-preference`; reduced motion also collapses CSS transitions and smooth scrolling.

`main` is `@container/main`, so a screen responds to the column it actually has rather than to the window minus a guessed sidebar. Settings keeps its left rail at 880px and above, switches to horizontal section tabs below it, and stacks a setting's label and control below 560px. New main-column breakpoints use the same named container.

The session rail keeps the reader's preferred width globally, but a `ResizeObserver` on its actual parent clamps only the visible width as that column changes; the saved preference is not rewritten by a temporary window resize. Its file list and diff stack below 560px and sit side by side above it. `MiniTabs` owns roving focus and arrow/Home/End navigation, and closing the rail returns focus to its header toggle. Trace can borrow the edge without leaving the rail toggle pressed.

### Type and radius
System sans for UI, mono for paths, ids, commands, and money. Radius follows the OpenCode desktop scale — `sm` 4px, `md` 6px on rows/fields/buttons, `lg` 8px on cards and menus, `xl` 10px on dialogs and the message bubble, `2xl` 12px reserved for the composer dock — so `rounded-full` is for pills, dots and switches only, never for buttons.

The type scale is declared once in `theme.css` and tuned to this app rather than to Tailwind's defaults, so `text-sm` — not `text-base` — is the UI size:

| Step | px | Use |
| --- | --- | --- |
| `text-2xs` | 12 | section labels, kbd hints, counts, mono metadata |
| `text-xs` | 13 | secondary copy, table cells, payload panes |
| `text-sm` | 14 | UI default: rows, buttons, fields, prose |
| `text-base` | 15 | emphasised body |
| `text-lg` / `text-xl` | 16 / 20 | `.md h2` / `.md h1`, page titles |

The ladder started at Linear's 11/13 and moved up a pixel: most of the copy is Chinese, and a CJK label at 11px closes up where a Latin one does not.

Use the named steps. `text-[14px]` is the same size as `text-sm` today, but only one of them survives a change to the scale. `.md` lives in the components layer so a caller can size rendered markdown with a utility; that is why the drawer passes `text-xs` and gets it.

### Payload rendering
Tool `input` and `result` arrive as raw event data and are rendered by `Payload` in `payload.tsx`, which decides the shape rather than guessing at draw time:

- An object or array — or a string that parses to one — becomes a `JsonView` tree: keyed rows, type-coloured scalars, one level open by default, collapsible below that.
- Anything else is highlighted mono: `ansi.ts` drops terminal escapes first, `highlight.ts` colours comments, strings, numbers, keywords and diff markers. Guessing is bounded — a bare version string stays plain rather than being dressed up as shell.
- Code fences inside markdown go through the same tokenizer, after DOMPurify, and carry their language in `data-lang`.

Wrapping is `break-words`, never `break-all`: breaking inside a word turns one long token into a column of fragments.

### Diagrams in a transcript

A ```mermaid fence is drawn rather than shown, and the engine is the heaviest thing this UI can pull in: roughly 0.6MB of shared core, gzipped, plus a chunk per diagram type. It is imported on the first block that needs one and never before, so a session with no diagram in it never pays for one — and a session that has one pays once.

Three things about where that runs are worth stating, because each is a way it breaks quietly:

- **Only a finished region is drawn.** A reply arrives as a longer string every token, and a fence that has not closed is half a diagram, not one. `stableBoundary` already draws the line between what has closed and what is still arriving, and only the closed side is handed over. Measured across a streamed message: nothing was parsed at steps 0–2, and the diagram appeared at step 3 when the fence closed.
- **A drawn diagram is not drawn again.** The transcript is a windowed list, so a row unmounts on the way out and is rebuilt on the way back. The draw is keyed on the source, which makes the cost once per message rather than once per scroll.
- **mermaid does not write into the page.** Its failure path appends an illustrated error block to `document.body` — outside the transcript, so the reader gets a stray graphic with nothing connecting it to the block that failed. Suppressed, with a sweep behind it.

A diagram that cannot be drawn keeps its source and gains one line saying why. The source stays because dropping it loses something the reader can still read and copy; the line is there because a block that shows as code with no explanation reads as "the model drew nothing", not "the diagram was wrong". The reason is trimmed to the line and the text under the caret — mermaid ends every parse error with the full list of tokens it expected, which recites the grammar at someone who asked for a flowchart.

The diagram's colours are set to the app's own rather than left to mermaid's default, which draws on white. Its base theme is for a light document, and a white rectangle in a dark transcript is glare. `securityLevel: strict` is set explicitly: a transcript is untrusted text, and the difference between rendering a diagram and executing one is that setting.

### The transcript and the dock

They share one column, and the dock is `shrink-0` — so whatever the dock takes, the transcript does not get. The dock's cap therefore belongs to the dock, not to the cards inside it: a `max-h` on the card stack bounds the cards and leaves the dock's own padding and the composer outside it, which is how a session with one pending question measured 548px of a 900px window and left the conversation 232px of it. The transcript holds a `min-h` floor for the same reason. A conversation is the thing the reader came for, and a dock that grows past the floor scrolls instead of squeezing it.

A jump lands with `JUMP_GAP` of air above the row, not flush against the title strip. `origin()` folds the container's padding into the target, so by the time a row lands that padding is behind the viewport — measuring it does not put it back. Centring uses the row's measured height rather than the estimate, because the row being measured is the one whose estimate is least likely to hold. And the window that renders the list is told about a programmatic scroll immediately: it is otherwise computed from the parent's mirror of the scroll, which arrives a frame later, so the row that was jumped to is not in the document and the jump does nothing.

### A question the reader has to answer

The dock's cards are only as good as the truth behind them, and for questions that truth was a map of promises. A question arrives as a promise handed back to whoever was connected at the time, and that promise lives in one process — so a restart emptied the map, and `/questions` answering from it meant a question someone was still looking at stopped existing as far as the UI was concerned. Not "answered": gone. No card, and no marker on the session that was waiting, which is the one signal that would have said otherwise.

The window was not theoretical. The connection re-reads the backend's pending prompts on a 30s clock, so the first half-minute of every launch had no questions in it at all. The log already had them — `question.asked` is appended the moment it arrives, and the projection replays it — so the projection is what `/questions`, `needs_input`, and the dock all read now. One source, so the marker on the session, the card in the dock, and the endpoint behind them cannot disagree about whether something is being asked.

Two consequences follow from the log being the record rather than the promise. Answering is no longer gated on holding a live promise: a question answered after a restart writes `question.resolved` and tells the backend through the driver directly, instead of returning a 404 from a lookup that restart had already emptied. And the 30s gap is closed twice over — the log answers immediately, and the connection now re-reads pending prompts once at startup rather than one interval in.

The card still needs a place to be. The dock has one. A pane showing another session beside this one does not — it has no questions, no dock and no composer, only a banner that jumps here — so a question raised while you were looking elsewhere is answered by coming back, not by answering in place.

### A launch that is honest about waiting

The first window is a launch surface, not the app. `StartupGate` waits for the sidecar, the backend, the first session list and the initial sync, then mounts the real screens. Before this, the first frame painted "service unreachable" in the footer and the sidebar while the sidecar was still coming up, then "connecting", then a sync the reader could not use; each was true for a moment and none was the whole situation. The gate shows one stage list, the sync progress, and only the actions that can help: retry, open the log, open connection settings, or enter with local history once the list is there. A launch that finishes inside 150ms skips the gate rather than flashing it, and a launch that has succeeded never puts the gate back for a later background sync.

A sync after launch is not a second launch. The list and the overview are held still while it runs: only structural events (a session appearing, leaving, changing status, or waiting on the reader) refresh them, and the finish does one full reread. That is what kept a token total from climbing message by message and a row from reading "刚刚" before its real timestamp was imported. The footer marks a running sync with a spinner, not the word, and a two-pixel line at the top of the content appears only after 1.5s, so a routine poll is over before either is seen.

## Screens

- **Sidebar** (`App.tsx`): project switcher, search, sessions grouped by day or by project.
- **Session** (`session-detail.tsx`): transcript, composer, optional files and replay. Thinking is a quiet disclosure (`Thought` / live `Thinking`) with a one-line preview. Tool calls are separate cards: Bash shows the command, Read and Edit show the path, edits add a `+n −n` diff, Search and Fetch show the query or URL, and a plan tool lists its items. File references are chips. Failed and denied calls use the destructive border; a finished call stays collapsed.

A plan is `PlanStrip`, tucked above the composer: one line when collapsed — progress and the step it is on — the full list when opened. It appears while a live session still has steps left and once they are all done, since a finished list is history and the transcript holding it is directly above. It opens by itself only for a session that is still working and has work in it, which is what makes a plan read as part of the run rather than something to go and open; from then on the reader's own toggle is remembered, keyed per session, so expanding a plan never silently expands it in another conversation.
- **Compare** (`compare.tsx`) and **policy** (`policy.tsx`): same tokens, no separate theme.
