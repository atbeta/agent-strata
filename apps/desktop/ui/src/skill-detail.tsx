import { createSignal, For, Show } from "solid-js";
import { Button } from "@/components/ui/button";
import { MiniTabs } from "@/components/ui/mini-tabs";
import { RowButton } from "@/components/ui/row-button";
import { Switch } from "@/components/ui/switch";
import { copyText } from "./clipboard";
import { fadeSignal } from "./errors";
import { t } from "./i18n";
import { Icon } from "./icons";
import type { ManagedSkill } from "./api";
import { SKILL_SOURCE_LABEL, skillReadonlyLabel, skillStatusLabel, skillSupportPath } from "./skill-display";

export function SkillDetail(props: {
  skill: ManagedSkill;
  busy: string;
  onToggle: (next: boolean) => void;
  onEdit: () => void;
  onOpen: (path: string, editor: boolean) => void;
  onDelete: () => void;
}) {
  const [tab, setTab] = createSignal<"content" | "files">("content");
  const [copied, setCopied] = fadeSignal("");
  const copyPath = async () => {
    if (await copyText(props.skill.location)) setCopied("skills.copied");
  };
  return (
    <section data-skill-detail={props.skill.key} class="min-w-0">
      <header>
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span
                class={`size-1.5 shrink-0 rounded-full ${
                  props.skill.status === "active"
                    ? "bg-status-active"
                    : props.skill.status === "overridden"
                      ? "bg-status-cancelled"
                      : "bg-muted-foreground/35"
                }`}
              />
              <h3 class="truncate text-lg font-semibold tracking-tight text-foreground">{props.skill.name}</h3>
            </div>
            <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
              <code class="font-mono">{props.skill.id}</code>
              <span aria-hidden="true">·</span>
              <span>{t(SKILL_SOURCE_LABEL[props.skill.source])}</span>
              <span aria-hidden="true">·</span>
              <span>{skillStatusLabel(props.skill.status)}</span>
            </div>
          </div>
          <Show when={props.skill.writable}>
            <Button type="button" size="sm" variant="outline" onClick={props.onEdit}>
              <Icon name="pencil" class="size-3.5" />
              {t("skills.edit")}
            </Button>
          </Show>
        </div>
        <Show when={props.skill.description}>
          <p class="mt-3 max-w-2xl text-xs leading-5 text-muted-foreground">{props.skill.description}</p>
        </Show>
      </header>

      <div class="mt-5 flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-4">
        <div>
          <p class="text-sm font-medium text-foreground">{t("skills.autoinvoke")}</p>
          <p class="mt-0.5 text-2xs leading-4 text-muted-foreground">{t("skills.autoinvokeHint")}</p>
        </div>
        <Switch
          checked={props.skill.autoInvoke}
          disabled={!props.skill.writable || props.busy === `auto:${props.skill.key}`}
          aria-label={t("skills.autoinvokeFor", { name: props.skill.name })}
          onChange={props.onToggle}
        />
      </div>
      <Show when={!props.skill.writable}>
        <p class="mt-2 text-2xs text-muted-foreground">{skillReadonlyLabel(props.skill)}</p>
      </Show>
      <Show when={props.skill.error}>
        <p class="mt-2 text-2xs text-destructive">{props.skill.error}</p>
      </Show>

      <div class="mt-5">
        <MiniTabs
          kind="tabs"
          label={t("skills.detail")}
          value={tab()}
          options={[
            { id: "content", label: t("skills.form.content") },
            { id: "files", label: t("skills.supportFiles", { count: props.skill.files.length }) },
          ]}
          onChange={(next) => setTab(next as "content" | "files")}
        />
        <div class="mt-2 rounded-lg border border-border bg-card p-3">
          <Show when={tab() === "content"}>
            <pre class="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs leading-5 text-foreground">
              {props.skill.content || t("skills.emptyBody")}
            </pre>
          </Show>
          <Show when={tab() === "files"}>
            <Show
              when={props.skill.files.length > 0}
              fallback={<p class="py-3 text-xs text-muted-foreground">{t("skills.noSupportFiles")}</p>}
            >
              <div class="space-y-1">
                <For each={props.skill.files}>
                  {(file) => (
                    <RowButton
                      class="block max-w-full truncate font-mono text-2xs text-muted-foreground"
                      onClick={() => props.onOpen(skillSupportPath(props.skill, file), true)}
                    >
                      {file}
                    </RowButton>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </div>
      </div>

      <div class="mt-4 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => props.onOpen(props.skill.location, true)}>
          <Icon name="page" class="size-3.5" />
          {t("skills.openFile")}
        </Button>
        <Button type="button" size="sm" variant="quiet" onClick={() => props.onOpen(props.skill.location, false)}>
          <Icon name="folder-open" class="size-3.5" />
          {t("skills.reveal")}
        </Button>
        <Button type="button" size="sm" variant="quiet" onClick={() => void copyPath()}>
          <Icon name="copy" class="size-3.5" />
          {copied() ? t("skills.copied") : t("skills.copyPath")}
        </Button>
        <code class="ml-auto max-w-32 truncate font-mono text-2xs text-muted-foreground" title={props.skill.location}>
          SKILL.md
        </code>
      </div>

      <Show when={props.skill.writable}>
        <div class="mt-5 border-t border-border pt-4">
          <Button
            type="button"
            size="sm"
            variant="quiet"
            class="hover:bg-destructive/10 hover:text-destructive"
            disabled={props.busy === `delete:${props.skill.key}`}
            onClick={props.onDelete}
          >
            <Icon name="trash" class="size-3.5" />
            {t("skills.delete")}
          </Button>
        </div>
      </Show>
    </section>
  );
}
