/**
 * The model the reader last chose by hand.
 *
 * A new session has no model of its own, so the picker used to land on whatever
 * the server listed first. A choice made in one conversation is about the next
 * one they start, not about conversations that already ran on something else,
 * so this is read only when a session has no model to inherit.
 */
export const PREFERRED_MODEL_KEY = "strata.model";

type ReadStorage = Pick<Storage, "getItem"> | undefined;
type WriteStorage = Pick<Storage, "setItem"> | undefined;

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** `provider/model`, or nothing when the key is missing or not that shape. */
export function readPreferredModel(storage: ReadStorage = browserStorage()): string | undefined {
  try {
    const raw = storage?.getItem(PREFERRED_MODEL_KEY);
    if (!raw || !raw.includes("/")) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

export function writePreferredModel(id: string, storage: WriteStorage = browserStorage()): void {
  if (!id.includes("/")) return;
  try {
    storage?.setItem(PREFERRED_MODEL_KEY, id);
  } catch {
    // A window that cannot store a preference still honours it for this run.
  }
}

export function modelId(model: { providerID: string; modelID: string }): string {
  return `${model.providerID}/${model.modelID}`;
}

/**
 * The picker value for a session that has not used a model yet.
 * The remembered choice wins when the server still offers it; otherwise the
 * first model the picker would have shown anyway.
 */
export function preferredNewSessionModel(
  models: readonly { providerID: string; modelID: string }[],
  remembered: string | undefined,
): string | undefined {
  if (remembered && models.some((model) => modelId(model) === remembered)) return remembered;
  const first = models[0];
  return first ? modelId(first) : undefined;
}

/**
 * What the picker should show.
 *
 * `undefined` means leave it: the session's own view is not in hand yet, or
 * the reader has already moved the picker. An inherited model belongs to that
 * conversation. Only a session with none of its own takes the remembered choice.
 */
export function modelForComposer(input: {
  touched: boolean;
  ready: boolean;
  inherited: string | undefined;
  models: readonly { providerID: string; modelID: string }[];
  remembered: string | undefined;
}): string | undefined {
  if (input.touched || !input.ready) return undefined;
  if (input.inherited) return input.inherited;
  return preferredNewSessionModel(input.models, input.remembered);
}
