import type { Component } from "solid-js";
import { EmptyState } from "@/components/ui/empty-state";
import { BackgroundImageSettings } from "./background-image-settings";
import { t } from "./i18n";
import { MemorySettings } from "./memory-settings";

export interface PluginSettingsComponentProps {
  disabled: boolean;
  onEnable: () => void;
  onChanged: () => void | Promise<void>;
}

const COMPONENTS: Record<string, Component<PluginSettingsComponentProps>> = {
  background: (props) => <BackgroundImageSettings onChanged={props.onChanged} />,
  memory: (props) => <MemorySettings disabled={props.disabled} onEnable={props.onEnable} />,
};

export function PluginSettingsComponent(props: PluginSettingsComponentProps & { name: string }) {
  const Component = COMPONENTS[props.name];
  return Component ? (
    <Component disabled={props.disabled} onEnable={props.onEnable} onChanged={props.onChanged} />
  ) : (
    <EmptyState
      icon="plug"
      layout="inline"
      title={t("settings.plugins.settings.unavailable")}
      description={t("settings.plugins.settings.unavailableHint")}
    />
  );
}
