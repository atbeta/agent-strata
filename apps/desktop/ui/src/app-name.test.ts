import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { APP_NAME } from "./app-name";

/**
 * The packaged build and the panels have to call the same thing the same way.
 * The shell titles its window from `tauri.conf.json` while the panels read the
 * constant, so a rename that only reaches one of them shows two different
 * names in the same window.
 */
const conf = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src-tauri/tauri.conf.json", import.meta.url)), "utf8"),
) as { productName?: string; app?: { windows?: { title?: string }[] } };

describe("app name", () => {
  test("the packaged build carries the same name", () => {
    expect(conf.productName).toBe(APP_NAME);
  });

  test("the window opens with that name", () => {
    expect(conf.app?.windows?.[0]?.title).toBe(APP_NAME);
  });
});
