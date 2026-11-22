import { createEffect, createSignal, Show } from "solid-js";
import { Icon } from "./icons";
import { t } from "./i18n";
import type { SessionStatus } from "./session-status";
import { SessionStatusMark } from "@/components/ui/session-status";
import { ShellMark } from "./shell-mark";
import { ListRow } from "@/components/ui/list-row";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

export function SessionListItem(props: {
  id: string;
  title: string;
  active: boolean;
  status: SessionStatus;
  time: string;
  onOpen: () => void;
  onRename: (title: string) => Promise<void>;
  onArchive: () => Promise<void>;
  onDelete: () => void;
  /** Whether the row sits in the pinned group; the menu reads one of two words. */
  pinned: boolean;
  onTogglePin: () => void;
  /**
   * Open the usage-compare picker with this session already chosen.
   * Absent when there is no second session to pick.
   */
  onCompare?: () => void;
  /** Open this session in a side-by-side split pane. */
  onSplitOpen?: () => void;
  /**
   * Which server this session lives on, set only while one backend kind has
   * more than one instance connected.
   */
  instance?: { short: string; tip: string };
  /** A server the shell has not exited. */
  shell?: { command: string; detail: string };
}) {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal(props.title);
  const [hot, setHot] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  // Pointer hover is immediate; group-focus-within below offers the same control
  // to keyboard navigation. An open portal menu also counts as staying on the row.
  const reveal = () => hot() || menuOpen();

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
  const menuItems = (Item: typeof DropdownMenuItem, Separator: typeof DropdownMenuSeparator) => (
    <>
      <Item
        onSelect={() => {
          setDraft(props.title);
          setEditing(true);
        }}
      >
        <Icon name="square-pen" class="size-3.5 text-muted-foreground" />
        {t("sidebar.session.rename")}
      </Item>
      <Item onSelect={() => props.onTogglePin()}>
        {/* The item is one action, so the icon says which action: a pin that
            is already in means the click takes it out. */}
        <Icon name={props.pinned ? "unpin" : "pin"} class="size-3.5 rotate-45 text-muted-foreground" />
        {t(props.pinned ? "sidebar.session.unpin" : "sidebar.session.pin")}
      </Item>
      <Show when={props.onSplitOpen}>
        <Item onSelect={() => props.onSplitOpen?.()}>
          <Icon name="split-row" class="size-3.5 text-muted-foreground" />
          {t("pane.split.right")}
        </Item>
      </Show>
      {/* Usage compare stays behind the session, and only once another
          session exists. It used to be a mode of the whole list. */}
      <Show when={props.onCompare}>
        <Item onSelect={() => props.onCompare?.()}>
          <Icon name="compare" class="size-3.5 text-muted-foreground" />
          {t("sidebar.session.compare")}
        </Item>
      </Show>
      <Separator />
      <Item onSelect={() => void props.onArchive()}>
        <Icon name="archive" class="size-3.5 text-muted-foreground" />
        {t("sidebar.session.archive")}
      </Item>
      <Item class="text-destructive" onSelect={() => props.onDelete()}>
        <Icon name="trash" class="size-3.5" />
        {t("sidebar.session.delete")}
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
          class="group"
        >
          {/* The one place a row says what state it is in. It used to be a
              six-pixel dot that only appeared while busy — no word, no name for a
              screen reader — plus a badge that existed only for pending input, so
              a session that had ended in an error drew exactly what a session that
              had ended cleanly drew: nothing. `sessionStatus()` decides, this
              draws. */}
          <SessionStatusMark status={props.status} />
          <Show when={props.shell}>
            {(shell) => <ShellMark command={shell().command} detail={shell().detail} />}
          </Show>
          {/* Before the title, not after it: the title reserves its right padding
              for the timestamp, which is absolutely positioned over the end of the
              row, and a badge placed after the title lands on top of it. Left of
              the title it also reads as what it is — row metadata, like the status
              dot, rather than part of the session's name.
              A native title on its own span: the session title is pointer-events-none
              by design so the row's own hover label is the one that shows. */}
          <Show when={props.instance && !editing()}>
            <span
              class="shrink-0 rounded-sm bg-secondary/70 px-1 font-mono text-2xs leading-none text-muted-foreground"
              title={props.instance!.tip}
            >
              {props.instance!.short}
            </span>
          </Show>
          <Show when={props.pinned && !editing()}>
            <Icon name="pin" class="size-3 shrink-0 rotate-45 text-muted-foreground" />
          </Show>
          <Show
            when={editing()}
            fallback={<span class="min-w-0 flex-1 truncate pr-[4.75rem] text-sm leading-none">{props.title}</span>}
          >
            <input
              ref={(el) => {
                el.focus();
                el.select();
              }}
              class="min-w-0 flex-1 rounded-sm bg-background px-1 py-0.5 text-sm leading-none focus:outline-none"
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
              class={`pointer-events-none absolute right-2 top-1/2 w-[4.5rem] -translate-y-1/2 text-right text-2xs text-faint-foreground tabular-nums group-focus-within:invisible ${
                reveal() ? "invisible" : ""
              }`}
            >
              {props.time}
            </span>
            <DropdownMenu placement="bottom-end" open={menuOpen()} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger
                variant="icon"
                size="icon-xs"
                class={`absolute right-1 top-1/2 -translate-y-1/2 hover:bg-background ${
                  reveal()
                    ? ""
                    : "invisible pointer-events-none group-focus-within:visible group-focus-within:pointer-events-auto"
                }`}
                aria-label={t("sidebar.session.actions")}
                data-row-menu=""
                tabIndex={0}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                <Icon name="more" class="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent class="min-w-40">
                {menuItems(DropdownMenuItem, DropdownMenuSeparator)}
              </DropdownMenuContent>
            </DropdownMenu>
          </Show>
        </ListRow>
      </ContextMenuTrigger>
      <ContextMenuContent class="min-w-40">
        {menuItems(
          ContextMenuItem as unknown as typeof DropdownMenuItem,
          ContextMenuSeparator as unknown as typeof DropdownMenuSeparator,
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
