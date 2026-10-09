import { createSignal } from "solid-js";
import { Icon } from "./icons";
import { readTheme, saveTheme, type ThemeChoice } from "./theme";

const CHOICES: { id: ThemeChoice; label: string; hint: string }[] = [
  { id: "dark", label: "Dark", hint: "The default shell" },
  { id: "light", label: "Light", hint: "A paper surface" },
  { id: "system", label: "System", hint: "Follow this computer" },
];

export function SettingsPage() {
  const [choice, setChoice] = createSignal<ThemeChoice>(readTheme());

  const pick = (next: ThemeChoice) => {
    setChoice(next);
    saveTheme(next);
  };

  return (
    <div class="mx-auto w-full max-w-lg px-8 py-10">
      <h1 class="text-xl font-medium">Settings</h1>
      <p class="mt-1 text-sm text-muted-foreground">Saved on this computer.</p>

      <section class="mt-8">
        <h2 class="text-sm font-medium">Appearance</h2>
        <div class="mt-3 grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
          {CHOICES.map((item) => (
            <button
              type="button"
              role="radio"
              aria-checked={choice() === item.id}
              class={`rounded-lg border px-3 py-3 text-left transition-colors ${
                choice() === item.id
                  ? "border-ring bg-secondary"
                  : "border-border hover:bg-secondary/60"
              }`}
              onClick={() => pick(item.id)}
            >
              <span
                class={`mb-2 block h-8 rounded-md border border-border ${
                  item.id === "light"
                    ? "bg-white"
                    : item.id === "system"
                      ? "bg-[linear-gradient(90deg,#f7f7f8_50%,#17171a_50%)]"
                      : "bg-[#17171a]"
                }`}
              />
              <span class="block text-sm font-medium">{item.label}</span>
              <span class="mt-0.5 block text-2xs text-muted-foreground">{item.hint}</span>
            </button>
          ))}
        </div>
      </section>

      <section class="mt-8 border-t border-border pt-6">
        <h2 class="text-sm font-medium">Permission policy</h2>
        <p class="mt-1 text-sm leading-5 text-muted-foreground">
          Rules that allow, ask, or deny a tool call before it runs.
        </p>
        <button
          type="button"
          class="mt-3 inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-secondary"
          onClick={() => (location.hash = "/policy")}
        >
          <Icon name="shield" class="size-3.5 text-muted-foreground" />
          Open policy
        </button>
      </section>
    </div>
  );
}
