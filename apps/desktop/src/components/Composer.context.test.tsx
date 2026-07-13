// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LazyMotion, domAnimation } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridge, type ContextAttachment, type RuntimeConnection } from "../bridge";
import { Composer } from "./Composer";

const codex: RuntimeConnection = {
  id: "codex",
  name: "Codex",
  command: "codex app-server",
  status: "connected",
  fidelity: "native",
  models: ["gpt-5.3-codex"],
  detail: "Ready",
};

const contextFiles = [
  "README.md",
  "package.json",
  "apps/desktop/src/App.tsx",
  "apps/desktop/src/bridge.ts",
  "apps/desktop/package.json",
  "crates/integrator-core/src/lib.rs",
];

function renderComposer(onSend = vi.fn().mockResolvedValue(true)) {
  render(
    <LazyMotion features={domAnimation} strict>
      <Composer
        runtimes={[codex]}
        defaultRuntime="codex"
        defaultModel="gpt-5.3-codex"
        contextFiles={contextFiles}
        onSend={onSend}
      />
    </LazyMotion>,
  );
  return {
    onSend,
    textbox: screen.getByRole("textbox", { name: "Task message" }) as HTMLTextAreaElement,
  };
}

beforeEach(() => {
  document.documentElement.dataset.motion = "none";
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.motion;
  vi.restoreAllMocks();
});

describe("@-mention context suggestions", () => {
  it("browses the project root with folders before files on a bare @", async () => {
    const { textbox } = renderComposer();
    fireEvent.change(textbox, { target: { value: "@", selectionStart: 1 } });

    const options = await screen.findAllByRole("option");
    const labels = options.map((option) => option.querySelector("span")?.textContent);
    expect(labels).toEqual(["apps/", "crates/", "package.json", "README.md"]);
  });

  it("drills into a folder when its suggestion is accepted", async () => {
    const { textbox } = renderComposer();
    fireEvent.change(textbox, { target: { value: "@", selectionStart: 1 } });
    fireEvent.click((await screen.findAllByRole("option"))[0]);

    // The folder token stays active (no trailing space) so the popup now
    // lists the folder's children.
    expect(textbox).toHaveValue("@apps/");
    const options = await screen.findAllByRole("option");
    expect(options[0].querySelector("span")?.textContent).toBe("desktop/");
  });

  it("fuzzy-matches files and folders across the whole project", async () => {
    const { textbox } = renderComposer();
    fireEvent.change(textbox, { target: { value: "@bridge", selectionStart: 7 } });

    const option = await screen.findByRole("option", { name: /bridge\.ts/ });
    fireEvent.click(option);
    expect(textbox).toHaveValue("");
    expect(screen.getByRole("button", { name: "Remove bridge.ts" })).toBeInTheDocument();
  });

  it("commits valid @mentions as removable context cards", async () => {
    const { onSend, textbox } = renderComposer();
    fireEvent.change(textbox, {
      target: { value: "explain @README.md please", selectionStart: 25 },
    });

    expect(textbox).toHaveValue("explain please");
    expect(screen.getByText("README.md")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "explain please\n\nAttached files:\n- README.md",
        }),
      ),
    );
  });

  it("removes a committed @mention from its card", async () => {
    const { textbox } = renderComposer();
    fireEvent.change(textbox, {
      target: { value: "review @package.json next", selectionStart: 25 },
    });

    expect(textbox).toHaveValue("review next");
    fireEvent.click(screen.getByRole("button", { name: "Remove package.json" }));
    expect(screen.queryByText("package.json")).toBeNull();
  });

  it("deduplicates repeated @mentions", () => {
    const { textbox } = renderComposer();
    fireEvent.change(textbox, {
      target: { value: "compare @README.md with @README.md ", selectionStart: 35 },
    });

    expect(textbox).toHaveValue("compare with ");
    expect(screen.getAllByRole("button", { name: "Remove README.md" })).toHaveLength(1);
  });
});

describe("composer attachments", () => {
  it("attaches picked files, previews images, and appends paths to the sent prompt", async () => {
    const picked: ContextAttachment[] = [
      {
        path: "/Users/demo/Pictures/bug.png",
        name: "bug.png",
        kind: "image",
        dataUrl: "data:image/png;base64,aGk=",
      },
      { path: "/Users/demo/notes.txt", name: "notes.txt", kind: "file" },
    ];
    vi.spyOn(bridge, "pickContextAttachments").mockResolvedValue(picked);
    const { onSend, textbox } = renderComposer();

    fireEvent.click(
      screen.getByRole("button", { name: "Attach files or images from your computer" }),
    );
    await screen.findByText("bug.png");
    expect(screen.getByAltText("bug.png")).toHaveAttribute("src", "data:image/png;base64,aGk=");

    fireEvent.change(textbox, { target: { value: "what is this?", selectionStart: 13 } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt:
            "what is this?\n\nAttached files:\n- /Users/demo/Pictures/bug.png\n- /Users/demo/notes.txt",
        }),
      ),
    );
    // Attachments clear after an accepted send.
    expect(screen.queryByText("bug.png")).toBeNull();
  });

  it("allows sending attachments without any typed text and restores them on rejection", async () => {
    vi.spyOn(bridge, "pickContextAttachments").mockResolvedValue([
      { path: "/tmp/data.csv", name: "data.csv", kind: "file" },
    ]);
    const onSend = vi.fn().mockResolvedValue(false);
    renderComposer(onSend);

    fireEvent.click(
      screen.getByRole("button", { name: "Attach files or images from your computer" }),
    );
    await screen.findByText("data.csv");

    const send = screen.getByRole("button", { name: "Send message" });
    expect(send).toBeEnabled();
    fireEvent.click(send);
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "Attached files:\n- /tmp/data.csv" }),
      ),
    );
    // A rejected send keeps the attachments in the composer.
    expect(await screen.findByText("data.csv")).toBeInTheDocument();
  });

  it("removes an attachment from its chip", async () => {
    vi.spyOn(bridge, "pickContextAttachments").mockResolvedValue([
      { path: "/tmp/a.txt", name: "a.txt", kind: "file" },
    ]);
    renderComposer();

    fireEvent.click(
      screen.getByRole("button", { name: "Attach files or images from your computer" }),
    );
    await screen.findByText("a.txt");
    fireEvent.click(screen.getByRole("button", { name: "Remove a.txt" }));
    expect(screen.queryByText("a.txt")).toBeNull();
  });
});
