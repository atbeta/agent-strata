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
    expect(terminalText(bytes("\u001b]0;title\u0007next"))).toBe("next");
  });

  test("a carriage return rewrites the line instead of starting another", () => {
    expect(terminalText(bytes("hello\rworld"))).toBe("world");
    expect(terminalText(bytes("\r10%\r100%\n"))).toBe("100%\n");
    expect(terminalText(bytes("hello\r\u001b[Kworld\n"))).toBe("world\n");
  });

  test("a row that fills the width stays its own row", () => {
    // `ps` truncates its own output to the terminal width, so a finished row
    // is exactly as wide as the margin. Rejoining on the width would join two
    // finished rows and lose the line between them, so the width is not used
    // to rejoin anything.
    expect(terminalText(bytes("12345678\nnext line\n"))).toBe("12345678\nnext line\n");
    expect(terminalText(bytes("AAAAAAAA\nBBBBBBBB\nCCCCCCCC\n"))).toBe(
      "AAAAAAAA\nBBBBBBBB\nCCCCCCCC\n",
    );
  });

  test("a tab between fields is kept", () => {
    expect(terminalText(bytes("name\tvalue\n1\t2\n"))).toBe("name\tvalue\n1\t2\n");
  });

  test("a character-set escape leaves nothing behind", () => {
    expect(terminalText(bytes("x\u001b(B\u001b[0my\n"))).toBe("xy\n");
  });

  test("a banner's run of blank lines collapses to one", () => {
    expect(terminalText(bytes("banner\n\n\n\nps\n"))).toBe("banner\n\nps\n");
  });
});
