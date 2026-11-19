import { createEffect, createSignal, Show } from "solid-js";
import { Button } from "@/components/ui/button";
import { TextFieldInput } from "@/components/ui/text-field";
import { t } from "./i18n";
import { registryVersion } from "./plugin-registry";
import {
  deleteBackgroundImage,
  MAX_BACKGROUND_IMAGE_BYTES,
  readBackgroundSpec,
  uploadBackgroundImage,
} from "./background-api";

export function BackgroundImageSettings(props: { onChanged: () => void | Promise<void> }) {
  const [hasImage, setHasImage] = createSignal(false);
  const [busy, setBusy] = createSignal<"upload" | "remove" | "">("");
  const [error, setError] = createSignal("");
  let input: HTMLInputElement | undefined;

  createEffect(() => {
    registryVersion();
    void readBackgroundSpec()
      .then((spec) => {
        setHasImage(Boolean(spec?.image));
        setError("");
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  });

  const upload = async (file: File) => {
    if (file.size > MAX_BACKGROUND_IMAGE_BYTES) {
      setError(t("plugin.background.image.tooLarge"));
      return;
    }
    setBusy("upload");
    setError("");
    try {
      await uploadBackgroundImage(file);
      setHasImage(true);
      await props.onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
      if (input) input.value = "";
    }
  };

  const remove = async () => {
    setBusy("remove");
    setError("");
    try {
      await deleteBackgroundImage();
      setHasImage(false);
      await props.onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  };

  return (
    <div class="mb-3 rounded-md border border-border bg-muted/20 p-2.5">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="text-muted-foreground">{t("plugin.background.image")}</p>
          <p class="mt-0.5 text-2xs leading-4 text-muted-foreground">
            {hasImage() ? t("plugin.background.image.selected") : t("plugin.background.image.hint")}
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-1.5">
          <Show when={hasImage()}>
            <Button
              type="button"
              size="xs"
              variant="quiet"
              disabled={busy() !== ""}
              onClick={() => void remove()}
            >
              {busy() === "remove" ? t("plugin.background.image.removing") : t("plugin.background.image.remove")}
            </Button>
          </Show>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={busy() !== ""}
            onClick={() => input?.click()}
          >
            {busy() === "upload"
              ? t("plugin.background.image.uploading")
              : hasImage()
                ? t("plugin.background.image.replace")
                : t("plugin.background.image.choose")}
          </Button>
        </div>
      </div>
      <TextFieldInput
        ref={(element) => (input = element)}
        type="file"
        class="hidden"
        accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
        aria-label={t("plugin.background.image")}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) void upload(file);
        }}
      />
      <Show when={error()}>
        <p class="mt-2 break-words text-2xs text-destructive" role="alert">{error()}</p>
      </Show>
    </div>
  );
}
