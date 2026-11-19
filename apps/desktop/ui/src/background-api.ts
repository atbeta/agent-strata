import { apiFetch } from "./api";
import { t } from "./i18n";

export interface BackgroundSpec {
  fit: "cover" | "contain";
  opacity: number;
  blur: number;
  scrim: number;
  image: { resource: string } | null;
}

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
export const MAX_BACKGROUND_IMAGE_BYTES = 12 * 1024 * 1024;

export function parseBackgroundSpec(value: unknown): BackgroundSpec | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || (input.fit !== "cover" && input.fit !== "contain")) return null;
  if (
    typeof input.opacity !== "number" || !Number.isFinite(input.opacity) ||
    typeof input.blur !== "number" || !Number.isFinite(input.blur) ||
    typeof input.scrim !== "number" || !Number.isFinite(input.scrim)
  ) {
    return null;
  }
  const image = input.image;
  if (
    image !== null &&
    (!image || typeof image !== "object" || Array.isArray(image) ||
      typeof (image as Record<string, unknown>).resource !== "string")
  ) {
    return null;
  }
  return {
    fit: input.fit,
    opacity: Math.min(1, Math.max(0, input.opacity)),
    blur: Math.min(24, Math.max(0, input.blur)),
    scrim: Math.min(0.8, Math.max(0, input.scrim)),
    image: image ? { resource: (image as Record<string, unknown>).resource as string } : null,
  };
}

async function responseError(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return new Error(typeof body?.error === "string" ? body.error : t("err.service", { status: res.status }));
}

export async function readBackgroundSpec(
  plugin = "background",
  resource = "background",
): Promise<BackgroundSpec | null> {
  const res = await apiFetch(
    `/plugins/${encodeURIComponent(plugin)}/resources/${encodeURIComponent(resource)}`,
    { cache: "no-store" },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw await responseError(res);
  return parseBackgroundSpec(await res.json().catch(() => null));
}

export async function readBackgroundImage(
  plugin: string,
  resource: string,
): Promise<Blob | undefined> {
  const res = await apiFetch(
    `/plugins/${encodeURIComponent(plugin)}/resources/${encodeURIComponent(resource)}`,
    { cache: "no-store" },
  );
  if (res.status === 404) return undefined;
  if (!res.ok) throw await responseError(res);
  const blob = await res.blob();
  const mime = blob.type.toLowerCase();
  if (!IMAGE_MIMES.has(mime) || blob.size > MAX_BACKGROUND_IMAGE_BYTES) {
    throw new Error("invalid background image");
  }
  return blob;
}

export async function uploadBackgroundImage(image: Blob): Promise<void> {
  const res = await apiFetch("/plugins/background/image", {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: image,
  });
  if (!res.ok) throw await responseError(res);
}

export async function deleteBackgroundImage(): Promise<void> {
  const res = await apiFetch("/plugins/background/image", { method: "DELETE" });
  if (!res.ok) throw await responseError(res);
}
