import { createResource, createSignal, Show } from "solid-js";
import { Button } from "@/components/ui/button";
import { TextFieldInput } from "@/components/ui/text-field";
import { explain } from "./errors";
import { t } from "./i18n";
import { Icon } from "./icons";
import { readWorktreeRoot, setWorktreeRoot } from "./maintenance-api";
import { Card, Group, Row, Segmented } from "./settings-blocks";
import { inDesktopShell } from "./shell";

async function chooseDirectory(title: string): Promise<string | null> {
  if (!inDesktopShell()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title });
  return typeof picked === "string" ? picked : null;
}

export function WorktreeSettings() {
  const [info, { refetch }] = createResource(readWorktreeRoot);
  const [busy, setBusy] = createSignal(false);
  const [browserCustom, setBrowserCustom] = createSignal(false);
  const [draft, setDraft] = createSignal<string>();
  const [feedback, setFeedback] = createSignal<{ ok: boolean; text: string }>();
  const configured = () => info()?.worktreeRoot ?? "";
  const custom = () => Boolean(configured()) || (!inDesktopShell() && browserCustom());
  const shownPath = () => configured() || info()?.createsIn || configured();

  const save = async (path: string) => {
    setBusy(true);
    setFeedback(undefined);
    try {
      const saved = await setWorktreeRoot(path);
      await refetch();
      setDraft(undefined);
      setFeedback({
        ok: true,
        text: saved.worktreeRoot
          ? t("worktree.settings.saved", { path: saved.worktreeRoot })
          : t("worktree.settings.cleared"),
      });
    } catch (error) {
      setFeedback({ ok: false, text: explain(error) });
    } finally {
      setBusy(false);
    }
  };

  const pick = async () => {
    if (busy()) return;
    setBusy(true);
    setFeedback(undefined);
    try {
      const directory = await chooseDirectory(t("worktree.settings.choose"));
      if (!directory) return;
      await save(directory);
    } catch (error) {
      setFeedback({ ok: false, text: explain(error) });
    } finally {
      setBusy(false);
    }
  };

  const choose = (mode: "default" | "custom") => {
    if (busy()) return;
    if (mode === "default") {
      setBrowserCustom(false);
      setDraft(undefined);
      void save("");
      return;
    }
    if (inDesktopShell()) {
      void pick();
      return;
    }
    setBrowserCustom(true);
    setDraft(configured() || info()?.createsIn || "");
  };

  return (
    <Group label={t("worktree.settings.title")} hint={t("worktree.settings.hint")}>
      <Card>
        <Row
          label={t("worktree.settings.location")}
          note={
            <Show when={feedback()}>
              {(result) => (
                <p class={`mt-1.5 flex items-center gap-1.5 text-2xs ${result().ok ? "text-muted-foreground" : "text-destructive"}`}>
                  <Icon name={result().ok ? "check" : "alert"} class="size-3 shrink-0" />
                  {result().text}
                </p>
              )}
            </Show>
          }
        >
          <Segmented
            label={t("worktree.settings.location")}
            value={custom() ? "custom" : "default"}
            options={[
              { id: "default", label: t("worktree.settings.default") },
              { id: "custom", label: t("worktree.settings.custom") },
            ]}
            onChange={(mode) => choose(mode as "default" | "custom")}
          />
        </Row>
        <div class="px-4 py-3">
          <div class="flex items-center gap-3 rounded-md border border-border bg-secondary/30 px-3 py-2.5">
            <Icon name="folder" class="size-4 shrink-0 text-muted-foreground" />
            <div class="min-w-0 flex-1">
              <p class="text-2xs text-muted-foreground">
                {custom() ? t("worktree.settings.current") : t("worktree.settings.defaultPath")}
              </p>
              <code class="block truncate font-mono text-xs text-foreground" title={shownPath()}>
                {shownPath()}
              </code>
            </div>
            <Show when={custom() && inDesktopShell()}>
              <Button type="button" size="xs" variant="outline" disabled={busy()} onClick={() => void pick()}>
                {busy() ? t("worktree.settings.saving") : t("worktree.settings.change")}
              </Button>
            </Show>
          </div>
          <Show when={custom() && !inDesktopShell()}>
            <div class="mt-2 flex items-center gap-2">
              <TextFieldInput
                size="sm"
                class="min-w-0 flex-1 font-mono text-2xs"
                spellcheck={false}
                value={draft() ?? configured()}
                disabled={busy()}
                aria-label={t("worktree.settings.custom")}
                onInput={(event) => setDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  void save((draft() ?? "").trim());
                }}
              />
              <Button
                type="button"
                size="sm"
                disabled={busy()}
                onClick={() => void save((draft() ?? "").trim())}
              >
                {busy() ? t("worktree.settings.saving") : t("worktree.settings.save")}
              </Button>
            </div>
          </Show>
        </div>
      </Card>
    </Group>
  );
}
