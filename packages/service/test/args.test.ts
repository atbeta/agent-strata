import { describe, expect, test } from "bun:test";
import { coerceToolInput } from "../src/plugins/args";

const schema = { properties: { url: { type: "string" } }, required: ["url"] };

describe("the arguments a tool actually gets", () => {
  test("a normal call passes through unchanged", () => {
    expect(coerceToolInput(schema, { url: "http://localhost:4321/" })).toEqual({
      url: "http://localhost:4321/",
    });
    expect(coerceToolInput(schema, {})).toEqual({});
  });

  test("the schema object instead of an instance is unwrapped", () => {
    // What one agent sent: the parameter bag, not the arguments.
    expect(coerceToolInput(schema, { properties: { url: "http://localhost:4321/" } })).toEqual({
      url: "http://localhost:4321/",
    });
  });

  test("a JSON-encoded bag is parsed, however deeply it was nested", () => {
    // The call that failed in the wild, twice over.
    expect(
      coerceToolInput(schema, { properties: '{"url": "http://localhost:4321/"}' }),
    ).toEqual({ url: "http://localhost:4321/" });
    expect(
      coerceToolInput(schema, { properties: '{"properties": {"url": "http://localhost:4321/"}}' }),
    ).toEqual({ url: "http://localhost:4321/" });
    expect(coerceToolInput(schema, '{"properties":{"url":"http://localhost:4321/"}}')).toEqual({
      url: "http://localhost:4321/",
    });
  });

  test("a tool whose own parameter is named properties is left alone", () => {
    const own = { properties: { properties: { type: "object" }, name: { type: "string" } } };
    const input = { properties: { color: "red" }, name: "x" };
    expect(coerceToolInput(own, input)).toEqual(input);
  });

  test("junk does not become arguments", () => {
    expect(coerceToolInput(schema, "not json")).toEqual({});
    expect(coerceToolInput(schema, null)).toEqual({});
    expect(coerceToolInput(schema, ["a"])).toEqual({});
    expect(coerceToolInput(undefined, { url: "x" })).toEqual({ url: "x" });
  });
});
