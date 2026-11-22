import { createSignal, For, Show } from "solid-js";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuPrimitive,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "./icons";
import { t } from "./i18n";
import { Card, Group, Row, pickerTrigger } from "./settings-blocks";
import { Tip } from "./tip";
import {
  playSound,
  previewSound,
  readSound,
  saveSound,
  soundName,
  SOUND_FAMILIES,
  type SoundId,
  type SoundKind,
} from "./sound";

const KINDS: readonly SoundKind[] = ["agent", "permission", "error"];

function soundLabel(id: SoundId): string {
  return id === "none" ? t("settings.sound.none") : soundName(id);
}

function SoundPicker(props: {
  kind: SoundKind;
  value: SoundId;
  onChange: (id: SoundId) => void;
}) {
  const label = () => t(`settings.sound.${props.kind}.title`);
  return (
    <div class="flex w-full items-center gap-2">
      <div class="min-w-0 flex-1">
        <DropdownMenu>
          <DropdownMenuTrigger class={pickerTrigger} aria-label={label()}>
            <span class="truncate">{soundLabel(props.value)}</span>
            <Icon name="chevron" class="size-3 shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent class="max-h-80 w-[var(--kb-popper-anchor-width)] min-w-0 overflow-y-auto">
            <DropdownMenuItem onSelect={() => props.onChange("none")}>
              <span class="min-w-0 flex-1 truncate">{t("settings.sound.none")}</span>
              <Show when={props.value === "none"}>
                <Icon name="check" class="ml-auto size-3 shrink-0" />
              </Show>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <For each={SOUND_FAMILIES}>
              {(family) => (
                <DropdownMenuPrimitive.Group>
                  <DropdownMenuGroupLabel>{family.label}</DropdownMenuGroupLabel>
                  <For each={family.sounds}>
                    {(id) => (
                      <DropdownMenuItem onSelect={() => props.onChange(id)}>
                        <span class="min-w-0 flex-1 truncate">{soundName(id)}</span>
                        <Show when={id === props.value}>
                          <Icon name="check" class="ml-auto size-3 shrink-0" />
                        </Show>
                      </DropdownMenuItem>
                    )}
                  </For>
                </DropdownMenuPrimitive.Group>
              )}
            </For>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Tip label={t("settings.sound.preview")}>
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          aria-label={t("settings.sound.previewFor", { name: label() })}
          disabled={props.value === "none"}
          onClick={() => playSound(props.kind)}
        >
          <Icon name="play" class="size-3.5" />
        </Button>
      </Tip>
    </div>
  );
}

export function SoundSettings() {
  const [choices, setChoices] = createSignal<Record<SoundKind, SoundId>>({
    agent: readSound("agent"),
    permission: readSound("permission"),
    error: readSound("error"),
  });
  const choose = (kind: SoundKind, id: SoundId) => {
    saveSound(kind, id);
    setChoices((current) => ({ ...current, [kind]: id }));
    previewSound(id);
  };
  return (
    <Group label={t("settings.sound.group")} hint={t("settings.sound.hint")}>
      <Card>
        <For each={KINDS}>
          {(kind) => (
            <Row
              label={t(`settings.sound.${kind}.title`)}
              hint={t(`settings.sound.${kind}.description`)}
            >
              <SoundPicker kind={kind} value={choices()[kind]} onChange={(id) => choose(kind, id)} />
            </Row>
          )}
        </For>
      </Card>
    </Group>
  );
}
