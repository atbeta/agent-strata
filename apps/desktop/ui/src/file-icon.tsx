import { Icon } from "./icons";
import { fileKind } from "./file-kind";

export function FileTypeIcon(props: { name: string }) {
  const kind = () => fileKind(props.name);
  return (
    <span aria-hidden="true" class="inline-flex size-4 shrink-0 items-center justify-center">
      {kind().mark ? (
        <span
          class={`inline-flex h-3.5 w-4 items-center justify-center rounded-[3px] font-sans font-semibold leading-none ${
            kind().mark!.length > 2 ? "text-[6.5px]" : "text-[8px]"
          } ${kind().tone}`}
        >
          {kind().mark}
        </span>
      ) : (
        <Icon name={kind().icon ?? "page"} class={`size-3.5 ${kind().tone}`} />
      )}
    </span>
  );
}
