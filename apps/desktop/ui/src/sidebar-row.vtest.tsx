import { afterEach, expect, test, vi } from "vitest";
import { render } from "solid-js/web";
import { t } from "./i18n";
import { sessionStatus } from "./session-status";
import { SessionListItem } from "./sidebar-row";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  localStorage.clear();
  document.body.innerHTML = "";
});

test("session actions keep editing together and separate removal from navigation", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(
    () => (
      <SessionListItem
        id="session-1"
        title="Nightly"
        active={false}
        status={sessionStatus({})}
        time="12:00"
        onOpen={() => {}}
        onRename={async () => {}}
        onArchive={async () => {}}
        onDelete={() => {}}
        pinned={false}
        onTogglePin={() => {}}
        onCompare={() => {}}
        onSplitOpen={() => {}}
      />
    ),
    host,
  );

  const trigger = host.querySelector<HTMLButtonElement>("[data-row-menu]")!;
  trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  trigger.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
  trigger.click();

  const items = await vi.waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")];
    expect(found).toHaveLength(6);
    return found;
  });
  expect(items.map((item) => item.textContent)).toEqual([
    t("sidebar.session.rename"),
    t("sidebar.session.pin"),
    t("pane.split.right"),
    t("sidebar.session.compare"),
    t("sidebar.session.archive"),
    t("sidebar.session.delete"),
  ]);
  expect(document.querySelectorAll("hr")).toHaveLength(1);
  expect(items[0]!.querySelector("svg path")?.getAttribute("d")).toBe(
    "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7",
  );
  expect(items[1]!.querySelector("svg")?.classList.contains("rotate-45")).toBe(true);
  expect(items[4]!.classList.contains("text-destructive")).toBe(false);
  expect(items[5]!.classList.contains("text-destructive")).toBe(true);
});

test("the pinned marker shares the menu icon's angle", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(
    () => (
      <SessionListItem
        id="session-1"
        title="Nightly"
        active={false}
        status={sessionStatus({})}
        time="12:00"
        onOpen={() => {}}
        onRename={async () => {}}
        onArchive={async () => {}}
        onDelete={() => {}}
        pinned={true}
        onTogglePin={() => {}}
      />
    ),
    host,
  );

  const marker = host.querySelector("svg.rotate-45");
  expect(marker).not.toBeNull();
  expect(marker?.querySelector("path")?.getAttribute("d")).toBe("M12 17v5");
});

test("a deleting row stays visible but cannot be opened or changed", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const onOpen = vi.fn();
  dispose = render(
    () => (
      <SessionListItem
        id="session-1"
        title="Nightly"
        active={false}
        status={sessionStatus({})}
        time="12:00"
        onOpen={onOpen}
        onRename={async () => {}}
        onArchive={async () => {}}
        onDelete={() => {}}
        deleting={true}
        pinned={false}
        onTogglePin={() => {}}
      />
    ),
    host,
  );

  expect(host.textContent).toContain(t("sidebar.session.deleting"));
  expect(host.querySelector<HTMLButtonElement>("[data-row-menu]")?.disabled).toBe(true);
  host.querySelector<HTMLElement>("[role=button]")?.click();
  expect(onOpen).not.toHaveBeenCalled();
});
