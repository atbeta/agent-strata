import { Show } from "solid-js";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { TextField, TextFieldInput, TextFieldLabel } from "@/components/ui/text-field";
import { t } from "./i18n";
import { Segmented } from "./settings-blocks";

export interface SkillEditorState {
  mode: "create" | "edit";
  key?: string;
  scope: "global" | "project";
  id: string;
  name: string;
  description: string;
  content: string;
  autoInvoke: boolean;
  connectionId: string;
  workspace: string;
}

export function validSkillId(id: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id) && id.length <= 64;
}

export function SkillEditor(props: {
  draft: SkillEditorState;
  globalAvailable: boolean;
  saving: boolean;
  error: string;
  onPatch: (patch: Partial<SkillEditorState>) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <section data-skill-editor class="min-w-0">
      <h3 class="text-lg font-semibold tracking-tight text-foreground">
        {t(props.draft.mode === "create" ? "skills.new" : "skills.edit")}
      </h3>
      <div class="mt-5 space-y-4 rounded-lg border border-border bg-card p-4">
        <Show when={props.draft.mode === "create"}>
          <div>
            <p class="text-sm font-medium text-foreground">{t("skills.form.scope")}</p>
            <p class="mt-0.5 text-2xs text-muted-foreground">{t("skills.form.scopeHint")}</p>
            <div class="mt-2">
              <Segmented
                label={t("skills.form.scope")}
                value={props.draft.scope}
                options={[
                  { id: "project", label: t("skills.source.project") },
                  ...(props.globalAvailable ? [{ id: "global", label: t("skills.source.global") }] : []),
                ]}
                onChange={(scope) => props.onPatch({ scope: scope as "global" | "project" })}
              />
            </div>
          </div>
          <TextField>
            <TextFieldLabel>{t("skills.form.id")}</TextFieldLabel>
            <TextFieldInput
              size="sm"
              mono
              value={props.draft.id}
              onInput={(event) => props.onPatch({ id: event.currentTarget.value })}
              placeholder="git-release"
              autocomplete="off"
              spellcheck={false}
            />
            <TextFieldLabel variant="description">{t("skills.form.idHint")}</TextFieldLabel>
          </TextField>
        </Show>
        <Show when={props.draft.mode === "edit"}>
          <div>
            <div class="text-sm font-medium">{t("skills.form.id")}</div>
            <code class="mt-1 block font-mono text-xs text-muted-foreground">{props.draft.id}</code>
            <p class="mt-1 text-2xs text-muted-foreground">{t("skills.form.idLocked")}</p>
          </div>
        </Show>
        <TextField>
          <TextFieldLabel>{t("skills.form.name")}</TextFieldLabel>
          <TextFieldInput
            size="sm"
            value={props.draft.name}
            onInput={(event) => props.onPatch({ name: event.currentTarget.value })}
            placeholder={props.draft.id || t("skills.form.namePlaceholder")}
          />
        </TextField>
        <TextField>
          <TextFieldLabel>{t("skills.form.description")}</TextFieldLabel>
          <TextFieldInput
            size="sm"
            value={props.draft.description}
            onInput={(event) => props.onPatch({ description: event.currentTarget.value })}
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
            rows={14}
            class="mt-1 min-h-64 w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-5 text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none"
            value={props.draft.content}
            onInput={(event) => props.onPatch({ content: event.currentTarget.value })}
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
            checked={props.draft.autoInvoke}
            aria-label={t("skills.autoinvoke")}
            onChange={(autoInvoke) => props.onPatch({ autoInvoke })}
          />
        </div>
        <Show when={props.error}>
          <p class="text-2xs leading-4 text-destructive">{props.error}</p>
        </Show>
        <div class="flex items-center gap-2 border-t border-border pt-3">
          <Button
            type="button"
            size="sm"
            disabled={props.saving || (props.draft.mode === "create" && !validSkillId(props.draft.id.trim()))}
            onClick={props.onSave}
          >
            {t(props.saving ? "skills.saving" : "skills.save")}
          </Button>
          <Button type="button" size="sm" variant="quiet" disabled={props.saving} onClick={props.onCancel}>
            {t("skills.cancel")}
          </Button>
        </div>
      </div>
    </section>
  );
}
