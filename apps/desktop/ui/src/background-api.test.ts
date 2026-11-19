import { describe, expect, test } from "bun:test";
import { parseBackgroundSpec } from "./background-api";

describe("the background resource contract", () => {
  test("accepts a complete spec and clamps display values", () => {
    expect(parseBackgroundSpec({
      version: 1,
      image: { resource: "image" },
      fit: "contain",
      opacity: 1.5,
      blur: -2,
      scrim: 2,
    })).toEqual({
      fit: "contain",
      opacity: 1,
      blur: 0,
      scrim: 0.8,
      image: { resource: "image" },
    });
  });

  test("rejects malformed or unsupported values instead of drawing them", () => {
    expect(parseBackgroundSpec(null)).toBeNull();
    expect(parseBackgroundSpec({ version: 2 })).toBeNull();
    expect(parseBackgroundSpec({
      version: 1,
      image: null,
      fit: "cover",
      opacity: 1,
      blur: 0,
      scrim: 0,
    })).toMatchObject({ image: null });
    expect(parseBackgroundSpec({
      version: 1,
      image: "image",
      fit: "cover",
      opacity: 1,
      blur: 0,
      scrim: 0,
    })).toBeNull();
    expect(parseBackgroundSpec({
      version: 1,
      image: null,
      fit: "cover",
      opacity: Number.NaN,
      blur: 0,
      scrim: 0,
    })).toBeNull();
  });
});
