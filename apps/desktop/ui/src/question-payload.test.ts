import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { questionAllowsCustom, questionGroups } from "./question-payload";

/**
 * `/questions` is reached through a blind cast, so nothing upstream checks the
 * shape of what comes back. `QuestionCard` mapped `q.questions` during setup
 * without a guard, and an entry without that field threw there — before the
 * dock could draw an error bar or anything else — which blanked the prompt
 * region while the agent kept holding its turn. These tests hold the edge in
 * place, plus a ratchet against the unguarded access coming back.
 */

const group = (label: string) => ({
  question: "pick one",
  header: "h",
  options: [{ label, description: "d" }],
});

describe("question payload", () => {
  test("a well-formed prompt passes through untouched", () => {
    const groups = [group("a"), group("b")];
    expect(questionGroups(groups)).toEqual(groups);
  });

  test("a missing field yields no groups instead of throwing", () => {
    // The exact shape that took the dock down: the entry is there, the field
    // under it is not. `q.questions.map(...)` at setup is a TypeError.
    expect(questionGroups(undefined)).toEqual([]);
    expect(questionGroups(null)).toEqual([]);
  });

  test("a field of the wrong type yields no groups", () => {
    // `Array.isArray` rather than a truthiness check — a payload that sends a
    // single object where a list belongs is still not iterable.
    expect(questionGroups({ question: "one" })).toEqual([]);
    expect(questionGroups("two questions")).toEqual([]);
    expect(questionGroups(3)).toEqual([]);
  });

  test("a malformed entry does not take its healthy neighbours with it", () => {
    const good = group("a");
    expect(questionGroups([good, null, undefined, "junk", 7, good])).toEqual([good, good]);
  });

  test("a group with no options survives — its choices cost, not the card", () => {
    // Losing the options list is survivable: the question text still reads and
    // the prompt can still be dismissed. Dropping the whole card is not.
    const optionsless = { ...group("a"), options: undefined as never };
    expect(questionGroups([optionsless])).toHaveLength(1);
  });

  test("custom answers are offered unless the backend says false", () => {
    // The field is optional upstream and documented as defaulting to true;
    // the card must not read it truthily, or every current prompt loses the
    // free-text row.
    expect(questionAllowsCustom(group("a"))).toBe(true);
    expect(questionAllowsCustom({ ...group("a"), custom: true })).toBe(true);
    expect(questionAllowsCustom({ ...group("a"), custom: false })).toBe(false);
  });
});

describe("QuestionCard never reads the raw field again", () => {
  const src = readFileSync(join(import.meta.dir, "session-prompts.tsx"), "utf8");

  test("the component has no direct access to q.questions", () => {
    // Exactly one reference is legitimate — the argument handed to the
    // normaliser. Once that call is set aside, nothing may name the field, so
    // a re-introduced `props.q.questions.map(...)` at setup fails here.
    const rest = src.replaceAll("questionGroups(props.q.questions)", "");
    expect(rest).not.toMatch(/props\.q\.questions/);
  });

  test("it goes through the normaliser", () => {
    expect(src).toContain("questionGroups(props.q.questions)");
  });

  test("custom answers follow the default-on rule everywhere", () => {
    // Both the input and the answer it contributes must agree on `custom`;
    // reading the raw flag truthily hid the row for today's payloads.
    expect(src).toContain("questionAllowsCustom(question)");
    expect(src).not.toMatch(/question\.custom\b/);
  });
});
