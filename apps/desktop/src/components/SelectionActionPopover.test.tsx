// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffFile } from "../bridge";
import { DiffView } from "./DiffView";
import { splitAttachmentBlock } from "./conversationFormatting";

const file: DiffFile = {
  path: "src/lib.rs",
  status: "modified",
  additions: 1,
  deletions: 1,
  staged: false,
  lines: [
    { kind: "hunk", content: "@@ -1,3 +1,3 @@" },
    { kind: "context", content: "fn main() {", oldNumber: 1, newNumber: 1 },
    { kind: "delete", content: '    println!("old");', oldNumber: 2 },
    { kind: "add", content: '    println!("new");', newNumber: 2 },
    { kind: "context", content: "}", oldNumber: 3, newNumber: 3 },
  ],
};

function selectAcross(nodes: [Node, Node]) {
  const range = document.createRange();
  range.setStartBefore(nodes[0]);
  range.setEndAfter(nodes[1]);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

beforeEach(() => {
  document.documentElement.dataset.motion = "none";
});

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  delete document.documentElement.dataset.motion;
  vi.restoreAllMocks();
});

describe("diff selection popover", () => {
  it("offers Add to chat over a multi-line diff selection and reports marked lines", async () => {
    const onAddSelection = vi.fn();
    render(<DiffView file={file} onAddSelection={onAddSelection} />);

    const cells = document.querySelectorAll("[data-diff-kind]");
    expect(cells.length).toBeGreaterThanOrEqual(4);
    selectAcross([cells[1], cells[2]]);

    const add = await screen.findByRole("button", { name: /Add to chat/ });
    fireEvent.click(add);

    expect(onAddSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "src/lib.rs",
        intent: "add",
        startLine: 2,
        endLine: 2,
        text: '-     println!("old");\n+     println!("new");',
      }),
    );
    // Acting on the selection dismisses the pill.
    expect(screen.queryByRole("button", { name: /Add to chat/ })).toBeNull();
  });

  it("sends the ask intent from the second action", async () => {
    const onAddSelection = vi.fn();
    render(<DiffView file={file} onAddSelection={onAddSelection} />);
    const cells = document.querySelectorAll("[data-diff-kind]");
    selectAcross([cells[0], cells[3]]);

    fireEvent.click(await screen.findByRole("button", { name: /Ask about this/ }));
    expect(onAddSelection).toHaveBeenCalledWith(expect.objectContaining({ intent: "ask" }));
  });

  it("renders no popover without a handler", () => {
    render(<DiffView file={file} />);
    const cells = document.querySelectorAll("[data-diff-kind]");
    selectAcross([cells[0], cells[1]]);
    expect(screen.queryByRole("button", { name: /Add to chat/ })).toBeNull();
  });
});

describe("sent-message attachment parsing", () => {
  it("splits the trailing attachment block from the message text", () => {
    const body = "what is this?\n\nAttached files:\n- /Users/demo/bug.png\n- /tmp/data.csv";
    expect(splitAttachmentBlock(body)).toEqual({
      text: "what is this?",
      attachments: ["/Users/demo/bug.png", "/tmp/data.csv"],
    });
  });

  it("handles attachment-only messages and leaves ordinary text alone", () => {
    expect(splitAttachmentBlock("Attached files:\n- /tmp/a.txt")).toEqual({
      text: "",
      attachments: ["/tmp/a.txt"],
    });
    expect(splitAttachmentBlock("just text")).toEqual({ text: "just text", attachments: [] });
  });
});
