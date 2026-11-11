import { describe, expect, test } from "bun:test";
import { LogBuffer, MAX_LOG_LINES } from "../src/log-buffer";
import { announcedPort, decodeLine, readOutput, stripAnsi } from "../src/output";

function stream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("output", () => {
  test("decodes lines after joining chunks and filters terminal control records", async () => {
    const encoder = new TextEncoder();
    const lines: string[] = [];
    await readOutput(
      stream([
        encoder.encode("\u001b[32mrea"),
        encoder.encode("dy\u001b[0m\r\n#< CLIXML\n<Objs><Obj>progress</Obj></Objs>\n"),
        new Uint8Array([0xc6, 0xf4, 0xb6, 0xaf, 0xb3, 0xc9, 0xb9, 0xa6, 0x0a]),
        encoder.encode("after"),
      ]),
      (line) => lines.push(line),
    );
    expect(lines).toEqual(["ready", "启动成功", "after"]);
  });

  test("keeps the announced port matcher and decoding rules unchanged", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
    expect(decodeLine(new Uint8Array([0xc6, 0xf4, 0xb6, 0xaf, 0xb3, 0xc9, 0xb9, 0xa6]))).toBe("启动成功");
    expect(announcedPort("Listening on http://localhost:45999/path")).toBe(45999);
    expect(announcedPort("http://[::]:8080")).toBe(8080);
    expect(announcedPort("localhost:1")).toBeUndefined();
    expect(announcedPort("localhost:65536")).toBeUndefined();
  });
});

describe("LogBuffer", () => {
  test("keeps sequence cursors independent of timestamps and markers", () => {
    const logs = new LogBuffer();
    logs.push("err", "--- restart ---", 10, true);
    expect(logs.hasOutput).toBe(false);
    expect(logs.lastOutputAt).toBeUndefined();
    const first = logs.push("out", "first", 20);
    const second = logs.push("err", "second", 30);
    expect(logs.hasOutput).toBe(true);
    expect(logs.lastOutputAt).toBe(30);
    expect(logs.read({ offset: first.seq })).toEqual({ lines: [second], next_offset: second.seq, dropped: false });
    expect(logs.read({ since: first.at }).lines).toEqual([second]);
    expect(logs.read({ offset: second.seq })).toEqual({ lines: [], next_offset: second.seq, dropped: false });
  });

  test("reports cursors into the trimmed part of the ring", () => {
    const logs = new LogBuffer();
    for (let i = 0; i < MAX_LOG_LINES + 5; i++) logs.push("out", `n${i}`, i);
    const page = logs.read({ offset: 0 });
    expect(page.lines).toHaveLength(MAX_LOG_LINES);
    expect(page.lines[0]?.seq).toBe(6);
    expect(page.next_offset).toBe(MAX_LOG_LINES + 5);
    expect(page.dropped).toBe(true);
    expect(logs.read().lines).toHaveLength(200);
  });
});
