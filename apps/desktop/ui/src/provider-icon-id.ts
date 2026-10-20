import { PROVIDER_ICON_FALLBACK, PROVIDER_ICONS } from "./provider-icons/names";

/**
 * The symbol that draws a provider.
 *
 * An exact id wins. A configured provider is often a known one with a suffix
 * the catalogue has never seen — `anthropic-work`, `openai-proxy` — so the id
 * is cut back a segment at a time before giving up on it. What is left after
 * that is a provider nobody has drawn, and it gets the generic mark rather than
 * a gap that would shift the model name sideways.
 */
export function providerIconId(provider: string | undefined): string {
  let id = (provider ?? "").trim().toLowerCase();
  while (id) {
    const hit = PROVIDER_ICONS[id];
    if (hit) return hit;
    const cut = id.lastIndexOf("-");
    if (cut <= 0) break;
    id = id.slice(0, cut);
  }
  return PROVIDER_ICON_FALLBACK;
}
