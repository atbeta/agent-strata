import sprite from "./provider-icons/sprite.svg?url";
import { providerIconId } from "./provider-icon-id";
import { cn } from "./lib/utils";

/**
 * A provider's logo, from the models.dev set opencode draws its pickers with.
 *
 * The marks are single-colour and paint with `currentColor`, so a logo takes
 * the tone of the text beside it in either theme instead of carrying a brand
 * colour into a quiet toolbar.
 */
export function ProviderIcon(props: { provider: string | undefined; class?: string }) {
  return (
    <svg class={cn("size-3.5 shrink-0", props.class)} fill="currentColor" aria-hidden="true">
      <use href={`${sprite}#${providerIconId(props.provider)}`} />
    </svg>
  );
}
