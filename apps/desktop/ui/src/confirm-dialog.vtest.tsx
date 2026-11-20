import { afterEach, expect, test, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { ConfirmDialog } from "./components/ui/confirm-dialog";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

test("a confirm dialog names the action and does not run it until the reader agrees", async () => {
  const confirm = vi.fn();
  const cancel = vi.fn();
  const [open, setOpen] = createSignal(true);
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(
    () => (
      <ConfirmDialog
        open={open()}
        title="删除「nightly」"
        description="到点后不会再执行。"
        confirmLabel="删除"
        cancelLabel="取消"
        onConfirm={confirm}
        onCancel={() => {
          cancel();
          setOpen(false);
        }}
      />
    ),
    host,
  );

  await vi.waitFor(() => expect(document.body.textContent).toContain("删除「nightly」"));
  expect(document.body.textContent).toContain("到点后不会再执行。");
  const button = (label: string) =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label);
  button("取消")!.click();
  expect(cancel).toHaveBeenCalledOnce();
  expect(confirm).not.toHaveBeenCalled();

  setOpen(true);
  await vi.waitFor(() => expect(button("删除")).toBeTruthy());
  button("删除")!.click();
  expect(confirm).toHaveBeenCalledOnce();
});
