import { describe, expect, test } from "bun:test";
import { filesKeyOf } from "../src/files-key";

describe("filesKeyOf", () => {
  test("names a files list by its length and the sum of each file's count", () => {
    expect(filesKeyOf({ files_changed: [] })).toBe("0:0");
    expect(
      filesKeyOf({
        files_changed: [
          { path: "a", change: "modify", count: 2, additions: 1, deletions: 0, edits: [], unexplained: false },
          { path: "b", change: "add", count: 1, additions: 3, deletions: 0, edits: [], unexplained: true },
        ],
      }),
    ).toBe("2:3");
  });
});
