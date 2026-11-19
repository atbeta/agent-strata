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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { RowButton } from "@/components/ui/row-button";
import { Switch } from "@/components/ui/switch";
import { TextField, TextFieldInput, TextFieldLabel } from "@/components/ui/text-field";
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
  type SkillSource,
} from "./api";
import { explain as errorText, fadeSignal } from "./errors";
import { t } from "./i18n";
import { Icon } from "./icons";
import { Tip } from "./tip";
import { endpointShort, type ConnectionsCtl } from "./use-connections";
import { Card, Group, Row, Segmented, pickerTrigger } from "./settings-blocks";

interface EditorState {
  mode: "create" | "edit";
  key?: string;
  scope: "global" | "project";
  id: string;
  name: string;
  description: string;
  content: string;
  autoInvoke: boolean;
  /** Connection and workspace this draft was opened against. A later poll must not retarget the save. */
  connectionId: string;
  workspace: string;
}

/** How often the open page rereads workspaces and skills. Independent of the connection snapshot. */
export const SKILL_REFRESH_MS = 5_000;

const SOURCE_LABEL: Record<SkillSource, Parameters<typeof t>[0]> = {
  "opencode-global": "skills.source.global",
  "opencode-project": "skills.source.project",
  claude: "skills.source.claude",
  agents: "skills.source.agents",
  custom: "skills.source.custom",
  http: "skills.source.http",
  console: "skills.source.console",
  builtin: "skills.source.builtin",
  unknown: "skills.source.unknown",
};

function statusLabel(status: ManagedSkill["status"]): string {
  return t(`skills.status.${status}`);
}

function readonlyLabel(skill: ManagedSkill): string {
  if (!skill.readonlyReason) return t("skills.readonly.custom");
  return t(`skills.readonly.${skill.readonlyReason}`);
}

function validId(id: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id) && id.length <= 64;
}

export function SkillSettings(props: { conns: ConnectionsCtl }) {
  const connections = () =>
    (props.conns.conns.latest?.connections ?? []).filter(
      (connection) => connection.backend === "opencode" && connection.capabilities?.extension === "opencode",
    );
  const [connectionChoice, setConnectionChoice] = createSignal("");
  const [editor, setEditor] = createSignal<EditorState>();
  // While a draft is open, keep its connection even if a poll reorders or briefly drops the snapshot.
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
  // Same for the workspace: follow the live directory only when nothing is being edited.
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
  const filtered = createMemo(() => {
    const needle = query().trim().toLocaleLowerCase();
    if (!needle) return skills();
    return skills().filter((skill) =>
      `${skill.name}\n${skill.id}\n${skill.description}\n${skill.location}`.toLocaleLowerCase().includes(needle),
    );
  });
  const [selected, setSelected] = createSignal("");
  const selectedSkill = () => skills().find((skill) => skill.key === selected());
  const draft = () => editor()!;
  const [saving, setSaving] = createSignal(false);
  const [busy, setBusy] = createSignal("");
  const [note, setNote] = fadeSignal("");
  const [error, setError] = fadeSignal("");
  const [deleteArmed, setDeleteArmed] = createSignal("");
  let deleteTimer: ReturnType<typeof setTimeout> | undefined;

  // A connection poll replaces the snapshot object, and the open draft pins its own
  // connection and workspace. Only an actual switch of id or path discards the draft;
  // the list itself refreshes on a timer without leaving the editor.
  createEffect(
    on(connectionId, (id, prev) => {
      if (prev === undefined || id === prev || !id || !prev) return;
      setWorkspaceChoice("");
      setSelected("");
      setEditor(undefined);
      setError("");
      setNote("");
    }),
  );
  createEffect(
    on(workspace, (dir, prev) => {
      if (prev === undefined || dir === prev || !dir || !prev) return;
      setSelected("");
      setEditor(undefined);
      setDeleteArmed("");
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
  onCleanup(() => clearTimeout(deleteTimer));

  const connectionName = (id: string) => {
    const item = connections().find((candidate) => candidate.id === id);
    return item?.name || `${item ? endpointShort(item.baseUrl) : id}`;
  };

  const refresh = async () => {
    setError("");
    setNote("");
    await refetchTargets();
    if (workspace()) await refetchSkills();
  };

  const beginCreate = () => {
    setError("");
    setNote("");
    setEditor({
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
  };

  const beginEdit = (skill: ManagedSkill) => {
    setError("");
    setNote("");
    setEditor({
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
  };

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
    if (draft.mode === "create" && !validId(draft.id.trim())) {
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

  const requestDelete = (skill: ManagedSkill) => {
    if (deleteArmed() !== skill.key) {
      setDeleteArmed(skill.key);
      clearTimeout(deleteTimer);
      deleteTimer = setTimeout(() => setDeleteArmed(""), 5000);
      return;
    }
    void (async () => {
      setBusy(`delete:${skill.key}`);
      setError("");
      clearTimeout(deleteTimer);
      try {
        const result = await deleteManagedSkill(skill.key, connectionId(), workspace());
        changed(result.reloaded, t("skills.deleted"));
        setSelected("");
        setDeleteArmed("");
        setEditor(undefined);
        await refetchSkills();
      } catch (cause) {
        setError(errorText(cause));
      } finally {
        setBusy("");
      }
    })();
  };

  const open = async (path: string, editor: boolean) => {
    setError("");
    try {
      if (editor) await openInEditor("vscode", path);
      else await revealPath(path);
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const supportPath = (skill: ManagedSkill, file: string) =>
    `${skill.location.replace(/[\\/]SKILL\.md$/, "")}/${file}`;

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
                    <span class="truncate">{connectionName(connectionId())}</span>
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
                          <span class="min-w-0 flex-1 truncate">{connectionName(item.id)}</span>
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
        <Show when={editor()}>
          <Group label={t(draft().mode === "create" ? "skills.new" : "skills.edit")}>
            <Card>
              <div class="space-y-4 py-4">
                <Show when={draft().mode === "create"}>
                  <Row label={t("skills.form.scope")} hint={t("skills.form.scopeHint")}>
                    <Segmented
                      label={t("skills.form.scope")}
                      value={draft().scope}
                      options={[
                        { id: "project", label: t("skills.source.project") },
                        ...(globalAvailable() ? [{ id: "global", label: t("skills.source.global") }] : []),
                      ]}
                      onChange={(scope) => patchEditor({ scope: scope as "global" | "project" })}
                    />
                  </Row>
                  <TextField>
                    <TextFieldLabel>{t("skills.form.id")}</TextFieldLabel>
                    <TextFieldInput
                      size="sm"
                      mono
                      value={draft().id}
                      onInput={(event) => patchEditor({ id: event.currentTarget.value })}
                      placeholder="git-release"
                      autocomplete="off"
                      spellcheck={false}
                    />
                    <TextFieldLabel variant="description">{t("skills.form.idHint")}</TextFieldLabel>
                  </TextField>
                </Show>
                <Show when={draft().mode === "edit"}>
                  <div>
                    <div class="text-sm font-medium">{t("skills.form.id")}</div>
                    <code class="mt-1 block font-mono text-xs text-muted-foreground">{draft().id}</code>
                    <p class="mt-1 text-2xs text-muted-foreground">{t("skills.form.idLocked")}</p>
                  </div>
                </Show>
                <TextField>
                  <TextFieldLabel>{t("skills.form.name")}</TextFieldLabel>
                  <TextFieldInput
                    size="sm"
                    value={draft().name}
                    onInput={(event) => patchEditor({ name: event.currentTarget.value })}
                    placeholder={draft().id || t("skills.form.namePlaceholder")}
                  />
                </TextField>
                <TextField>
                  <TextFieldLabel>{t("skills.form.description")}</TextFieldLabel>
                  <TextFieldInput
                    size="sm"
                    value={draft().description}
                    onInput={(event) => patchEditor({ description: event.currentTarget.value })}
                    placeholder={t("skills.form.descriptionPlaceholder")}
                  />
                  <TextFieldLabel variant="description">{t("skills.form.descriptionHint")}</TextFieldLabel>
                </TextField>
                <div>
                  <label class="text-sm font-medium" for="skill-content">
                    {t("skills.form.content")}
                  </label>
                  <textarea
                    id="skill-content"
                    rows={12}
                    class="mt-1 min-h-56 w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-5 text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none"
                    value={draft().content}
                    onInput={(event) => patchEditor({ content: event.currentTarget.value })}
                    placeholder={t("skills.form.contentPlaceholder")}
                    spellcheck={false}
                  />
                </div>
                <div class="flex items-center justify-between gap-4">
                  <div>
                    <div class="text-sm font-medium">{t("skills.autoinvoke")}</div>
                    <p class="mt-1 text-2xs leading-4 text-muted-foreground">{t("skills.autoinvokeHint")}</p>
                  </div>
                  <Switch
                    checked={draft().autoInvoke}
                    aria-label={t("skills.autoinvoke")}
                    onChange={(autoInvoke) => patchEditor({ autoInvoke })}
                  />
                </div>
                <Show when={error()}>
                  <p class="text-2xs leading-4 text-destructive">{error()}</p>
                </Show>
                <div class="flex items-center gap-2 border-t border-border pt-3">
                  <Button
                    type="button"
                    size="sm"
                    disabled={saving() || (draft().mode === "create" && !validId(draft().id.trim()))}
                    onClick={() => void save()}
                  >
                    {t(saving() ? "skills.saving" : "skills.save")}
                  </Button>
                  <Button type="button" size="sm" variant="quiet" disabled={saving()} onClick={() => setEditor(undefined)}>
                    {t("skills.cancel")}
                  </Button>
                </div>
              </div>
            </Card>
          </Group>
        </Show>
        <Show when={!editor()}>
        <Group
          label={t("skills.installed")}
          aside={<span class="text-2xs text-muted-foreground">{filtered().length}</span>}
        >
          <TextFieldInput
            type="search"
            size="sm"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            placeholder={t("skills.search")}
            aria-label={t("skills.search")}
            class="mb-2 bg-card"
          />
          <Show when={error()}>
            <p class="mb-2 text-2xs leading-4 text-destructive">{error()}</p>
          </Show>
          <Show when={note()}>
            <p class="mb-2 flex items-center gap-1.5 text-2xs text-muted-foreground">
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
              <Card class="px-0">
                <Show
                  when={filtered().length > 0}
                  fallback={
                    <div class="px-4 py-4">
                      <EmptyState
                        icon="spark"
                        layout="inline"
                        title={t(query() ? "skills.noMatches" : "skills.empty")}
                        description={t(query() ? "skills.noMatchesHint" : "skills.emptyHint")}
                      />
                    </div>
                  }
                >
                  <For each={filtered()}>
                    {(skill) => (
                      <div class="px-4 py-3">
                        <div class="flex items-start gap-3">
                          <span
                            class={`mt-1.5 size-1.5 shrink-0 rounded-full ${
                              skill.status === "active"
                                ? "bg-status-active"
                                : skill.status === "overridden"
                                  ? "bg-status-cancelled"
                                  : "bg-muted-foreground/35"
                            }`}
                          />
                          <RowButton
                            class="min-w-0 flex-1 rounded-none px-0 py-0 hover:bg-transparent"
                            aria-expanded={selected() === skill.key}
                            onClick={() => {
                              setSelected(selected() === skill.key ? "" : skill.key);
                              setDeleteArmed("");
                            }}
                          >
                            <div class="min-w-0 flex-1">
                              <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                                <span class="truncate text-sm font-medium text-foreground">{skill.name}</span>
                                <code class="font-mono text-2xs text-muted-foreground">{skill.id}</code>
                              </div>
                              <Show when={skill.description}>
                                <p class="mt-1 line-clamp-2 text-xs leading-4 text-muted-foreground">
                                  {skill.description}
                                </p>
                              </Show>
                              <div class="mt-1.5 flex flex-wrap gap-1.5 text-2xs text-muted-foreground">
                                <span>{t(SOURCE_LABEL[skill.source])}</span>
                                <span aria-hidden="true">·</span>
                                <span>{statusLabel(skill.status)}</span>
                                <Show when={!skill.autoInvoke}>
                                  <span aria-hidden="true">·</span>
                                  <span>{t("skills.manualOnly")}</span>
                                </Show>
                              </div>
                            </div>
                          </RowButton>
                          <Show when={skill.writable}>
                            <Tip label={t("skills.edit")}>
                              <Button
                                type="button"
                                size="icon-sm"
                                variant="icon"
                                aria-label={t("skills.editSkill", { name: skill.name })}
                                onClick={() => beginEdit(skill)}
                              >
                                <Icon name="pencil" class="size-3.5" />
                              </Button>
                            </Tip>
                          </Show>
                        </div>
                        <Show when={selectedSkill()?.key === skill.key}>
                          <div class="mt-3 rounded-md border border-border bg-muted/20 p-3">
                            <div class="flex flex-wrap items-center justify-between gap-2">
                              <span class="text-xs font-medium">{t("skills.autoinvoke")}</span>
                              <Switch
                                checked={skill.autoInvoke}
                                disabled={!skill.writable || busy() === `auto:${skill.key}`}
                                aria-label={t("skills.autoinvokeFor", { name: skill.name })}
                                onChange={(next) => void toggleAutoInvoke(skill, next)}
                              />
                            </div>
                            <p class="mt-1 text-2xs leading-4 text-muted-foreground">{t("skills.autoinvokeHint")}</p>
                            <Show when={!skill.writable}>
                              <p class="mt-2 text-2xs text-muted-foreground">{readonlyLabel(skill)}</p>
                            </Show>
                            <Show when={skill.error}>
                              <p class="mt-2 text-2xs text-destructive">{skill.error}</p>
                            </Show>
                            <pre class="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background/70 p-2.5 font-mono text-2xs leading-5 text-foreground">
                              {skill.content || t("skills.emptyBody")}
                            </pre>
                            <code class="mt-3 block truncate font-mono text-2xs text-muted-foreground" title={skill.location}>
                              {skill.location}
                            </code>
                            <Show when={skill.files.length > 0}>
                              <div class="mt-3 border-t border-border pt-2">
                                <p class="text-2xs font-medium text-muted-foreground">
                                  {t("skills.supportFiles", { count: skill.files.length })}
                                </p>
                                <For each={skill.files}>
                                  {(file) => (
                                    <RowButton
                                      class="mt-1 block max-w-full truncate rounded-none px-0 py-0 font-mono text-2xs text-muted-foreground hover:bg-transparent"
                                      onClick={() => void open(supportPath(skill, file), true)}
                                    >
                                      {file}
                                    </RowButton>
                                  )}
                                </For>
                              </div>
                            </Show>
                            <div class="mt-3 flex flex-wrap items-center gap-2">
                              <Button type="button" size="sm" variant="outline" onClick={() => void open(skill.location, true)}>
                                <Icon name="page" class="size-3.5" />
                                {t("skills.openFile")}
                              </Button>
                              <Button type="button" size="sm" variant="quiet" onClick={() => void open(skill.location, false)}>
                                <Icon name="folder-open" class="size-3.5" />
                                {t("skills.reveal")}
                              </Button>
                              <Show when={skill.writable}>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant={deleteArmed() === skill.key ? "destructive" : "quiet"}
                                  disabled={busy() === `delete:${skill.key}`}
                                  onClick={() => requestDelete(skill)}
                                >
                                  <Icon name="trash" class="size-3.5" />
                                  {deleteArmed() === skill.key ? t("skills.deleteConfirm") : t("skills.delete")}
                                </Button>
                              </Show>
                            </div>
                            <Show when={deleteArmed() === skill.key && skill.directoryForm}>
                              <p class="mt-2 text-2xs leading-4 text-destructive">
                                {t("skills.deleteWarning", { count: skill.files.length })}
                              </p>
                            </Show>
                          </div>
                        </Show>
                      </div>
                    )}
                  </For>
                </Show>
              </Card>
            </Show>
          </Show>
        </Group>
        </Show>
      </Show>
    </>
  );
}
