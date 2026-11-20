import { For, Show } from "solid-js";
import type { SessionView } from "./api";
import { DiffBlock } from "./diff";
import { ChangeFileRow } from "./change-file-row";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Icon } from "./icons";
import { Tip } from "./tip";
import { num, t, tn } from "./i18n";

export function SessionChangesPanel(props: {
  files: () => SessionView["files_changed"];
  openFile: () => string | null;
  onOpenFile: (path: string | null) => void;
  onJumpToTurn: (turnIndex: number) => void;
}) {
  const openFile = props.openFile;
  const setOpenFile = props.onOpenFile;
  const open = () => props.files().find((file) => file.path === openFile()) ?? null;
  const toggleFile = (path: string) => setOpenFile(openFile() === path ? null : path);

  return (
    <div class="@container flex min-h-0 flex-1 flex-col">
      <div class="flex min-h-0 flex-1 flex-col @min-[560px]:flex-row">
      <div
        class={`min-h-0 overflow-x-hidden overflow-y-auto px-2 py-3 ${
          open()
            ? "max-h-[40%] shrink-0 border-b border-border @min-[560px]:max-h-none @min-[560px]:w-[clamp(200px,30%,280px)] @min-[560px]:border-b-0 @min-[560px]:border-r"
            : "w-full px-3"
        }`}
      >
        <Show
          when={props.files().length > 0}
          fallback={<EmptyState icon="branch" class="py-12" title={t("rail.nothing")} />}
        >
          <ul class="space-y-0.5">
            <For each={props.files()}>
              {(file) => (
                <li>
                  <ChangeFileRow
                    path={file.path}
                    change={file.change}
                    selected={openFile() === file.path}
                    expanded={openFile() === file.path}
                    changeCount={file.count}
                    additions={file.additions}
                    deletions={file.deletions}
                    unexplained={file.unexplained}
                    onClick={() => toggleFile(file.path)}
                  />
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
      <Show when={open()}>
        {(file) => (
          <div class="flex min-h-0 min-w-0 flex-1 flex-col">
            <div class="flex shrink-0 items-start gap-2 border-b border-border px-3 py-2">
              <span class="min-w-0 flex-1 break-words font-mono text-2xs text-muted-foreground">
                {file().path}
              </span>
              <Tip label={t("file.close")}>
                <Button
                  type="button"
                  variant="icon"
                  size="icon-xs"
                  class="shrink-0"
                  aria-label={t("file.close")}
                  onClick={() => setOpenFile(null)}
                >
                  <Icon name="x" />
                </Button>
              </Tip>
            </div>
            <div class="min-h-0 flex-1 overflow-x-auto overflow-y-auto px-3 py-2">
              <Show when={file().unexplained}>
                <p class="mb-2 rounded-md bg-secondary/60 px-2 py-1.5 text-2xs text-muted-foreground">
                  {tn("file.hidden", file().edits.filter((edit) => !edit.diff).length)}
                </p>
              </Show>
              <For each={file().edits}>
                {(edit) => (
                  <section class="mb-3 last:mb-0">
                    <div class="sticky left-0 mb-1 flex w-max items-center gap-2 bg-background">
                      <span class="rounded-sm bg-secondary px-1.5 py-0.5 text-2xs text-muted-foreground">
                        {edit.whole_file ? t("file.whole") : t("file.region")}
                      </span>
                      <Show when={edit.additions > 0 || edit.deletions > 0}>
                        <span class="font-mono text-2xs tabular-nums">
                          <span class="text-diff-add-fg">+{num(edit.additions)}</span>{" "}
                          <span class="text-diff-del-fg">−{num(edit.deletions)}</span>
                        </span>
                      </Show>
                      <Show when={edit.turn_index >= 0}>
                        <Button
                          type="button"
                          variant="icon"
                          size="xs"
                          class="ml-auto shrink-0 rounded-sm px-1.5"
                          onClick={() => props.onJumpToTurn(edit.turn_index)}
                        >
                          {t("file.jump")}
                        </Button>
                      </Show>
                    </div>
                    <Show
                      when={edit.diff}
                      fallback={
                        <p class="rounded-md bg-secondary/60 px-2 py-1.5 text-2xs text-muted-foreground">
                          {t("file.noDiff")}
                        </p>
                      }
                    >
                      <DiffBlock patch={edit.diff!} />
                    </Show>
                  </section>
                )}
              </For>
            </div>
          </div>
        )}
      </Show>
      </div>
    </div>
  );
}
