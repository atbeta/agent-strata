import { createResource, createSignal, For, Show } from "solid-js";
import { listFiles, openInEditor, readFileBody, type FileNode } from "./api";
import { t } from "./i18n";
import { Code } from "./payload";

const PREVIEW_LIMIT = 200_000;

function sortNodes(nodes: FileNode[]): FileNode[] {
  return nodes
    .filter((n) => !n.ignored)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

function Branch(props: {
  sessionId: string;
  path: string;
  depth: number;
  selected: () => string | null;
  onOpen: (node: FileNode) => void;
}) {
  const [open, setOpen] = createSignal(props.depth === 0);
  const [kids] = createResource(
    () => (open() ? props.path : false),
    (path) => listFiles(props.sessionId, path).then((list) => sortNodes(list ?? [])),
  );

  return (
    <Show
      when={props.depth > 0}
      fallback={
        <NodeList
          sessionId={props.sessionId}
          depth={0}
          nodes={kids() ?? []}
          loading={kids.loading}
          error={kids.error}
          selected={props.selected}
          onOpen={props.onOpen}
        />
      }
    >
      <li>
        <button
          type="button"
          class="flex w-full items-center gap-1 rounded-md px-1 py-0.5 text-left text-sm hover:bg-secondary"
          style={{ "padding-left": `${props.depth * 12}px` }}
          aria-expanded={open()}
          onClick={() => setOpen((v) => !v)}
        >
          <span class="w-3 shrink-0 text-2xs text-muted-foreground">{open() ? "▾" : "▸"}</span>
          <span class="truncate">{props.path.split(/[/\\]/).filter(Boolean).at(-1)}</span>
        </button>
        <Show when={open()}>
          <NodeList
            sessionId={props.sessionId}
            depth={props.depth}
            nodes={kids() ?? []}
            loading={kids.loading}
            error={kids.error}
            selected={props.selected}
            onOpen={props.onOpen}
          />
        </Show>
      </li>
    </Show>
  );
}

function NodeList(props: {
  sessionId: string;
  depth: number;
  nodes: FileNode[];
  loading: boolean;
  error: unknown;
  selected: () => string | null;
  onOpen: (node: FileNode) => void;
}) {
  return (
    <>
      <Show when={props.loading}>
        <p class="px-2 py-1 text-xs text-muted-foreground" style={{ "padding-left": `${(props.depth + 1) * 12}px` }}>
          {t("files.loading")}
        </p>
      </Show>
      <Show when={props.error}>
        <p class="px-2 py-1 text-xs text-destructive">{t("files.listErr")}</p>
      </Show>
      <ul>
        <For each={props.nodes}>
          {(node) => (
            <Show
              when={node.type === "directory"}
              fallback={
                <li>
                  <button
                    type="button"
                    class={`block w-full truncate rounded-md px-1 py-0.5 text-left text-sm hover:bg-secondary ${
                      props.selected() === node.path ? "bg-secondary" : ""
                    }`}
                    style={{ "padding-left": `${(props.depth + 1) * 12 + 16}px` }}
                    onClick={() => props.onOpen(node)}
                  >
                    {node.name}
                  </button>
                </li>
              }
            >
              <Branch
                sessionId={props.sessionId}
                path={node.path}
                depth={props.depth + 1}
                selected={props.selected}
                onOpen={props.onOpen}
              />
            </Show>
          )}
        </For>
      </ul>
    </>
  );
}

/** The session workspace as a tree, with the selected file beside it. */
export function FileBrowser(props: { sessionId: string }) {
  const [selected, setSelected] = createSignal<FileNode | null>(null);
  const [openErr, setOpenErr] = createSignal("");
  const [body] = createResource(
    () => {
      const node = selected();
      return node && node.type === "file" ? { id: props.sessionId, path: node.path } : false;
    },
    (key) => readFileBody(key.id, key.path),
  );

  const openInVsCode = async () => {
    const node = selected();
    if (!node) return;
    setOpenErr("");
    try {
      await openInEditor("vscode", node.absolute);
    } catch (e) {
      setOpenErr(e instanceof Error ? e.message : String(e));
    }
  };

  const text = () => {
    const value = body();
    if (!value || value.type !== "text") return "";
    return value.content.length > PREVIEW_LIMIT ? value.content.slice(0, PREVIEW_LIMIT) : value.content;
  };

  return (
    <div class="@container flex min-h-0 flex-1 flex-col">
      <div class="flex min-h-0 min-w-0 flex-1 flex-col @min-[560px]:flex-row">
        <div class="max-h-[40%] shrink-0 overflow-auto border-b border-border py-2 @min-[560px]:max-h-none @min-[560px]:w-56 @min-[560px]:border-b-0 @min-[560px]:border-r">
          <Branch sessionId={props.sessionId} path="" depth={0} selected={() => selected()?.path ?? null} onOpen={setSelected} />
        </div>
        <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        <Show
          when={selected()}
          fallback={<p class="px-3 py-3 text-xs text-muted-foreground">{t("files.pick")}</p>}
        >
          {(node) => (
            <>
              <div class="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-2">
                <span class="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground" title={node().absolute}>
                  {node().path}
                </span>
                <button
                  type="button"
                  class="rounded-md px-1.5 py-0.5 text-2xs text-muted-foreground hover:bg-secondary hover:text-foreground"
                  onClick={() => void openInVsCode()}
                >
                  {t("files.vscode")}
                </button>
              </div>
              <Show when={openErr()}>
                <p class="px-3 py-1 text-xs text-destructive">{openErr()}</p>
              </Show>
              <div class="min-h-0 flex-1 overflow-auto px-3 py-2">
                <Show when={body.loading}>
                  <p class="text-xs text-muted-foreground">{t("files.loading")}</p>
                </Show>
                <Show when={body.error}>
                  <p class="text-xs text-destructive">{t("files.readErr")}</p>
                </Show>
                <Show when={!body.loading && body()?.type === "binary"}>
                  <p class="text-xs text-muted-foreground">{t("files.binary")}</p>
                </Show>
                <Show when={!body.loading && body()?.type === "text"}>
                  <Code source={text()} label={node().name} maxHeight="max-h-none" />
                  <Show when={(body()?.content.length ?? 0) > PREVIEW_LIMIT}>
                    <p class="mt-2 text-xs text-muted-foreground">{t("files.truncated")}</p>
                  </Show>
                </Show>
              </div>
            </>
          )}
        </Show>
        </div>
      </div>
    </div>
  );
}
