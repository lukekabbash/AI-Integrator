// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LazyMotion, domAnimation } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectFileContent } from "../bridge";
import { FileWorkspace } from "./FileView";
import {
  indentGuideCount,
  indentGuideCountsForLines,
  leadingIndentColumns,
  resolveRequestedFile,
} from "./fileViewSupport";

const textFile: ProjectFileContent = {
  path: "src/App.tsx",
  content: 'const value = "ok";\nfunction run() {}\n',
  isBinary: false,
};

function renderWorkspace(overrides?: Partial<Parameters<typeof FileWorkspace>[0]>) {
  const props = {
    file: textFile,
    ...overrides,
  };
  return render(
    <LazyMotion features={domAnimation} strict>
      <FileWorkspace {...props} />
    </LazyMotion>,
  );
}

beforeEach(() => {
  document.documentElement.dataset.motion = "none";
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete document.documentElement.dataset.motion;
  vi.restoreAllMocks();
});

/** Selects the given text inside the rendered code lines so the selection
 * menu flows can run under jsdom. */
function selectFirstLine() {
  const lines = screen.getByRole("list", { name: "Contents of src/App.tsx" });
  const firstLine = lines.querySelector("li[data-line='1']");
  if (!firstLine) throw new Error("first rendered line is missing");
  const range = document.createRange();
  range.selectNodeContents(firstLine);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return lines;
}

describe("FileWorkspace", () => {
  it("renders the full-canvas reader with header metadata and highlighting", () => {
    renderWorkspace();

    expect(screen.getByText("App.tsx")).toBeInTheDocument();
    expect(screen.getByText("src/App.tsx")).toBeInTheDocument();
    expect(screen.getByText("TypeScript")).toBeInTheDocument();
    expect(screen.getByText("const", { selector: ".syntax-keyword" })).toBeInTheDocument();
    expect(screen.getByText('"ok"', { selector: ".syntax-string" })).toBeInTheDocument();
  });

  it("progressively mounts large files with an explicit show-all action", () => {
    const content = Array.from({ length: 1_200 }, (_, index) => `canvas-line-${index}`).join("\n");
    renderWorkspace({ file: { ...textFile, content } });

    const reader = screen.getByRole("list", { name: "Contents of src/App.tsx" });
    expect(reader.querySelectorAll("li")).toHaveLength(400);
    expect(reader).not.toHaveTextContent("canvas-line-1199");
    fireEvent.click(screen.getByRole("button", { name: "Show all 1,200 lines" }));
    expect(reader.querySelectorAll("li")).toHaveLength(1_200);
    expect(reader).toHaveTextContent("canvas-line-1199");
  });

  it("opens in a stable highlighted editor and autosaves through the host boundary", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderWorkspace({ editable: true, onSave });

    const editor = screen.getByRole("textbox", { name: "Edit src/App.tsx" });
    expect(screen.queryByRole("button", { name: "Edit src/App.tsx" })).not.toBeInTheDocument();
    expect(document.querySelector(".file-code-editor-highlight .syntax-keyword")).toHaveTextContent(
      "const",
    );
    const gutterNumbers = [...document.querySelectorAll(".file-code-line-number")].map(
      (node) => (node as HTMLElement).dataset.line,
    );
    expect(gutterNumbers).toEqual(["1", "2", "3"]);
    // Highlight layer must mirror textarea text (including \\n) so native
    // selection/caret geometry covers the colored glyphs underneath.
    // Line numbers use ::before + data-line so they stay out of textContent.
    expect(document.querySelector(".file-code-editor-highlight")?.textContent).toBe(
      (editor as HTMLTextAreaElement).value,
    );

    fireEvent.change(editor, { target: { value: "const value = 'edited';\n" } });
    expect(screen.getByText("Edited")).toBeInTheDocument();
    expect(document.querySelector(".file-code-editor-highlight .syntax-string")).toHaveTextContent(
      "'edited'",
    );
    expect(document.querySelector(".file-code-editor-highlight")?.textContent).toBe(
      "const value = 'edited';\n",
    );

    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });

    expect(onSave).toHaveBeenCalledWith("const value = 'edited';\n");
    expect(screen.getByRole("textbox", { name: "Edit src/App.tsx" })).toBe(editor);
  });

  it("keeps highlight text (including newlines) aligned with the textarea after edits", () => {
    renderWorkspace({ editable: true, onSave: vi.fn() });
    const editor = screen.getByRole("textbox", { name: "Edit src/App.tsx" });
    const nested =
      "export function run() {\n  const value = 1;\n\n    return value;\n}\n";
    fireEvent.change(editor, { target: { value: nested } });

    const highlight = document.querySelector(".file-code-editor-highlight");
    expect(highlight?.textContent).toBe(nested);
    expect(highlight?.querySelectorAll(".file-code-editor-line")).toHaveLength(6);
    expect(highlight?.querySelectorAll(".file-indent-guide").length).toBeGreaterThanOrEqual(3);
  });

  it("paints indent guides for nested code in the reader and editor", () => {
    const nested = "export function run() {\n  const value = 1;\n    return value;\n}\n";
    renderWorkspace({ file: { ...textFile, content: nested } });

    const readerGuides = document.querySelectorAll(
      ".file-reader-lines .file-indent-guide",
    );
    expect(readerGuides.length).toBeGreaterThanOrEqual(3);

    cleanup();
    renderWorkspace({
      editable: true,
      onSave: vi.fn(),
      file: { ...textFile, content: nested },
    });
    expect(document.querySelectorAll(".file-code-editor-highlight .file-code-line-number")).toHaveLength(
      5,
    );
    expect(
      document.querySelectorAll(".file-code-editor-highlight .file-indent-guide").length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("carries indent guides across blank lines so columns stay continuous", () => {
    const nested = "function run() {\n  const value = 1;\n\n  return value;\n}\n";
    renderWorkspace({
      editable: true,
      onSave: vi.fn(),
      file: { ...textFile, content: nested },
    });
    const lines = [...document.querySelectorAll(".file-code-editor-line")];
    // Blank line between two indent-1 lines should still paint one guide.
    expect(lines[2]?.querySelectorAll(".file-indent-guide")).toHaveLength(1);
  });

  it("mirrors textarea scroll onto the highlight layer (numbers ride with highlight lines)", () => {
    renderWorkspace({ editable: true, onSave: vi.fn() });
    const editor = screen.getByRole("textbox", { name: "Edit src/App.tsx" });
    const highlight = document.querySelector(".file-code-editor-highlight");
    expect(highlight).toBeTruthy();
    expect(document.querySelector(".file-code-gutter-inner")).not.toBeInTheDocument();

    Object.defineProperty(editor, "scrollTop", { configurable: true, value: 128, writable: true });
    Object.defineProperty(editor, "scrollLeft", { configurable: true, value: 24, writable: true });
    fireEvent.scroll(editor);

    expect(highlight).toHaveProperty("scrollTop", 128);
    expect(highlight).toHaveProperty("scrollLeft", 24);
  });

  it("retries immediately with Cmd+S, surfaces failures, and leaves undo unclaimed", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("disk is read-only"));
    renderWorkspace({ editable: true, onSave });

    const editor = screen.getByRole("textbox", { name: "Edit src/App.tsx" });
    fireEvent.change(editor, { target: { value: "changed" } });
    fireEvent.keyDown(editor, { key: "s", metaKey: true });

    expect(await screen.findByRole("alert")).toHaveTextContent("disk is read-only");
    // The editor stays open with the draft intact after a failed save.
    expect(screen.getByRole("textbox", { name: "Edit src/App.tsx" })).toHaveValue("changed");

    const undo = new KeyboardEvent("keydown", {
      key: "z",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    editor.dispatchEvent(undo);
    expect(undo.defaultPrevented).toBe(false);
  });

  it("flushes a pending edit when the file view closes before the debounce", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const view = renderWorkspace({ editable: true, onSave });

    fireEvent.change(screen.getByRole("textbox", { name: "Edit src/App.tsx" }), {
      target: { value: "const closing = true;\n" },
    });
    view.unmount();
    await act(async () => Promise.resolve());

    expect(onSave).toHaveBeenCalledWith("const closing = true;\n");
  });

  it("serializes autosaves so an older disk write cannot land after a newer edit", async () => {
    vi.useFakeTimers();
    let finishFirstSave: (() => void) | undefined;
    const firstSave = new Promise<void>((resolve) => {
      finishFirstSave = resolve;
    });
    const onSave = vi
      .fn()
      .mockImplementationOnce(() => firstSave)
      .mockResolvedValue(undefined);
    renderWorkspace({ editable: true, onSave });
    const editor = screen.getByRole("textbox", { name: "Edit src/App.tsx" });

    fireEvent.change(editor, { target: { value: "const revision = 1;\n" } });
    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledTimes(1);

    fireEvent.change(editor, { target: { value: "const revision = 2;\n" } });
    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishFirstSave?.();
      await firstSave;
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenNthCalledWith(2, "const revision = 2;\n");
  });

  it("never offers editing for binary or image files", () => {
    renderWorkspace({
      editable: true,
      onSave: vi.fn(),
      file: { path: "logo.bin", content: "", isBinary: true },
    });
    expect(screen.queryByRole("button", { name: /^Edit/ })).not.toBeInTheDocument();
    expect(
      screen.getByText("This binary file cannot be safely previewed as text."),
    ).toBeInTheDocument();
  });

  it("does not autoshow Add to chat / Ask about this on text selection alone", () => {
    const onExplainSelection = vi.fn();
    const onAddComposerContext = vi.fn();
    renderWorkspace({ onExplainSelection, onAddComposerContext });

    selectFirstLine();
    fireEvent(document, new Event("selectionchange"));

    expect(
      screen.queryByRole("toolbar", { name: "Selection actions for src/App.tsx" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ask about this/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add to chat/ })).not.toBeInTheDocument();
  });

  it("opens the in-file explain panel instead of sending the selection to chat", async () => {
    const onExplainSelection = vi.fn().mockResolvedValue({
      text: "This line declares a string constant used by the surrounding module.",
      agentLabel: "Codex",
      usedFallback: false,
    });
    const onAddComposerContext = vi.fn();
    renderWorkspace({
      onExplainSelection,
      onAddComposerContext,
      explainAgentLabel: "Codex",
    });

    const lines = selectFirstLine();
    fireEvent.contextMenu(lines, { clientX: 60, clientY: 60 });

    const menu = screen.getByRole("menu", { name: "Selection actions for src/App.tsx" });
    expect(menu).toHaveTextContent("App.tsx (1)");

    fireEvent.click(screen.getByRole("menuitem", { name: "Ask about this" }));
    expect(onExplainSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "src/App.tsx",
        startLine: 1,
        endLine: 1,
        intent: "ask",
        // The live buffer travels with the selection: context is gathered from
        // what is on screen, not from what is on disk.
        fileText: expect.stringContaining("const value"),
      }),
    );
    expect(onAddComposerContext).not.toHaveBeenCalled();

    expect(
      screen.getByRole("complementary", { name: /Explanation of App.tsx/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("Explaining with Codex…")).toBeInTheDocument();

    await waitFor(() =>
      expect(
        screen.getByText("This line declares a string constant used by the surrounding module."),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("Explained by Codex")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole("menu", { name: "Selection actions for src/App.tsx" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("credits the provider that answered rather than the one that was asked", async () => {
    // The route fails over, so attributing a fallback's answer to the primary
    // would tell the reader a model produced text it never saw.
    const onExplainSelection = vi.fn().mockResolvedValue({
      text: "A fallback answered this one.",
      agentLabel: "Claude",
      usedFallback: true,
    });
    renderWorkspace({ onExplainSelection, explainAgentLabel: "Codex" });

    fireEvent.contextMenu(selectFirstLine(), { clientX: 60, clientY: 60 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Ask about this" }));

    expect(await screen.findByText("Codex could not answer, so Claude did")).toBeInTheDocument();
    expect(screen.queryByText("Explained by Codex")).not.toBeInTheDocument();
  });

  it("surfaces explain failures in the panel without leaving the file", async () => {
    const onExplainSelection = vi.fn().mockRejectedValue(new Error("provider timed out"));
    renderWorkspace({ onExplainSelection, explainAgentLabel: "Cursor" });

    const lines = selectFirstLine();
    fireEvent.contextMenu(lines, { clientX: 60, clientY: 60 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Ask about this" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("provider timed out");
    expect(screen.getByText("Cursor could not explain this selection")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Contents of src/App.tsx" })).toBeInTheDocument();
  });

  it("adds the selection to the composer straight from the menu", () => {
    const onAddComposerContext = vi.fn();
    renderWorkspace({ onAddComposerContext });

    const lines = selectFirstLine();
    fireEvent.contextMenu(lines, { clientX: 40, clientY: 40 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Add to chat" }));

    expect(onAddComposerContext).toHaveBeenCalledTimes(1);
    expect(onAddComposerContext.mock.calls[0][0].text).toContain("const value");
  });

  it("keeps the plain context menu default when nothing is selected", () => {
    const onExplainSelection = vi.fn();
    renderWorkspace({ onExplainSelection });
    window.getSelection()?.removeAllRanges();

    const lines = screen.getByRole("list", { name: "Contents of src/App.tsx" });
    fireEvent.contextMenu(lines, { clientX: 40, clientY: 40 });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("resolveRequestedFile", () => {
  const files = [
    { path: "src/App.tsx", size: 10 },
    { path: "src/components/App.tsx", size: 12 },
    { path: "README.md", size: 5 },
  ];

  it("prefers exact matches, then the longest suffix match", () => {
    expect(resolveRequestedFile(files, "src/App.tsx")?.path).toBe("src/App.tsx");
    expect(resolveRequestedFile(files, "/Users/dev/repo/src/components/App.tsx")?.path).toBe(
      "src/components/App.tsx",
    );
    expect(resolveRequestedFile(files, "./README.md")?.path).toBe("README.md");
    expect(resolveRequestedFile(files, "/elsewhere/missing.ts")).toBeUndefined();
  });
});

describe("file indent guides", () => {
  it("counts leading columns and guide stops for spaces and tabs", () => {
    expect(leadingIndentColumns("code")).toBe(0);
    expect(leadingIndentColumns("  code")).toBe(2);
    expect(leadingIndentColumns("    code")).toBe(4);
    expect(leadingIndentColumns("\tcode")).toBe(2);
    expect(leadingIndentColumns("\t\tcode")).toBe(4);
    expect(indentGuideCount("code")).toBe(0);
    expect(indentGuideCount("  code")).toBe(1);
    expect(indentGuideCount("    return value;")).toBe(2);
  });

  it("carries guide counts across blank lines", () => {
    expect(
      indentGuideCountsForLines(["fn() {", "  a();", "", "  b();", "}"]),
    ).toEqual([0, 1, 1, 1, 0]);
  });
});
