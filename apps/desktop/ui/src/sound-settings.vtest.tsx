import { afterEach, expect, test, vi } from "vitest";
import { render } from "solid-js/web";
import { t } from "./i18n";
import { SoundSettings } from "./sound-settings";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  localStorage.clear();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

test("choosing an OpenCode sound saves it and plays the bundled audio", async () => {
  const play = vi.fn().mockResolvedValue(undefined);
  const pause = vi.fn();
  const sources: string[] = [];
  const AudioMock = class {
    volume = 1;
    constructor(src: string) {
      sources.push(src);
    }
    play = play;
    pause = pause;
  };
  vi.stubGlobal("Audio", AudioMock);
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <SoundSettings />, host);

  expect(host.textContent).toContain(t("settings.sound.agent.title"));
  expect(host.textContent).toContain(t("settings.sound.permission.title"));
  expect(host.textContent).toContain(t("settings.sound.error.title"));
  const trigger = host.querySelector<HTMLButtonElement>(
    `button[aria-label="${t("settings.sound.agent.title")}"]`,
  )!;
  expect(trigger.textContent).toContain("Staplebops 01");
  trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  trigger.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
  trigger.click();
  const item = await vi.waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find(
      (element) => element.textContent === "Nope 05",
    );
    expect(found).toBeTruthy();
    return found!;
  });
  expect(document.querySelectorAll("[role=menuitem]")).toHaveLength(46);
  expect(document.body.textContent).toContain("Staplebops");
  item.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  item.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
  item.click();

  await vi.waitFor(() => expect(localStorage.getItem("strata.sound.agent")).toBe("nope-05"));
  expect(play).toHaveBeenCalled();
  expect(sources).toContain("/sounds/opencode/nope-05.aac");
  expect(trigger.textContent).toContain("Nope 05");
  expect(localStorage.getItem("strata.sound.permission")).toBeNull();
  expect(localStorage.getItem("strata.sound.error")).toBeNull();
});
