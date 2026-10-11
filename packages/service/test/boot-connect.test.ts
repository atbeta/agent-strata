import { describe, expect, test } from "bun:test";
import { bootPlan } from "../src/boot-connect";

describe("bootPlan", () => {
  test("an explicit URL keeps retrying and remembered addresses are probed once", () => {
    const plan = bootPlan(
      [{ baseUrl: "http://127.0.0.1:53349" }, { baseUrl: "http://127.0.0.1:1" }, { baseUrl: "http://127.0.0.1:4096" }],
      "http://127.0.0.1:53349",
    );
    expect(plan.map((item) => [item.body.baseUrl, item.mode])).toEqual([
      ["http://127.0.0.1:53349", "retry"],
      ["http://127.0.0.1:1", "once"],
      ["http://127.0.0.1:4096", "once"],
    ]);
  });

  test("without an explicit URL the most recently remembered one keeps retrying", () => {
    const plan = bootPlan([{ baseUrl: "http://127.0.0.1:4096" }, { baseUrl: "http://127.0.0.1:53349" }]);
    expect(plan.map((item) => item.mode)).toEqual(["once", "retry"]);
  });

  test("an empty list connects nothing", () => {
    expect(bootPlan([])).toEqual([]);
  });
});
