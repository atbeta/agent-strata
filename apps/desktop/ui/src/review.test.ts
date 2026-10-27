import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { locale, setLocale, t } from "./i18n";

function withLocale(lang: "zh" | "en", body: () => void): void {
  const previous = locale();
  setLocale(lang);
  try {
    body();
  } finally {
    setLocale(previous);
  }
}

describe("review file status", () => {
  test("uses the existing Chinese and English labels", () => {
    withLocale("zh", () => {
      expect(t("file.added")).toBe("新增");
      expect(t("file.deleted")).toBe("删除");
      expect(t("file.edited")).toBe("修改");
    });
    withLocale("en", () => {
      expect(t("file.added")).toBe("added");
      expect(t("file.deleted")).toBe("deleted");
      expect(t("file.edited")).toBe("edited");
    });
  });

  test("keeps the filename truncation and line counts beside the status", () => {
    const src = readFileSync(join(import.meta.dir, "review.tsx"), "utf8");
    expect(src).toContain('modified: "file.edited"');
    expect(src).toContain("t(STATUS_LABEL[status()])");
    expect(src).toContain("min-w-0 flex-1 truncate text-sm");
    expect(src).toContain("+{f.additions}");
    expect(src).toContain("−{f.deletions}");
  });
});
