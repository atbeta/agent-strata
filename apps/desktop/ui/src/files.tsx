import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js";
import { listFiles, openInEditor, readFileBody, type FileNode } from "./api";
import { t } from "./i18n";
import { explain, fadeSignal } from "./errors";
import { PathActions, resolveTarget, revealResolved, type PathApi } from "./path-link";
import { Code } from "./payload";
import { RowButton } from "@/components/ui/row-button";
import { Button } from "@/components/ui/button";
import { MiniTabs } from "@/components/ui/mini-tabs";
import { Icon } from "./icons";
import { FileTypeIcon } from "./file-icon";
import { filePreview } from "./file-preview";
import { openImage } from "./image-viewer";
import { Md } from "./md";

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
  /** the path a click asked for — ancestors open so it can mount */
  focus?: () => string | undefined;
}) {
  const [open, setOpen] = createSignal(props.depth === 0);
  // The focus path and the selector both read POSIX separators; a Windows
  // backend hands back `\`, so this branch's own name is normalised once.
  const mine = () => props.path.replace(/\\/g, "/");
  // Each level asks the same question — is the focused path inside me — and
  // the cascade fetches its way down to the row.
  createEffect(() => {
    const f = props.focus?.();
    if (f !== undefined && mine() !== "" && (f === mine() || f.startsWith(`${mine()}/`))) {
      setOpen(true);
    }
  });
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
          focus={props.focus}
        />
      }
    >
      <li data-fpath={mine()}>
        <RowButton
          class="gap-1.5 px-1 py-0.5 hover:bg-secondary"
          style={{ "padding-left": `${props.depth * 12}px` }}
          aria-expanded={open()}
          onClick={() => setOpen((v) => !v)}
        >
          <span aria-hidden="true" class="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground/65">
            <Icon name={open() ? "chevron" : "chevron-right"} class="size-3.5" />
          </span>
          <span class="truncate">{props.path.split(/[/\\]/).filter(Boolean).at(-1)}</span>
        </RowButton>
        <Show when={open()}>
          <NodeList
            sessionId={props.sessionId}
            depth={props.depth}
            nodes={kids() ?? []}
            loading={kids.loading}
            error={kids.error}
            selected={props.selected}
            onOpen={props.onOpen}
            focus={props.focus}
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
  focus?: () => string | undefined;
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
      <Show when={!props.loading && !props.error && props.nodes.length === 0}>
        <p class="px-2 py-1 text-xs text-muted-foreground" style={{ "padding-left": `${(props.depth + 1) * 12}px` }}>
          {t("files.empty")}
        </p>
      </Show>
      <ul>
        <For each={props.nodes}>
          {(node) => (
            <Show
              when={node.type === "directory"}
              fallback={
                <li data-fpath={node.path.replace(/\\/g, "/")}>
                  <RowButton
                    class={`gap-1.5 px-1 py-0.5 hover:bg-secondary ${
                      props.selected() === node.path ? "bg-secondary" : ""
                    }`}
                    style={{ "padding-left": `${(props.depth + 1) * 12 + 22}px` }}
                    onClick={() => props.onOpen(node)}
                  >
                    <FileTypeIcon name={node.name} />
                    <span class="truncate">{node.name}</span>
                  </RowButton>
                </li>
              }
            >
              <Branch
                sessionId={props.sessionId}
                path={node.path}
                depth={props.depth + 1}
                selected={props.selected}
                onOpen={props.onOpen}
                focus={props.focus}
              />
            </Show>
          )}
        </For>
      </ul>
    </>
  );
}

/** The session workspace as a tree, with the selected file beside it. */
export function FileBrowser(props: {
  sessionId: string;
  /** the session's workspace — anchors relative paths in file previews */
  workspace?: () => string | undefined;
  /** a path the reader clicked elsewhere — expand the tree to it and select it */
  focus?: () => { path: string; n: number } | undefined;
}) {
  const [selected, setSelected] = createSignal<FileNode | null>(null);
  const [mode, setMode] = createSignal<"preview" | "source">("preview");
  const [openErr, setOpenErr] = fadeSignal("");
  /** The path ancestors compare themselves against to know they should open. */
  const [treeFocus, setTreeFocus] = createSignal<string>();
  let browserEl: HTMLDivElement | undefined;

  createEffect(() => {
    const f = props.focus?.();
    if (f) void focusPath(f.path);
  });

  /** One parent listing answers both of a click's questions — is the path
   *  there, and is it a file or a folder. */
  const focusPath = async (path: string) => {
    const rel = path.replace(/\/+$/, "");
    if (rel === "") {
      setTreeFocus("");
      return;
    }
    const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const siblings = await listFiles(props.sessionId, parent).catch(() => undefined);
    const node = siblings?.find((n) => n.path.replace(/\\/g, "/") === rel);
    if (!node) {
      setOpenErr(t("path.missing"));
      return;
    }
    // A folder opens to itself; a file's parent opens and the file selects.
    setTreeFocus(node.type === "directory" ? rel : parent);
    choose(node);
    // The row exists only after the last ancestor's fetch lands — check for
    // it a few beats rather than guessing a single delay.
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const el = browserEl?.querySelector(`[data-fpath="${CSS.escape(rel)}"]`);
      if (el) {
        el.scrollIntoView({ block: "nearest" });
        break;
      }
    }
  };
  const [body] = createResource(
    () => {
      const node = selected();
      return node && node.type === "file" ? { id: props.sessionId, path: node.path } : false;
    },
    (key) => readFileBody(key.id, key.path),
  );
  const preview = createMemo(() => {
    const node = selected();
    const value = body();
    return node && value ? filePreview(node.name, value) : undefined;
  });
  const binaryPreview = createMemo(() => {
    const value = preview();
    return value?.kind === "binary" ? value : undefined;
  });
  const imagePreview = createMemo(() => {
    const value = preview();
    return value?.kind === "image" ? value : undefined;
  });
  const choose = (node: FileNode) => {
    setSelected(node);
    setMode("preview");
  };

  const openInVsCode = async () => {
    const node = selected();
    if (!node) return;
    setOpenErr("");
    try {
      await openInEditor("vscode", node.absolute);
    } catch (e) {
      setOpenErr(explain(e));
    }
  };

  const text = () => {
    const value = body();
    if (!value || value.type !== "text") return "";
    return value.content.length > PREVIEW_LIMIT ? value.content.slice(0, PREVIEW_LIMIT) : value.content;
  };

  /** Paths inside a preview resolve against this same browser — opening one
   *  just focuses it here; the file manager covers what is outside. */
  const pathApi: PathApi = {
    open: (raw) => {
      const target = resolveTarget(raw, props.workspace?.());
      if (target.rel !== undefined) {
        void focusPath(target.rel);
        return;
      }
      if (target.abs !== undefined) {
        void revealResolved(raw, props.workspace?.()).catch((e) => setOpenErr(explain(e)));
        return;
      }
      setOpenErr(t("path.missing"));
    },
    revealable: (raw) => resolveTarget(raw, props.workspace?.()).abs !== undefined,
    reveal: (raw) => {
      void revealResolved(raw, props.workspace?.()).catch((e) => setOpenErr(explain(e)));
    },
    workspace: () => props.workspace?.(),
  };

  return (
    <PathActions.Provider value={pathApi}>
    <div class="@container flex min-h-0 flex-1 flex-col" ref={(el) => (browserEl = el)}>
      <div class="flex min-h-0 min-w-0 flex-1 flex-col @min-[560px]:flex-row">
        <div class="max-h-[40%] shrink-0 overflow-auto border-b border-border py-2 @min-[560px]:max-h-none @min-[560px]:w-56 @min-[560px]:border-b-0 @min-[560px]:border-r">
          <Branch sessionId={props.sessionId} path="" depth={0} selected={() => selected()?.path ?? null} onOpen={choose} focus={treeFocus} />
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
                  <Show when={preview()?.kind === "html" || preview()?.kind === "markdown"}>
                    <MiniTabs
                      kind="radio"
                      label={t("files.preview")}
                      value={mode()}
                      options={[
                        { id: "preview", label: t("files.preview") },
                        { id: "source", label: t("files.source") },
                      ]}
                      onChange={(id) => setMode(id as "preview" | "source")}
                    />
                  </Show>
                  <Button
                    type="button"
                    variant="icon"
                    size="xs"
                    class="px-1.5"
                    onClick={() => void openInVsCode()}
                  >
                    {t("files.vscode")}
                  </Button>
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
                  <Show when={!body.loading && !body.error && !body()}>
                    <p class="text-xs text-muted-foreground">{t("files.emptyBody")}</p>
                  </Show>
                  <Show when={!body.loading && binaryPreview()}>
                    {(binary) => (
                      <p class="text-xs text-muted-foreground">
                        {t(binary().oversized ? "files.imageTooLarge" : "files.binary")}
                      </p>
                    )}
                  </Show>
                  <Show when={imagePreview()}>
                    {(image) => (
                      <Button
                        type="button"
                        variant="quiet"
                        class="h-auto max-w-full cursor-zoom-in rounded-md border border-border bg-code-surface p-2"
                        onClick={() => openImage(image().url, node().name)}
                      >
                        <img class="max-h-[70vh] max-w-full object-contain" src={image().url} alt={node().name} />
                      </Button>
                    )}
                  </Show>
                  <Show
                    when={
                      (preview()?.kind === "html" || preview()?.kind === "markdown") && mode() === "preview"
                    }
                  >
                    <Show
                      when={preview()?.kind === "html"}
                      fallback={<Md text={text()} class="rounded-md border border-border bg-card p-4" />}
                    >
                      <iframe
                        class="h-full min-h-72 w-full rounded-md border border-border bg-white"
                        srcdoc={text()}
                        sandbox=""
                        title={node().name}
                      />
                    </Show>
                  </Show>
                  <Show when={preview()?.kind === "code" || mode() === "source"}>
                    <Code source={text()} label={node().name} maxHeight="max-h-none" />
                  </Show>
                  <Show
                    when={
                      body()?.type === "text" &&
                      (preview()?.kind === "code" || mode() === "source") &&
                      (body()?.content.length ?? 0) > PREVIEW_LIMIT
                    }
                  >
                    <p class="mt-2 text-xs text-muted-foreground">{t("files.truncated")}</p>
                  </Show>
                </div>
              </>
            )}
          </Show>
        </div>
      </div>
    </div>
    </PathActions.Provider>
  );
}
