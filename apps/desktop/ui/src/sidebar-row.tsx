import { createEffect, createSignal, Show } from "solid-js";
import { Icon } from "./icons";
import { t } from "./i18n";
import type { SessionStatus } from "./session-status";
import { SessionStatusMark } from "@/components/ui/session-status";
import { ListRow } from "@/components/ui/list-row";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

export function SessionListItem(props: {
  id: string;
  title: string;
  active: boolean;
  status: SessionStatus;
  time: string;
  actions: boolean;
  onOpen: () => void;
  onRename: (title: string) => Promise<void>;
  onArchive: () => Promise<void>;
  /** Whether the row sits in the pinned group; the menu reads one of two words. */
  pinned: boolean;
  onTogglePin: () => void;
  /** Start a comparison with this session already picked. */
  onCompare: () => void;
  /** Open this session in a side-by-side split pane. */
  onSplitOpen?: () => void;
  /**
   * Which server this session lives on, set only while one backend kind has
   * more than one instance connected.
   */
  instance?: { short: string; tip: string };
}) {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal(props.title);
  const [hot, setHot] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  let input: HTMLInputElement | undefined;
  // Rename, archive, and the rest stay behind one hover control. The menu is a
  // portal, so it has to count as "still on the row" or the control disappears.
  const reveal = () => props.actions && (hot() || menuOpen());

  createEffect(() => {
    if (!editing()) setDraft(props.title);
  });

  const commit = async () => {
    const title = draft().trim();
    setEditing(false);
    if (!title || title === props.title) return;
    await props.onRename(title);
  };

  /**
   * One list of actions behind two surfaces: the hover `···` and a right-click
   * on the row itself. Both menus draw the same items — a row's actions should
   * not depend on which gesture found them.
   */
  const menuItems = (Item: typeof DropdownMenuItem) => (
    <>
      <Item
        onSelect={() => {
          setDraft(props.title);
          setEditing(true);
        }}
      >
        <Icon name="pencil" class="size-3.5 text-muted-foreground" />
        {t("sidebar.session.rename")}
      </Item>
      <Item onSelect={() => props.onTogglePin()}>
        {/* The item is one action, so the icon says which action: a pin that
            is already in means the click takes it out. */}
        <Icon name={props.pinned ? "unpin" : "pin"} class="size-3.5 text-muted-foreground" />
        {t(props.pinned ? "sidebar.session.unpin" : "sidebar.session.pin")}
      </Item>
      {/* Compare belongs on the session rather than behind a global
          toggle: a comparison always starts from one of the two, so
          asking the list to enter a mode first made the user name a
          session before they could start. */}
      <Show when={props.onSplitOpen}>
        <Item onSelect={() => props.onSplitOpen?.()}>
          <Icon name="split-row" class="size-3.5 text-muted-foreground" />
          {t("pane.split.right")}
        </Item>
      </Show>
      <Item onSelect={props.onCompare}>
        <Icon name="columns" class="size-3.5 text-muted-foreground" />
        {t("sidebar.session.compare")}
      </Item>
      <Item onSelect={() => void props.onArchive()}>
        <Icon name="archive" class="size-3.5 text-muted-foreground" />
        {t("sidebar.session.archive")}
      </Item>
    </>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger class="contents" disabled={editing()}>
        <ListRow
          active={props.active}
          onOpen={props.onOpen}
          disabled={editing()}
          onMouseEnter={() => setHot(true)}
          onMouseLeave={() => setHot(false)}
          class="hover:bg-accent/70"
        >
          {/* The one place a row says what state it is in. It used to be a
              six-pixel dot that only appeared while busy — no word, no name for a
              screen reader — plus a badge that existed only for pending input, so
              a session that had ended in an error drew exactly what a session that
              had ended cleanly drew: nothing. `sessionStatus()` decides, this
              draws. */}
          <SessionStatusMark status={props.status} />
          {/* Before the title, not after it: the title reserves its right padding
              for the timestamp, which is absolutely positioned over the end of the
              row, and a badge placed after the title lands on top of it. Left of
              the title it also reads as what it is — row metadata, like the status
              dot, rather than part of the session's name.
              A native title on its own span: the session title is pointer-events-none
              by design so the row's own hover label is the one that shows. */}
          <Show when={props.instance && !editing()}>
            <span
              class="shrink-0 rounded bg-secondary/70 px-1 font-mono text-2xs leading-none text-muted-foreground"
              title={props.instance!.tip}
            >
              {props.instance!.short}
            </span>
          </Show>
          <Show when={props.pinned && !editing()}>
            <Icon name="pin" class="size-3 shrink-0 text-muted-foreground/70" />
          </Show>
          <Show
            when={editing()}
            fallback={<span class="min-w-0 flex-1 truncate pr-[4.75rem] text-sm leading-none">{props.title}</span>}
          >
            <input
              ref={(el) => {
                input = el;
                el.focus();
                el.select();
              }}
              class="min-w-0 flex-1 rounded bg-background px-1 py-0.5 text-sm leading-none focus:outline-none"
              value={draft()}
              onClick={(e) => e.stopPropagation()}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") void commit();
                if (e.key === "Escape") setEditing(false);
              }}
              onBlur={() => void commit()}
            />
          </Show>
          <Show when={!editing()}>
            {/* No title here: the span is pointer-events-none, so a native tooltip
                could never surface. The row's own hover covers it. */}
            <span
              class={`pointer-events-none absolute right-2 top-1/2 w-[4.5rem] -translate-y-1/2 text-right text-2xs text-muted-foreground tabular-nums ${
                reveal() ? "invisible" : ""
              }`}
            >
              {props.time}
            </span>
            <DropdownMenu placement="bottom-end" open={menuOpen()} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger
                class={`absolute right-1 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground ${
                  reveal() ? "" : "invisible pointer-events-none"
                }`}
                aria-label={t("sidebar.session.actions")}
                data-row-menu=""
                tabIndex={reveal() ? 0 : -1}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                <Icon name="more" class="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent class="min-w-40">
                {menuItems(DropdownMenuItem)}
              </DropdownMenuContent>
            </DropdownMenu>
          </Show>
        </ListRow>
      </ContextMenuTrigger>
      <ContextMenuContent class="min-w-40">
        {menuItems(ContextMenuItem as unknown as typeof DropdownMenuItem)}
      </ContextMenuContent>
    </ContextMenu>
  );
}
