import { describe, expect, test } from "bun:test";
import { OutputRing, terminalText } from "../src/output";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

describe("terminal output", () => {
  test("keeps absolute cursors when the bounded ring drops a prefix", () => {
    const ring = new OutputRing(5);
    ring.push(bytes("abc"));
    ring.push(bytes("defg"));
    expect(text(ring.replay())).toBe("cdefg");
    const old = ring.read(0, 10);
    expect(old.dropped).toBe(true);
    expect(text(old.data)).toBe("cdefg");
    expect(old.next_offset).toBe(7);
    expect(ring.read(7, 10)).toEqual({ data: new Uint8Array(), next_offset: 7, dropped: false });
  });

  test("reads a tail without losing the next byte offset", () => {
    const ring = new OutputRing(20);
    ring.push(bytes("abcdef"));
    const page = ring.read(undefined, 3);
    expect(text(page.data)).toBe("def");
    expect(page.next_offset).toBe(6);
  });

  test("agent output drops display controls rather than terminal text", () => {
    expect(terminalText(bytes("a\r\n\u001b[31mred\u001b[0m\u0007b"))).toBe("a\nredb");
  });
});
