import { createSignal } from "solid-js";

/**
 * Providers the reader has chosen not to see in the model picker.
 *
 * A company-wide OpenCode installation serves every department's providers
 * from one place, so the list a person actually uses is a small subset of what
 * the server reports. Hiding is a display choice, not a permission: the
 * credentials stay where OpenCode put them, a session already running on a
 * hidden provider keeps running, and clearing the selection brings every row
 * back. It therefore lives beside pins and lenses in this window's storage
 * rather than in the event log.
 */
export const HIDDEN_PROVIDERS_KEY = "strata.hiddenProviders";

type ReadStorage = Pick<Storage, "getItem"> | undefined;
type WriteStorage = Pick<Storage, "setItem"> | undefined;

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** A stored list, read defensively: the key is a preference, not a contract. */
export function readHiddenProviders(storage: ReadStorage = browserStorage()): ReadonlySet<string> {
  try {
    const raw = storage?.getItem(HIDDEN_PROVIDERS_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((value): value is string => typeof value === "string" && value.length > 0),
    );
  } catch {
    return new Set();
  }
}

/** Stable order, so the same selection always writes the same bytes. */
export function serializeHiddenProviders(hidden: ReadonlySet<string>): string {
  return JSON.stringify([...hidden].sort());
}

const [hidden, setHidden] = createSignal<ReadonlySet<string>>(readHiddenProviders());

/** The live selection. Reading this inside a render pass subscribes to it. */
export function hiddenProviders(): ReadonlySet<string> {
  return hidden();
}

export function setProviderHidden(
  providerId: string,
  isHidden: boolean,
  storage: WriteStorage = browserStorage(),
): void {
  const next = new Set(hidden());
  if (isHidden) next.add(providerId);
  else next.delete(providerId);
  setHidden(next);
  try {
    storage?.setItem(HIDDEN_PROVIDERS_KEY, serializeHiddenProviders(next));
  } catch {
    // A window that cannot store a preference still honours it for this run.
  }
}

export function showAllProviders(storage: WriteStorage = browserStorage()): void {
  setHidden(new Set<string>());
  try {
    storage?.setItem(HIDDEN_PROVIDERS_KEY, serializeHiddenProviders(new Set<string>()));
  } catch {
    // as above
  }
}

export function isProviderVisible(
  providerId: string,
  hiddenIds: ReadonlySet<string> = hidden(),
): boolean {
  return !hiddenIds.has(providerId);
}

/** The providers a picker may offer; `rows` keeps its original order. */
export function visibleProviders<T extends { id: string }>(
  rows: readonly T[],
  hiddenIds: ReadonlySet<string> = hidden(),
): T[] {
  return rows.filter((row) => !hiddenIds.has(row.id));
}

/** The models a picker may offer; hiding is by the provider that owns them. */
export function visibleModels<T extends { providerID: string }>(
  models: readonly T[],
  hiddenIds: ReadonlySet<string> = hidden(),
): T[] {
  return models.filter((model) => !hiddenIds.has(model.providerID));
}

/** A model as the pickers need it: the provider is what visibility is keyed on. */
export interface PickableModel {
  providerID: string;
  modelID: string;
}

export interface ModelPickerOption {
  value: string;
  label: string;
  group: string;
}

/**
 * What the model picker should offer.
 *
 * The current model is kept even when its provider is hidden or the server no
 * longer lists it. Dropping it would let the composer snap to another model the
 * reader never chose; keeping it under its own group says why it is still
 * there. Group labels arrive from the caller so this stays free of i18n.
 */
export function modelPickerOptions<T extends PickableModel>(
  models: readonly T[],
  current: string | undefined,
  hiddenIds: ReadonlySet<string>,
  labels: { hidden: string; unavailable: string },
): ModelPickerOption[] {
  const shown = visibleModels(models, hiddenIds);
  const known = new Set(shown.map((model) => `${model.providerID}/${model.modelID}`));
  if (!current || known.has(current)) {
    return shown.map((model) => ({
      value: `${model.providerID}/${model.modelID}`,
      label: model.modelID,
      group: model.providerID,
    }));
  }
  const found = models.find((model) => `${model.providerID}/${model.modelID}` === current);
  const slash = current.indexOf("/");
  const label = slash >= 0 ? current.slice(slash + 1) : current;
  return [
    {
      value: current,
      label: found ? found.modelID : label,
      group: found ? labels.hidden : labels.unavailable,
    },
    ...shown.map((model) => ({
      value: `${model.providerID}/${model.modelID}`,
      label: model.modelID,
      group: model.providerID,
    })),
  ];
}
