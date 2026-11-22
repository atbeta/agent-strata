export type SoundKind = "agent" | "permission" | "error";
type SoundFamilyId = "alert" | "bip-bop" | "nope" | "staplebops" | "yup";
export type SoundAsset = `${SoundFamilyId}-${string}`;
export type SoundId = SoundAsset | "none";

function familySounds(id: SoundFamilyId, count: number): SoundAsset[] {
  return Array.from(
    { length: count },
    (_, index) => `${id}-${String(index + 1).padStart(2, "0")}` as SoundAsset,
  );
}

export const SOUND_FAMILIES: readonly {
  id: SoundFamilyId;
  label: string;
  sounds: readonly SoundAsset[];
}[] = [
  { id: "alert", label: "Alert", sounds: familySounds("alert", 10) },
  { id: "bip-bop", label: "Bip-bop", sounds: familySounds("bip-bop", 10) },
  { id: "staplebops", label: "Staplebops", sounds: familySounds("staplebops", 7) },
  { id: "nope", label: "Nope", sounds: familySounds("nope", 12) },
  { id: "yup", label: "Yup", sounds: familySounds("yup", 6) },
];

export const SOUND_OPTIONS: readonly SoundId[] = [
  "none",
  ...SOUND_FAMILIES.flatMap((family) => family.sounds),
];

const DEFAULT_SOUND: Record<SoundKind, SoundId> = {
  agent: "staplebops-01",
  permission: "staplebops-02",
  error: "nope-03",
};

const SOUND_KEY: Record<SoundKind, string> = {
  agent: "strata.sound.agent",
  permission: "strata.sound.permission",
  error: "strata.sound.error",
};

type SoundStorage = Pick<Storage, "getItem" | "setItem">;

function knownSound(value: string | null): value is SoundId {
  return SOUND_OPTIONS.includes(value as SoundId);
}

export function soundName(id: SoundAsset): string {
  const family = SOUND_FAMILIES.find((item) => id.startsWith(`${item.id}-`));
  return `${family?.label ?? id} ${id.slice(id.lastIndexOf("-") + 1)}`;
}

export function readSound(kind: SoundKind, storage: SoundStorage = localStorage): SoundId {
  try {
    const value = storage.getItem(SOUND_KEY[kind]);
    return knownSound(value) ? value : DEFAULT_SOUND[kind];
  } catch {
    return DEFAULT_SOUND[kind];
  }
}

export function saveSound(kind: SoundKind, id: SoundId, storage: SoundStorage = localStorage) {
  storage.setItem(SOUND_KEY[kind], id);
}

export function soundForEvent(event: {
  type?: string;
  data?: unknown;
}): SoundKind | undefined {
  if (event.type === "permission.requested") return "permission";
  if (event.type === "question.asked") return "agent";
  const data = event.data && typeof event.data === "object"
    ? event.data as Record<string, unknown>
    : {};
  if (event.type === "session.error" && data.error && typeof data.error === "object") {
    return "error";
  }
  if (event.type === "session.ended" && data.reason === "error") return "error";
  return undefined;
}

let activeAudio: HTMLAudioElement | undefined;

export function previewSound(id: SoundId) {
  activeAudio?.pause();
  activeAudio = undefined;
  if (id === "none") return;
  const audio = new Audio(`/sounds/opencode/${id}.aac`);
  audio.volume = 0.4;
  activeAudio = audio;
  void audio.play().catch(() => {});
}

export function playSound(kind: SoundKind) {
  previewSound(readSound(kind));
}
