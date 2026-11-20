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

  test("shares the selected file row and its line counts with session changes", () => {
    const review = readFileSync(join(import.meta.dir, "review.tsx"), "utf8");
    expect(review).toContain("<ChangeFileRow");
    expect(review).toContain("change={file.status ? changeKind(file.status) : undefined}");
    expect(review).toContain("additions={file.additions}");
    expect(review).toContain("deletions={file.deletions}");

    const row = readFileSync(join(import.meta.dir, "change-file-row.tsx"), "utf8");
    expect(row).toContain("min-w-0 flex-1");
    expect(row).toContain("block truncate text-sm");
    expect(row).toContain("num(props.additions)");
    expect(row).toContain("num(props.deletions)");
    expect(row).toContain("bg-accent");
  });
});
