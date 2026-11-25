import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { TextFieldInput } from "@/components/ui/text-field";
import {
  createManagedSkill,
  deleteManagedSkill,
  folderLabel,
  listManagedSkills,
  listSkillWorkspaces,
  openInEditor,
  revealPath,
  updateManagedSkill,
  type ManagedSkill,
} from "./api";
import { explain as errorText, fadeSignal } from "./errors";
import { t } from "./i18n";
import { Icon } from "./icons";
import { Tip } from "./tip";
import type { ConnectionsCtl } from "./use-connections";
import { connectionName } from "./connection-name";
import { Card, Group, Row, Segmented, pickerTrigger } from "./settings-blocks";
import { SkillDetail } from "./skill-detail";
import { SKILL_SOURCE_LABEL, skillStatusLabel } from "./skill-display";
import { SkillEditor, validSkillId, type SkillEditorState } from "./skill-editor";

type EditorState = SkillEditorState;
type ScopeFilter = "all" | "global" | "project";

export const SKILL_REFRESH_MS = 5_000;

export function SkillSettings(props: { conns: ConnectionsCtl; skillId?: string }) {
  const connections = () =>
    (props.conns.conns.latest?.connections ?? []).filter(
      (connection) => connection.backend === "opencode" && connection.capabilities?.extension === "opencode",
    );
  const [connectionChoice, setConnectionChoice] = createSignal("");
  const [editor, setEditor] = createSignal<EditorState>();
  const [editorOriginal, setEditorOriginal] = createSignal("");
  const [pendingEditorAction, setPendingEditorAction] = createSignal<() => void>();
  const connectionId = createMemo(() => {
    const pinned = editor()?.connectionId;
    if (pinned) return pinned;
    return connections().find((connection) => connection.id === connectionChoice())?.id ?? connections()[0]?.id ?? "";
  });
  const connection = () => connections().find((item) => item.id === connectionId());
  const [workspaceChoice, setWorkspaceChoice] = createSignal("");
  const [targets, { refetch: refetchTargets }] = createResource(connectionId, (id) =>
    id ? listSkillWorkspaces(id) : Promise.resolve(undefined),
  );
  const currentTargets = () => (targets.latest?.connection.id === connectionId() ? targets.latest : undefined);
  const workspaces = createMemo(() =>
    [...(currentTargets()?.workspaces ?? [])].sort((a, b) =>
      (a.name || folderLabel(a.directory) || a.directory).localeCompare(
        b.name || folderLabel(b.directory) || b.directory,
      ),
    ),
  );
  const workspace = createMemo(() => {
    const pinned = editor()?.workspace;
    if (pinned) return pinned;
    const dirs = workspaces().map((item) => item.directory);
    if (dirs.includes(workspaceChoice())) return workspaceChoice();
    const preferred = connection()?.directory;
    if (preferred && dirs.includes(preferred)) return preferred;
    return dirs[0] ?? preferred ?? "";
  });
  const workspaceInfo = () => workspaces().find((item) => item.directory === workspace());
  const [listing, { refetch: refetchSkills }] = createResource(
    () => {
      const id = connectionId();
      const dir = workspace();
      return id && dir ? { id, dir } : undefined;
    },
    ({ id, dir }) => listManagedSkills(id, dir),
  );
  const currentListing = () =>
    listing.latest?.connection.id === connectionId() && listing.latest.workspace === workspace()
      ? listing.latest
      : undefined;
  const skills = () => currentListing()?.skills ?? [];
  const local = () => currentListing()?.connection.local ?? currentTargets()?.connection.local ?? false;
  const globalAvailable = () => currentListing()?.globalAvailable ?? currentTargets()?.globalAvailable ?? false;
  const [query, setQuery] = createSignal("");
  const [scopeFilter, setScopeFilter] = createSignal<ScopeFilter>("all");
  const filtered = createMemo(() => {
    const needle = query().trim().toLocaleLowerCase();
    return skills().filter((skill) => {
      if (scopeFilter() !== "all" && skill.scope !== scopeFilter()) return false;
      if (!needle) return true;
      return `${skill.name}\n${skill.id}\n${skill.description}\n${skill.location}`
        .toLocaleLowerCase()
        .includes(needle);
    });
  });
  const selectedKey = () => props.skillId ?? filtered()[0]?.key;
  const selectedSkill = () => skills().find((skill) => skill.key === selectedKey());
  const [saving, setSaving] = createSignal(false);
  const [busy, setBusy] = createSignal("");
  const [note, setNote] = fadeSignal("");
  const [error, setError] = fadeSignal("");
  const [pendingDelete, setPendingDelete] = createSignal<ManagedSkill>();
  const editorDirty = createMemo(() => Boolean(editor()) && JSON.stringify(editor()) !== editorOriginal());

  const withDraftGuard = (action: () => void) => {
    if (!editorDirty()) {
      action();
      return;
    }
    setPendingEditorAction(() => action);
  };
  const discardDraft = () => {
    const action = pendingEditorAction();
    setPendingEditorAction(undefined);
    setEditor(undefined);
    setEditorOriginal("");
    action?.();
  };
  const openEditor = (next: EditorState) => {
    setEditor(next);
    setEditorOriginal(JSON.stringify(next));
  };
  const closeDetail = () => withDraftGuard(() => {
    setEditor(undefined);
    setEditorOriginal("");
    location.hash = "/settings/skills";
  });
  const selectSkill = (key: string) => withDraftGuard(() => {
    setEditor(undefined);
    setEditorOriginal("");
    location.hash = `/settings/skills/${encodeURIComponent(key)}`;
  });

  createEffect(
    on(connectionId, (id, prev) => {
      if (prev === undefined || id === prev || !id || !prev) return;
      setWorkspaceChoice("");
      setEditor(undefined);
      setEditorOriginal("");
      setError("");
      setNote("");
      if (props.skillId) location.hash = "/settings/skills";
    }),
  );
  createEffect(
    on(workspace, (dir, prev) => {
      if (prev === undefined || dir === prev || !dir || !prev) return;
      setEditor(undefined);
      setEditorOriginal("");
      if (props.skillId) location.hash = "/settings/skills";
    }),
  );
  onMount(() => {
    const timer = setInterval(() => {
      if (document.hidden) return;
      if (!untrack(connectionId) || !untrack(workspace)) return;
      void refetchTargets();
      void refetchSkills();
    }, SKILL_REFRESH_MS);
    onCleanup(() => clearInterval(timer));
  });
  const nameOf = (id: string) => {
    const item = connections().find((candidate) => candidate.id === id);
    return item ? connectionName(item) : id;
  };

  const refresh = async () => {
    setError("");
    setNote("");
    await refetchTargets();
    if (workspace()) await refetchSkills();
  };

  const beginCreate = () => withDraftGuard(() => {
    setError("");
    setNote("");
    location.hash = "/settings/skills";
    openEditor({
      mode: "create",
      scope: "project",
      id: "",
      name: "",
      description: "",
      content: "",
      autoInvoke: true,
      connectionId: connectionId(),
      workspace: workspace(),
    });
  });

  const beginEdit = (skill: ManagedSkill) => withDraftGuard(() => {
    setError("");
    setNote("");
    location.hash = `/settings/skills/${encodeURIComponent(skill.key)}`;
    openEditor({
      mode: "edit",
      key: skill.key,
      scope: skill.scope === "global" ? "global" : "project",
      id: skill.id,
      name: skill.name,
      description: skill.description,
      content: skill.content,
      autoInvoke: skill.autoInvoke,
      connectionId: connectionId(),
      workspace: workspace(),
    });
  });

  const patchEditor = (patch: Partial<EditorState>) => {
    const current = editor();
    if (current) setEditor({ ...current, ...patch });
  };

  const changed = (reloaded: boolean, message: string) => {
    window.dispatchEvent(new Event("strata-skills-changed"));
    setNote(reloaded ? message : t("skills.reloadUnconfirmed"));
  };

  const save = async () => {
    const draft = editor();
    if (!draft || saving()) return;
    if (draft.mode === "create" && !validSkillId(draft.id.trim())) {
      setError(t("skills.form.id.invalid"));
      return;
    }
    setSaving(true);
    setError("");
    setNote("");
    try {
      const body = {
        name: draft.name,
        description: draft.description,
        content: draft.content,
        autoInvoke: draft.autoInvoke,
      };
      const result =
        draft.mode === "create"
          ? await createManagedSkill(draft.connectionId, draft.workspace, draft.scope, draft.id.trim(), body)
          : await updateManagedSkill(draft.key!, draft.connectionId, draft.workspace, body);
      changed(result.reloaded, t(draft.mode === "create" ? "skills.created" : "skills.saved"));
      setEditor(undefined);
      setEditorOriginal("");
      await refetchSkills();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  const toggleAutoInvoke = async (skill: ManagedSkill, autoInvoke: boolean) => {
    if (!skill.writable || busy()) return;
    setBusy(`auto:${skill.key}`);
    setError("");
    try {
      const result = await updateManagedSkill(skill.key, connectionId(), workspace(), {
        name: skill.name,
        description: skill.description,
        content: skill.content,
        autoInvoke,
      });
      changed(result.reloaded, t("skills.saved"));
      await refetchSkills();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy("");
    }
  };

  const confirmDelete = async () => {
    const skill = pendingDelete();
    if (!skill || busy()) return;
    setBusy(`delete:${skill.key}`);
    setError("");
    try {
      const result = await deleteManagedSkill(skill.key, connectionId(), workspace());
      changed(result.reloaded, t("skills.deleted"));
      location.hash = "/settings/skills";
      setPendingDelete(undefined);
      setEditor(undefined);
      setEditorOriginal("");
      await refetchSkills();
    } catch (cause) {
      setError(errorText(cause));
      setPendingDelete(undefined);
    } finally {
      setBusy("");
    }
  };

  const open = async (path: string, inEditor: boolean) => {
    setError("");
    try {
      if (inEditor) await openInEditor("vscode", path);
      else await revealPath(path);
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  return (
    <>
      <Group
        label={t("settings.section.skills")}
        hint={t("skills.hint")}
        aside={
          <div class="flex items-center gap-1">
            <Tip label={t("skills.refresh")}>
              <Button
                type="button"
                size="icon-sm"
                variant="icon"
                aria-label={t("skills.refresh")}
                disabled={!connectionId() || targets.loading || listing.loading}
                onClick={() => void refresh()}
              >
                <Icon name="replay" class="size-3.5" />
              </Button>
            </Tip>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!local() || !workspace()}
              onClick={beginCreate}
            >
              <Icon name="plus" class="size-3.5" />
              {t("skills.new")}
            </Button>
          </div>
        }
      >
        <Show
          when={connections().length > 0}
          fallback={<EmptyState icon="spark" layout="inline" title={t("skills.noConnections")} description={t("skills.noConnectionsHint")} />}
        >
          <Card>
            <Show when={connections().length > 1}>
              <Row label={t("skills.connection")}>
                <DropdownMenu>
                  <DropdownMenuTrigger class={pickerTrigger} aria-label={t("skills.connection")}>
                    <span class="truncate">{nameOf(connectionId())}</span>
                    <Icon name="chevron" class="size-3 shrink-0 text-muted-foreground" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent class="max-h-80 w-[var(--kb-popper-anchor-width)] min-w-0 overflow-y-auto">
                    <For each={connections()}>
                      {(item) => (
                        <DropdownMenuItem
                          onSelect={() => {
                            if (item.id === connectionId()) return;
                            setEditor(undefined);
                            setConnectionChoice(item.id);
                          }}
                        >
                          <span class="min-w-0 flex-1 truncate">{nameOf(item.id)}</span>
                          <Show when={item.id === connectionId()}>
                            <Icon name="check" class="size-3" />
                          </Show>
                        </DropdownMenuItem>
                      )}
                    </For>
                  </DropdownMenuContent>
                </DropdownMenu>
              </Row>
            </Show>
            <Row label={t("skills.workspace")} hint={t("skills.workspaceHint")}>
              <DropdownMenu>
                <DropdownMenuTrigger class={pickerTrigger} aria-label={t("skills.workspace")} disabled={!workspace()}>
                  <span class="truncate">
                    {workspaceInfo()?.name || folderLabel(workspace()) || t("skills.noWorkspace")}
                  </span>
                  <Icon name="chevron" class="size-3 shrink-0 text-muted-foreground" />
                </DropdownMenuTrigger>
                <DropdownMenuContent class="max-h-80 w-[var(--kb-popper-anchor-width)] min-w-0 overflow-y-auto">
                  <For each={workspaces()}>
                    {(item) => (
                      <DropdownMenuItem
                        onSelect={() => {
                          if (item.directory === workspace()) return;
                          setEditor(undefined);
                          setWorkspaceChoice(item.directory);
                        }}
                      >
                        <span class="min-w-0 flex-1 truncate">{item.name || folderLabel(item.directory)}</span>
                        <Show when={item.directory === workspace()}>
                          <Icon name="check" class="size-3" />
                        </Show>
                      </DropdownMenuItem>
                    )}
                  </For>
                </DropdownMenuContent>
              </DropdownMenu>
            </Row>
          </Card>
          <Show when={currentTargets() && !local()}>
            <p class="mt-2 text-2xs leading-4 text-muted-foreground">{t("skills.remoteHint")}</p>
          </Show>
        </Show>
      </Group>

      <Show when={connectionId() && workspace()}>
        <Group
          label={t("skills.installed")}
          aside={<span class="text-2xs text-muted-foreground">{filtered().length}</span>}
        >
          <Show when={error()}>
            <p class="mb-2 text-2xs leading-4 text-destructive">{error()}</p>
          </Show>
          <Show when={note()}>
            <p role="status" class="mb-2 flex items-center gap-1.5 text-2xs text-muted-foreground">
              <Icon name="check" class="size-3" />
              {note()}
            </p>
          </Show>
          <Show
            when={!listing.error || currentListing()}
            fallback={
              <EmptyState
                icon="spark"
                tone="danger"
                layout="inline"
                title={t("skills.loadFailed")}
                description={errorText(listing.error)}
                action={
                  <Button type="button" size="sm" variant="outline" onClick={() => void refresh()}>
                    {t("skills.retry")}
                  </Button>
                }
              />
            }
          >
            <Show
              when={currentListing()}
              fallback={
                <Card>
                  <p class="py-3 text-sm text-muted-foreground">{t("skills.loading")}</p>
                </Card>
              }
            >
              <div class="grid items-start gap-5 @min-[1100px]/main:grid-cols-[16rem_minmax(0,1fr)] @min-[1100px]/main:gap-6">
                <div class={editor() || props.skillId ? "hidden @min-[1100px]/main:block" : ""}>
                  <div class="mb-2 flex flex-col gap-2">
                    <TextFieldInput
                      type="search"
                      size="sm"
                      value={query()}
                      onInput={(event) => setQuery(event.currentTarget.value)}
                      placeholder={t("skills.search")}
                      aria-label={t("skills.search")}
                      class="min-w-0 flex-1 bg-card"
                    />
                    <Segmented
                      label={t("skills.filter.scope")}
                      value={scopeFilter()}
                      options={[
                        { id: "all", label: t("skills.filter.all") },
                        { id: "global", label: t("skills.scope.global") },
                        { id: "project", label: t("skills.scope.project") },
                      ]}
                      onChange={(next) => setScopeFilter(next as ScopeFilter)}
                    />
                  </div>
                  <nav aria-label={t("skills.installed")} class="max-h-[36rem] space-y-1 overflow-y-auto pr-1">
                    <For each={filtered()}>
                      {(skill) => (
                        <Button
                          type="button"
                          variant="quiet"
                          aria-current={selectedKey() === skill.key ? "true" : undefined}
                          class={`h-auto min-h-14 w-full items-center justify-start gap-2.5 whitespace-normal rounded-lg border p-2.5 text-left ${
                            selectedKey() === skill.key
                              ? "border-ring/30 bg-accent/60"
                              : "border-transparent hover:bg-secondary/50"
                          }`}
                          onClick={() => selectSkill(skill.key)}
                        >
                          <span
                            class={`size-1.5 shrink-0 rounded-full ${
                              skill.status === "active"
                                ? "bg-status-active"
                                : skill.status === "overridden"
                                  ? "bg-status-cancelled"
                                  : "bg-muted-foreground/35"
                            }`}
                            title={skillStatusLabel(skill.status)}
                          />
                          <span class="min-w-0 flex-1">
                            <span class="block truncate text-sm font-medium text-foreground">{skill.name}</span>
                            <span class="mt-0.5 block truncate text-2xs text-muted-foreground">
                              {t(SKILL_SOURCE_LABEL[skill.source])}
                              {skill.name.toLocaleLowerCase() !== skill.id.toLocaleLowerCase() ? ` · ${skill.id}` : ""}
                            </span>
                          </span>
                        </Button>
                      )}
                    </For>
                    <Show when={filtered().length === 0}>
                      <EmptyState
                        icon="spark"
                        title={t(query() || scopeFilter() !== "all" ? "skills.noMatches" : "skills.empty")}
                        description={t(query() || scopeFilter() !== "all" ? "skills.noMatchesHint" : "skills.emptyHint")}
                      />
                    </Show>
                  </nav>
                </div>

                <div class={editor() || props.skillId ? "min-w-0" : "hidden @min-[1100px]/main:block"}>
                  <Show when={editor() || props.skillId}>
                    <Button
                      type="button"
                      size="sm"
                      variant="quiet"
                      class="-ml-2 mb-4 @min-[1100px]/main:hidden"
                      onClick={closeDetail}
                    >
                      <Icon name="arrow-left" class="size-3.5" />
                      {t("skills.back")}
                    </Button>
                  </Show>
                  <Show
                    when={editor()}
                    fallback={
                      <Show when={selectedKey()}>
                        <Show
                          when={selectedSkill()?.key}
                          keyed
                          fallback={
                            <EmptyState
                              icon="spark"
                              layout="inline"
                              title={t("skills.notFound")}
                              description={t("skills.notFoundHint")}
                              action={
                                <Button type="button" size="sm" variant="outline" onClick={closeDetail}>
                                  {t("skills.back")}
                                </Button>
                              }
                            />
                          }
                        >
                          {(key) => (
                            <div data-skill-key={key} class="min-w-0">
                              <SkillDetail
                                skill={selectedSkill()!}
                                busy={busy()}
                                onToggle={(next) => void toggleAutoInvoke(selectedSkill()!, next)}
                                onEdit={() => beginEdit(selectedSkill()!)}
                                onOpen={(path, inEditor) => void open(path, inEditor)}
                                onDelete={() => setPendingDelete(selectedSkill()!)}
                              />
                            </div>
                          )}
                        </Show>
                      </Show>
                    }
                  >
                    {(current) => (
                      <SkillEditor
                        draft={current()}
                        globalAvailable={globalAvailable()}
                        saving={saving()}
                        error={error()}
                        onPatch={patchEditor}
                        onSave={() => void save()}
                        onCancel={() => withDraftGuard(() => setEditor(undefined))}
                      />
                    )}
                  </Show>
                </div>
              </div>
            </Show>
          </Show>
        </Group>
      </Show>

      <ConfirmDialog
        open={pendingDelete() !== undefined}
        title={t("skills.deleteTitle", { name: pendingDelete()?.name ?? "" })}
        description={
          pendingDelete()?.directoryForm
            ? t("skills.deleteWarning", { count: pendingDelete()?.files.length ?? 0 })
            : t("skills.deleteBody")
        }
        confirmLabel={t("skills.delete")}
        cancelLabel={t("confirm.cancel")}
        pending={busy().startsWith("delete:")}
        onConfirm={() => void confirmDelete()}
        onCancel={() => {
          if (!busy().startsWith("delete:")) setPendingDelete(undefined);
        }}
      />
      <ConfirmDialog
        open={pendingEditorAction() !== undefined}
        title={t("skills.unsaved.title")}
        description={t("skills.unsaved.description")}
        confirmLabel={t("skills.unsaved.discard")}
        cancelLabel={t("confirm.cancel")}
        onConfirm={discardDraft}
        onCancel={() => setPendingEditorAction(undefined)}
      />
    </>
  );
}
