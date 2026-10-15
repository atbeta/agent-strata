import { createResource, createSignal, For, Show } from "solid-js";
import { getJson, type SessionRow } from "./api";
import { settled } from "./resource";
import { projectName } from "./fleet";
import { t, tn } from "./i18n";
import { Icon } from "./icons";
import { Tip } from "./tip";
import { cn } from "./lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TextField, TextFieldInput, TextFieldLabel } from "@/components/ui/text-field";

const WS_KEY = "strata.workspace";
export const ALL_WORKSPACES = "__all__";

function parentPath(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 1) return path;
  const parent = parts.slice(0, -1).join("/");
  return path.startsWith("\\") ? parent : path.startsWith("/") ? `/${parent}` : parent;
}

function projectHint(path: string): string {
  if (path === "/" || path === "\\") return t("project.rootHint");
  const parent = parentPath(path);
  return parent === path ? path : parent;
}

/**
 * The workspace the sidebar scopes to: the persisted pick, the dropdown's
 * open/draft state, and the directory list from /workspaces merged with
 * directories the session list already mentions.
 */
export function useWorkspace() {
  const [workspace, setWorkspace] = createSignal<string | null>(localStorage.getItem(WS_KEY));
  const [wsOpen, setWsOpen] = createSignal(false);
  const [wsDraft, setWsDraft] = createSignal("");
  const [wsList, { refetch: refetchWs }] = createResource(() =>
    getJson<{ workspaces: { directory: string; name?: string }[] }>("/workspaces"),
  );

  const currentDir = () => {
    const w = workspace();
    if (!w || w === ALL_WORKSPACES) return undefined;
    return w;
  };

  const chooseWorkspace = (dir: string) => {
    setWorkspace(dir);
    localStorage.setItem(WS_KEY, dir);
    setWsOpen(false);
    setWsDraft("");
  };

  /**
   * The picker's directories: the current scope first so it never vanishes,
   * then what the service reports, then anywhere an existing session lives.
   */
  const workspaceOptions = (rows: SessionRow[], workspaceOf: (s: SessionRow) => string | undefined) => {
    const map = new Map<string, string>();
    const cur = currentDir();
    if (cur) map.set(cur, projectName(cur));
    for (const w of settled(wsList)?.workspaces ?? []) {
      if (w.directory) map.set(w.directory, w.name || projectName(w.directory));
    }
    for (const s of rows) {
      const ws = workspaceOf(s);
      if (ws && !map.has(ws)) map.set(ws, projectName(ws));
    }
    return [...map.entries()].map(([directory, name]) => ({ directory, name }));
  };

  return {
    workspace,
    currentDir,
    chooseWorkspace,
    wsOpen,
    setWsOpen,
    wsDraft,
    setWsDraft,
    wsList,
    refetchWs,
    workspaceOptions,
  };
}

export type WorkspaceCtl = ReturnType<typeof useWorkspace>;

/** The project picker at the top of the sidebar, plus the action error line. */
export function WorkspacePicker(props: {
  ws: WorkspaceCtl;
  sessionCount: number;
  options: () => { directory: string; name: string }[];
  actionErr: string;
}) {
  const ws = () => props.ws;
  return (
    <div class="flex flex-col gap-2 px-3 pt-2 pb-3">
      <div>
        <p class="mb-1 px-0.5 text-2xs font-medium text-muted-foreground">
          {t("sidebar.project.label")}
        </p>
        <DropdownMenu open={ws().wsOpen()} onOpenChange={ws().setWsOpen} gutter={6}>
          <Tip label={ws().currentDir() ?? t("sidebar.project.all")} class="w-full">
            <DropdownMenuTrigger
              class={cn(
                "flex w-full items-center gap-2 rounded-md border border-border bg-secondary/40 px-2 py-1.5 text-left transition-colors hover:bg-secondary",
                ws().wsOpen() && "bg-secondary",
              )}
            >
              <span class="grid size-7 shrink-0 place-items-center rounded-md bg-secondary text-muted-foreground">
                <Icon name="folder" class="size-3.5" />
              </span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-medium leading-tight">
                  {ws().currentDir() ? projectName(ws().currentDir()!) : t("sidebar.project.all")}
                </span>
                <span class="block truncate font-mono text-2xs leading-tight text-muted-foreground">
                  {ws().currentDir()
                    ? projectHint(ws().currentDir()!)
                    : tn("sidebar.sessionCount", props.sessionCount)}
                </span>
              </span>
              <Icon
                name="chevron"
                class={cn("size-3.5 shrink-0 text-muted-foreground", ws().wsOpen() && "rotate-180")}
              />
            </DropdownMenuTrigger>
          </Tip>
          <DropdownMenuContent class="max-h-80 w-[276px] overflow-y-auto">
            <DropdownMenuItem
              class={cn("flex-col items-start gap-0", !ws().currentDir() && "bg-accent")}
              onSelect={() => ws().chooseWorkspace(ALL_WORKSPACES)}
            >
              <span class="font-medium">{t("sidebar.project.all")}</span>
              <span class="text-2xs text-muted-foreground">{t("sidebar.project.allHint")}</span>
            </DropdownMenuItem>
            <For each={props.options()}>
              {(w) => (
                <DropdownMenuItem
                  class={cn("flex-col items-start gap-0", ws().currentDir() === w.directory && "bg-accent")}
                  title={w.directory}
                  onSelect={() => ws().chooseWorkspace(w.directory)}
                >
                  <span class="w-full truncate">{w.name}</span>
                  <span class="w-full truncate font-mono text-2xs text-muted-foreground">{w.directory}</span>
                </DropdownMenuItem>
              )}
            </For>
            <DropdownMenuSeparator />
            <form
              class="px-2 py-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                const path = ws().wsDraft().trim();
                if (path) ws().chooseWorkspace(path);
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <TextField>
                <TextFieldLabel class="text-2xs font-medium text-muted-foreground">
                  {t("sidebar.project.openDirectory")}
                </TextFieldLabel>
                <TextFieldInput
                  size="sm"
                  mono
                  value={ws().wsDraft()}
                  onChange={ws().setWsDraft}
                  class="bg-background text-2xs"
                  placeholder="/path/to/project"
                  onKeyDown={(e) => e.stopPropagation()}
                />
              </TextField>
            </form>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Show when={props.actionErr}>
        <p class="truncate font-mono text-2xs text-destructive" title={props.actionErr}>
          {props.actionErr}
        </p>
      </Show>
    </div>
  );
}
