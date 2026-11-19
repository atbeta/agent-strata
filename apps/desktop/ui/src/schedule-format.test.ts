import { describe, expect, test } from "bun:test";
import {
  clockText,
  dateTimeText,
  fromLocalInputValue,
  parseClock,
  relativeTimeText,
  runResultText,
  runResultTone,
  scheduleFacts,
  showsTargetLine,
  targetText,
  toLocalInputValue,
  weekdayName,
  whenText,
  type ScheduleLike,
} from "./schedule-format";
import { locale, setLocale } from "./i18n";

/** Run `body` in `lang`, then hand the window back the language it had. */
function withLocale(lang: "zh" | "en", body: () => void): void {
  const previous = locale();
  setLocale(lang);
  try {
    body();
  } finally {
    setLocale(previous);
  }
}

const row = (over: Partial<ScheduleLike> = {}): ScheduleLike => ({
  id: "sch_1",
  name: "standup",
  prompt: "post the summary",
  enabled: true,
  when: { kind: "daily", hour: 9, minute: 0 },
  target: { kind: "session", session_id: "opencode:me" },
  next_at: null,
  ...over,
});

describe("a weekly schedule's weekday", () => {
  test("is the reader's word for it, not a number", () => {
    withLocale("zh", () => {
      expect(weekdayName(0)).toBe("周日");
      expect(weekdayName(5)).toBe("周五");
    });
    withLocale("en", () => {
      expect(weekdayName(0)).toBe("Sunday");
      expect(weekdayName(5)).toBe("Friday");
    });
  });

  test("an out-of-range weekday reads as nothing rather than as a wrong day", () => {
    expect(weekdayName(7)).toBe("");
    expect(weekdayName(undefined)).toBe("");
    expect(weekdayName(-1)).toBe("");
  });
});

describe("a run result", () => {
  test("says what happened, in the reader's language", () => {
    withLocale("zh", () => {
      expect(runResultText("ok")).toBe("成功");
      expect(runResultText("skipped-busy")).toContain("忙");
      expect(runResultText("failed")).toBe("失败");
    });
    withLocale("en", () => {
      expect(runResultText("ok")).toBe("Succeeded");
      expect(runResultText("skipped-busy")).toContain("busy");
    });
  });

  test("an unknown result is not invented into a word", () => {
    expect(runResultText("something-new")).toBe("");
    expect(runResultText(undefined)).toBe("");
  });
});

describe("the line that says when a schedule runs", () => {
  test("a daily schedule names its clock time", () => {
    withLocale("zh", () => {
      expect(whenText({ kind: "daily", hour: 9, minute: 5 })).toBe("每天 09:05");
    });
  });

  test("a weekly schedule names the weekday in words", () => {
    withLocale("en", () => {
      expect(whenText({ kind: "weekly", weekday: 5, hour: 18, minute: 0 })).toBe("Every Friday at 18:00");
    });
    withLocale("zh", () => {
      expect(whenText({ kind: "weekly", weekday: 5, hour: 18, minute: 0 })).toContain("周五");
    });
  });

  test("an interval names its minutes", () => {
    withLocale("zh", () => {
      expect(whenText({ kind: "every", everyMs: 30 * 60_000 })).toBe("每 30 分钟");
    });
  });
});

describe("the session a prompt lands in", () => {
  test("this session is named as such", () => {
    withLocale("zh", () => {
      expect(targetText(row(), "opencode:me")).toBe("本会话");
    });
  });

  test("another session is named by its title when one is known", () => {
    withLocale("en", () => {
      // The target is a different session from the one being looked at,
      // so its name is what the reader is told.
      const other = row({ target_title: "Fix the login" });
      expect(targetText(other, "opencode:elsewhere")).toBe("Fix the login");
    });
  });

  test("a session with no title falls back to its id rather than to nothing", () => {
    expect(targetText(row(), "opencode:other")).toBe("opencode:me");
  });

  test("a new-session target says so", () => {
    withLocale("zh", () => {
      expect(targetText(row({ target: { kind: "new_session" } }), "opencode:me")).toBe("每次新建会话");
    });
  });

  test("a schedule aimed here does not draw the target line twice", () => {
    // "生效会话" beside "本会话" says the same thing twice.
    expect(showsTargetLine(row(), "opencode:me")).toBe(false);
    expect(showsTargetLine(row(), "opencode:elsewhere")).toBe(true);
    expect(showsTargetLine(row({ target: { kind: "new_session" } }), "opencode:me")).toBe(true);
  });
});

describe("a time relative to now", () => {
  const now = Date.parse("2026-11-19T10:00:00");

  test("minutes away are minutes, hours away are hours", () => {
    withLocale("zh", () => {
      expect(relativeTimeText(now + 3 * 60_000, now)).toBe("3 分钟后");
      expect(relativeTimeText(now + 2 * 3_600_000, now)).toBe("2 小时后");
      expect(relativeTimeText(now + 3 * 86_400_000, now)).toBe("3 天后");
    });
  });

  test("the past reads as the past", () => {
    withLocale("zh", () => {
      expect(relativeTimeText(now - 2 * 3_600_000, now)).toBe("2 小时前");
    });
    withLocale("en", () => {
      expect(relativeTimeText(now - 2 * 3_600_000, now)).toContain("ago");
    });
  });
});

describe("the one-shot's moment", () => {
  test("survives the round trip through a datetime-local value", () => {
    const ms = new Date(2026, 11, 1, 9, 0, 0, 0).getTime();
    const value = toLocalInputValue(ms);
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    // The instant that comes back is the same wall-clock moment the reader
    // picked — not the same moment shifted by a timezone.
    const back = fromLocalInputValue(value);
    expect(back).not.toBeNull();
    expect(new Date(back!).getHours()).toBe(9);
    expect(new Date(back!).getDate()).toBe(1);
  });

  test("an empty or broken value is not a moment", () => {
    expect(fromLocalInputValue("")).toBeNull();
    expect(fromLocalInputValue("not a time")).toBeNull();
  });
});

describe("a clock time", () => {
  test("is padded to two digits on both sides", () => {
    expect(clockText(9, 5)).toBe("09:05");
    expect(clockText(18, 0)).toBe("18:00");
  });

  test("a missing part is not a time", () => {
    expect(clockText(undefined, 0)).toBe("");
  });

  test("a typed clock is read as 24-hour, and a machine's AM is not", () => {
    expect(parseClock("9:05")).toEqual({ hour: 9, minute: 5 });
    expect(parseClock("18:00")).toEqual({ hour: 18, minute: 0 });
    expect(parseClock("09:00 AM")).toBeNull();
    expect(parseClock("24:00")).toBeNull();
    expect(parseClock("")).toBeNull();
  });
});

describe("the one line under a card", () => {
  const now = Date.parse("2026-11-19T10:00:00");

  test("this session drops the target, and the last run keeps its result", () => {
    withLocale("zh", () => {
      const facts = scheduleFacts(
        row({
          next_at: new Date(now + 2 * 3_600_000).toISOString(),
          last_result: "ok",
          last_run_at: new Date(now - 20 * 3_600_000).toISOString(),
        }),
        "opencode:me",
        now,
      );
      expect(facts.target).toBe("");
      expect(facts.next).toBe("下次 2 小时后");
      expect(facts.last).toBe("成功，20 小时前");
      expect(facts.tone).toBe("neutral");
    });
  });

  test("another session is named, and a skip is not told as a success", () => {
    withLocale("zh", () => {
      const facts = scheduleFacts(
        row({
          target_title: "发布流水线",
          next_at: new Date(now + 3 * 86_400_000).toISOString(),
          last_result: "skipped-busy",
          last_run_at: new Date(now - 4 * 86_400_000).toISOString(),
        }),
        "opencode:elsewhere",
        now,
      );
      expect(facts.target).toBe("发到 发布流水线");
      expect(facts.next).toContain("3 天后");
      expect(facts.last).toContain("跳过");
      expect(facts.tone).toBe("warn");
    });
  });

  test("a paused schedule says so instead of inventing a next fire", () => {
    withLocale("zh", () => {
      const facts = scheduleFacts(
        row({ enabled: false, last_result: "failed", last_run_at: new Date(now - 2 * 86_400_000).toISOString() }),
        "opencode:me",
        now,
      );
      expect(facts.next).toBe("已暂停");
      expect(facts.last).toContain("失败");
      expect(facts.tone).toBe("bad");
    });
  });

  test("a schedule that has never fired says that, in either language", () => {
    withLocale("en", () => {
      const facts = scheduleFacts(row({ target: { kind: "new_session" } }), "opencode:me", now);
      expect(facts.target).toContain("new session");
      expect(facts.last).toContain("not run");
      expect(runResultTone("missed")).toBe("bad");
      expect(runResultTone("ok")).toBe("neutral");
    });
  });
});

describe("a date a reader can read", () => {
  test("carries the day and the clock, not a timestamp", () => {
    const text = dateTimeText(new Date(2026, 11, 1, 9, 0).getTime());
    expect(text).toContain("09:00");
    expect(text).not.toContain("2026-12-01T");
  });

  test("is in the window's language, not the machine's", () => {
    const ms = new Date(2026, 11, 1, 9, 0).getTime();
    withLocale("zh", () => {
      expect(dateTimeText(ms)).toContain("12月");
    });
    withLocale("en", () => {
      expect(dateTimeText(ms)).toContain("Dec");
    });
  });
});
