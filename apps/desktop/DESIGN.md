# Agent Strata design system v0.1

shadcn/ui token model adapted to Solid (Kobalte primitives + Tailwind 4 `@theme`).
Canonical source: `ui/src/theme.css`. Never hardcode raw palette colors — use the
semantic tokens below so components stay themeable.

## Token layers

### Base semantics (shadcn-compatible)
| Token | Use |
| --- | --- |
| `background` / `foreground` | app shell |
| `card` / `card-foreground` | session cards, panels |
| `popover` | dropdowns, dialogs, tooltips surface |
| `primary` | main actions (focus, open session) |
| `secondary` | quiet surfaces (toolbar, chips) |
| `muted` / `muted-foreground` | metadata, secondary text, disabled |
| `accent` | hover/selected states |
| `destructive` | deny/danger actions (stop session, deny permission) |
| `border` / `input` / `ring` | dividers, form controls, focus ring |

### Domain tokens (agent-strata specific)
| Token | Use |
| --- | --- |
| `status-active` | running session dot/badge (green) |
| `status-completed` | finished (blue) |
| `status-error` | failed (red) |
| `status-cancelled` | user-stopped (amber) |
| `status-pending` | queued/waiting (gray) |
| `event-user` | timeline/replay marker for user turns |
| `event-assistant` | assistant turns |
| `event-tool` | tool calls |
| `event-permission` | permission prompts |
| `event-file` | file changes |
| `cost-up` / `cost-down` / `cost-flat` | compare-view deltas |

### Typography / radius
`font-sans` (system), `font-mono` (code, commands, event ids, JSON).
Scale: `xs`–`2xl`. Radius: `sm`–`xl` (`lg` = 10px is the card default).

## Component conventions

- Components are Kobalte primitives (or plain Solid elements) styled with these
  tokens via Tailwind classes — same model as shadcn on React.
- Status is always a dot + label, never color alone (accessibility).
- Mono font for anything machine-shaped: session ids, commands, event types,
  token counts, file paths.
- Numbers tabular for cost/token comparisons.
- Dark-first: only one theme ships in v0; the token layer leaves room for light.

## Screens v0

- **Fleet dashboard** (`App.tsx`): aggregate cost bar + session card grid, live
  over SSE. Cards: status dot, title, backend · workspace, tool-call/token/cost
  stats.
- Planned: session detail (timeline replay), compare view, policy editor.
