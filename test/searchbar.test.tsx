import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { createElement, useState } from "react";
import { SearchBar } from "../src/ui/components/SearchBar";

function Harness({ initial = "hello" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return createElement(SearchBar, {
    value,
    active: true,
    onChange: setValue,
    onSubmit: () => {},
    onCancel: () => {},
    width: 40,
  });
}

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const BACKSPACE = "\x7f";
const DELETE = "\x1b[3~";
/** Ctrl+A — ink maps ctrl letter keys to the letter name. */
const CTRL_A = "\x01";
const CTRL_E = "\x05";
const CARET = "\u2588";

/** Strip the block caret so assertions see the underlying query text. */
function queryText(frame: string): string {
  return frame.replaceAll(CARET, "");
}

async function settle(ms = 30): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("SearchBar caret", () => {
  it("inserts at the caret, not only at the end", async () => {
    const { lastFrame, stdin, unmount } = render(createElement(Harness));
    await settle();

    // hello█ → move to start → type "x" → xhello
    for (let i = 0; i < 5; i++) stdin.write(LEFT);
    await settle();
    stdin.write("x");
    await settle();

    expect(queryText(lastFrame() ?? "")).toContain("xhello");
    unmount();
  });

  it("backspaces at the caret, not only the last character", async () => {
    const { lastFrame, stdin, unmount } = render(
      createElement(Harness, { initial: "abcde" }),
    );
    await settle();

    // abcde█ → left twice → abc█de → backspace → ab█de
    stdin.write(LEFT);
    stdin.write(LEFT);
    await settle();
    stdin.write(BACKSPACE);
    await settle();

    const text = queryText(lastFrame() ?? "");
    expect(text).toContain("abde");
    expect(text).not.toContain("abcde");
    unmount();
  });

  it("backspaces the last character with the DEL byte used by terminals", async () => {
    const { lastFrame, stdin, unmount } = render(createElement(Harness));
    await settle();

    stdin.write(BACKSPACE);
    await settle();

    const text = queryText(lastFrame() ?? "");
    expect(text).toContain("hell");
    expect(text).not.toContain("hello");
    unmount();
  });

  it("forward-deletes the character after the caret", async () => {
    const { lastFrame, stdin, unmount } = render(
      createElement(Harness, { initial: "abcde" }),
    );
    await settle();

    // abcde█ → left 3 → ab█cde → delete → ab█de
    stdin.write(LEFT);
    stdin.write(LEFT);
    stdin.write(LEFT);
    await settle();
    stdin.write(DELETE);
    await settle();

    const text = queryText(lastFrame() ?? "");
    expect(text).toContain("abde");
    expect(text).not.toContain("abcde");
    unmount();
  });

  it("Ctrl+A and Ctrl+E jump to start and end", async () => {
    const { lastFrame, stdin, unmount } = render(createElement(Harness));
    await settle();

    stdin.write(CTRL_A);
    await settle();
    stdin.write("Z");
    await settle();
    expect(queryText(lastFrame() ?? "")).toContain("Zhello");

    stdin.write(CTRL_E);
    await settle();
    stdin.write("!");
    await settle();
    expect(queryText(lastFrame() ?? "")).toContain("Zhello!");
    unmount();
  });

  it("right arrow does not move past the end; typing still appends", async () => {
    const { lastFrame, stdin, unmount } = render(createElement(Harness));
    await settle();

    stdin.write(RIGHT);
    stdin.write(RIGHT);
    await settle();
    stdin.write("!");
    await settle();

    expect(queryText(lastFrame() ?? "")).toContain("hello!");
    unmount();
  });
});
