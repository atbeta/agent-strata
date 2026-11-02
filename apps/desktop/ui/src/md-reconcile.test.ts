import { describe, expect, test } from "bun:test";
import { canPatch, reconcileList } from "./md-reconcile";

/**
 * A streaming reply is re-parsed on every token. What keeps it from blinking is
 * that the nodes before the change are patched in place instead of replaced, so
 * a paragraph that grew by three characters keeps the very node it had. The
 * measurement that found this: over a 156-character reply, the first block was
 * replaced on 154 of 156 frames.
 *
 * The project has no DOM in its test runner, so the surface `reconcileList`
 * actually touches is faked here rather than pulling in a DOM library. That
 * keeps the assertions about this module's algorithm, which is the part that can
 * be wrong, and leaves the real DOM to the browser harness.
 */

const ELEMENT = 1;
const TEXT = 3;

class FakeNode {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  childNodes: FakeNode[] = [];
  attributes: { name: string; value: string }[] = [];
  parent: FakeNode | null = null;

  constructor(nodeType: number, nodeName: string, nodeValue: string | null = null) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.nodeValue = nodeValue;
  }

  /** The value a text node exposes; `patchNode` writes through `data`. */
  get data(): string {
    return this.nodeValue ?? "";
  }
  set data(next: string) {
    this.nodeValue = next;
  }

  getAttribute(name: string): string | null {
    return this.attributes.find((a) => a.name === name)?.value ?? null;
  }

  appendChild(child: FakeNode): FakeNode {
    child.parent = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child: FakeNode): FakeNode {
    const at = this.childNodes.indexOf(child);
    if (at >= 0) this.childNodes.splice(at, 1);
    child.parent = null;
    return child;
  }

  isEqualNode(other: FakeNode): boolean {
    if (this.nodeType !== other.nodeType || this.nodeName !== other.nodeName) return false;
    if (this.nodeValue !== other.nodeValue) return false;
    if (this.attributes.length !== other.attributes.length) return false;
    for (let i = 0; i < this.attributes.length; i += 1) {
      const a = this.attributes[i]!;
      const b = other.attributes[i]!;
      if (a.name !== b.name || a.value !== b.value) return false;
    }
    if (this.childNodes.length !== other.childNodes.length) return false;
    return this.childNodes.every((c, i) => c.isEqualNode(other.childNodes[i]!));
  }
}

const el = (name: string, ...children: FakeNode[]): FakeNode => {
  const node = new FakeNode(ELEMENT, name.toUpperCase());
  for (const c of children) node.appendChild(c);
  return node;
};

const text = (value: string): FakeNode => new FakeNode(TEXT, "#text", value);

const para = (value: string): FakeNode => el("p", text(value));

/** Shorthand: reconcile, then put the resulting list in a host the way the renderer does. */
const run = (existing: FakeNode[], incoming: FakeNode[]): FakeNode => {
  const list = reconcileList(existing as unknown as Node[], incoming as unknown as Node[]) as unknown as FakeNode[];
  const host = new FakeNode(ELEMENT, "DIV");
  for (const c of list) host.appendChild(c);
  return host;
};

describe("patching a rebuilt tail into the nodes on screen", () => {
  test("a paragraph that grew keeps its own node and its own text node", () => {
    const before = para("第二段写到一半");
    const host = run([before], [para("第二段写到一半了")]);

    expect(host.childNodes.length).toBe(1);
    // The whole point: same objects, not equal copies.
    expect(host.childNodes[0]).toBe(before);
    expect((host.childNodes[0] as FakeNode).childNodes[0]!.nodeValue).toBe("第二段写到一半了");
  });

  test("a growing reply reuses the text node on every step", () => {
    let list: Node[] = [];
    const seen: FakeNode[] = [];
    for (const s of ["这", "这是", "这是一个", "这是一个回复"]) {
      list = reconcileList(list, [para(s)] as unknown as Node[]);
      seen.push((list[0] as unknown as FakeNode).childNodes[0]!);
    }
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]!.nodeValue).toBe("这是一个回复");
  });

  test("the list is returned, not written: the nodes on screen stay where they are", () => {
    const host = new FakeNode(ELEMENT, "DIV");
    const before = host.appendChild(para("一"));
    reconcileList([before] as unknown as Node[], [para("一二")] as unknown as Node[]);
    expect(host.childNodes).toEqual([before]);
    expect(before.childNodes[0]!.nodeValue).toBe("一二");
  });

  test("a finished block before the change is left alone", () => {
    const first = para("一");
    const second = para("二写到一半");
    const host = run([first, second], [para("一"), para("二写到一半了")]);

    expect(host.childNodes[0]).toBe(first);
    expect(host.childNodes[1]).toBe(second);
  });

  test("an appended block keeps everything already painted", () => {
    const first = para("一");
    const host = run([first], [para("一"), para("二")]);

    expect(host.childNodes.length).toBe(2);
    expect(host.childNodes[0]).toBe(first);
    expect((host.childNodes[1] as FakeNode).childNodes[0]!.nodeValue).toBe("二");
  });

  test("a shorter tail drops what is no longer there", () => {
    const host = run([para("一"), para("二")], [para("一")]);
    expect(host.childNodes.length).toBe(1);
    expect((host.childNodes[0] as FakeNode).childNodes[0]!.nodeValue).toBe("一");
  });

  test("an emptied tail leaves the host empty", () => {
    expect(run([para("一")], []).childNodes.length).toBe(0);
  });

  test("a different tag is replaced, not patched around", () => {
    const before = para("一");
    const host = run([before], [el("h2", text("一"))]);
    expect(host.childNodes[0]).not.toBe(before);
    expect(host.childNodes[0]!.nodeName).toBe("H2");
  });

  test("a changed attribute rebuilds the block", () => {
    const before = el("pre");
    before.attributes = [{ name: "class", value: "language-ts" }];
    const after = el("pre");
    after.attributes = [{ name: "class", value: "language-rs" }];

    const host = run([before], [after]);
    expect(host.childNodes[0]).not.toBe(before);
    expect((host.childNodes[0] as FakeNode).getAttribute("class")).toBe("language-rs");
  });

  test("a node after the first real difference is rebuilt", () => {
    const kept = para("一");
    const doomed = el("div", text("old"));
    const host = run([kept, doomed], [para("一"), el("pre", text("new"))]);

    expect(host.childNodes[0]).toBe(kept);
    expect(host.childNodes[1]).not.toBe(doomed);
    expect(host.childNodes[1]!.nodeName).toBe("PRE");
  });

  test("canPatch asks about shape, not content", () => {
    expect(canPatch({ nodeType: TEXT, nodeName: "#text" }, { nodeType: TEXT, nodeName: "#text" })).toBe(true);
    expect(canPatch({ nodeType: ELEMENT, nodeName: "P" }, { nodeType: ELEMENT, nodeName: "P" })).toBe(true);
    expect(canPatch({ nodeType: ELEMENT, nodeName: "P" }, { nodeType: ELEMENT, nodeName: "DIV" })).toBe(false);
    expect(canPatch({ nodeType: TEXT, nodeName: "#text" }, { nodeType: ELEMENT, nodeName: "P" })).toBe(false);
  });
});
