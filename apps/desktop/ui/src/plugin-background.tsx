import { createEffect, createResource, onCleanup, Show } from "solid-js";
import { readBackgroundImage, readBackgroundSpec } from "./background-api";
import { backgroundContribution, registryVersion } from "./plugin-registry";

const MAX_BACKGROUND_PIXELS = 40_000_000;

export function PluginBackground(props: { onActive?: (active: boolean) => void }) {
  let disposed = false;
  let currentUrl: string | undefined;

  const [spec] = createResource(
    () => {
      const contribution = backgroundContribution();
      const version = registryVersion();
      return contribution ? { contribution, version } : undefined;
    },
    ({ contribution }) => readBackgroundSpec(contribution.plugin, contribution.resource),
  );
  const currentSpec = () => (backgroundContribution() ? spec() : undefined);
  const [image] = createResource(
    () => {
      const contribution = backgroundContribution();
      const resource = currentSpec()?.image?.resource;
      const version = registryVersion();
      return contribution && resource
        ? { plugin: contribution.plugin, resource, version }
        : undefined;
    },
    ({ plugin, resource }) => loadImage(plugin, resource, () => disposed),
  );
  const visibleImage = () => (backgroundContribution() ? image() : undefined);

  createEffect(() => {
    const next = visibleImage();
    if (next !== currentUrl) {
      const previous = currentUrl;
      currentUrl = next;
      if (previous) URL.revokeObjectURL(previous);
    }
    props.onActive?.(Boolean(next));
  });
  onCleanup(() => {
    disposed = true;
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    props.onActive?.(false);
  });

  return (
    <Show
      when={
        currentSpec() && visibleImage()
          ? { url: visibleImage()!, spec: currentSpec()! }
          : undefined
      }
    >
      {(background) => (
        <div
          class="pointer-events-none absolute inset-0 z-0 overflow-hidden"
          aria-hidden="true"
          data-plugin-background={background().spec.fit}
        >
          <div
            class="absolute bg-no-repeat"
            style={{
              top: `${-background().spec.blur}px`,
              right: `${-background().spec.blur}px`,
              bottom: `${-background().spec.blur}px`,
              left: `${-background().spec.blur}px`,
              "background-image": `url("${background().url}")`,
              "background-size": background().spec.fit,
              "background-position": "center",
              opacity: String(background().spec.opacity),
              filter: background().spec.blur > 0 ? `blur(${background().spec.blur}px)` : undefined,
            }}
          />
          <div
            class="absolute inset-0 bg-background"
            style={{ opacity: String(background().spec.scrim) }}
          />
        </div>
      )}
    </Show>
  );
}

async function loadImage(
  plugin: string,
  resource: string,
  disposed: () => boolean,
): Promise<string | undefined> {
  const blob = await readBackgroundImage(plugin, resource);
  if (!blob) return undefined;
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (image.naturalWidth * image.naturalHeight > MAX_BACKGROUND_PIXELS) {
      throw new Error("background image has too many pixels");
    }
    if (disposed()) {
      URL.revokeObjectURL(url);
      return undefined;
    }
    return url;
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}
