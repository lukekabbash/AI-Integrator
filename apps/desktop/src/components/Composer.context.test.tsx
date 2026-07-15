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

  it("pastes a clipboard image as an attachment chip", async () => {
    const pasted: ContextAttachment = {
      path: "/tmp/pasted-attachments/pasted-image.png",
      name: "pasted-image.png",
      kind: "image",
      dataUrl: "data:image/png;base64,aGk=",
    };
    const save = vi.fn().mockResolvedValue(pasted);
    vi.spyOn(bridge, "savePastedImageAttachment").mockImplementation(save);
    const { textbox } = renderComposer();
    const file = new File([new Uint8Array([1, 2, 3])], "screenshot.png", { type: "image/png" });

    fireEvent.paste(textbox, {
      clipboardData: {
        files: [file],
        items: [],
      },
    });

    expect(await screen.findByText("pasted-image.png")).toBeInTheDocument();
    expect(screen.getByAltText("pasted-image.png")).toHaveAttribute(
      "src",
      "data:image/png;base64,aGk=",
    );
    expect(save).toHaveBeenCalledWith(file, "screenshot.png");
    expect(textbox).toHaveValue("");
  });

  it("leaves ordinary text pastes alone", async () => {
    const save = vi.fn();
    vi.spyOn(bridge, "savePastedImageAttachment").mockImplementation(save);
    const { textbox } = renderComposer();

    fireEvent.paste(textbox, {
      clipboardData: {
        files: [],
        items: [],
        getData: () => "hello from clipboard",
      },
    });

    expect(save).not.toHaveBeenCalled();
  });
});

describe("selection context cards", () => {
  it("attaches a host-sent selection as a removable range-labeled card", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const onAttachmentHandled = vi.fn();
    const selection = {
      path: "apps/desktop/src/App.tsx",
      name: "App.tsx (101 – 156)",
      kind: "file" as const,
      entry: "file" as const,
      selection: { startLine: 101, endLine: 156, text: "const value = 1;" },
    };
    render(
      <LazyMotion features={domAnimation} strict>
        <Composer
          runtimes={[codex]}
          defaultRuntime="codex"
          defaultModel="gpt-5.3-codex"
          contextFiles={contextFiles}
          onSend={onSend}
          attachmentRequest={{ id: 1, attachment: selection }}
          onAttachmentHandled={onAttachmentHandled}
        />
      </LazyMotion>,
    );

    // The card shows the file name plus the highlighted line range.
    expect(await screen.findByText("App.tsx (101 – 156)")).toBeInTheDocument();
    expect(onAttachmentHandled).toHaveBeenCalledWith(1);

    const textbox = screen.getByRole("textbox", { name: "Task message" });
    fireEvent.change(textbox, { target: { value: "Explain this part" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const outgoing = onSend.mock.calls[0][0];
    expect(outgoing.prompt).toContain("apps/desktop/src/App.tsx (lines 101-156)");
    expect(outgoing.prompt).toContain("const value = 1;");
  });

  it("removes a selection card without touching a whole-file card for the same path", async () => {
    const wholeFile = {
      path: "apps/desktop/src/App.tsx",
      name: "App.tsx",
      kind: "file" as const,
      entry: "file" as const,
    };
    const selection = {
      ...wholeFile,
      name: "App.tsx (7)",
      selection: { startLine: 7, endLine: 7, text: "let x = 1;" },
    };
    const { rerender } = render(
      <LazyMotion features={domAnimation} strict>
        <Composer
          runtimes={[codex]}
          defaultRuntime="codex"
          defaultModel="gpt-5.3-codex"
          contextFiles={contextFiles}
          onSend={vi.fn().mockResolvedValue(true)}
          attachmentRequest={{ id: 1, attachment: wholeFile }}
        />
      </LazyMotion>,
    );
    rerender(
      <LazyMotion features={domAnimation} strict>
        <Composer
          runtimes={[codex]}
          defaultRuntime="codex"
          defaultModel="gpt-5.3-codex"
          contextFiles={contextFiles}
          onSend={vi.fn().mockResolvedValue(true)}
          attachmentRequest={{ id: 2, attachment: selection }}
        />
      </LazyMotion>,
    );

    expect(await screen.findByText("App.tsx (7)")).toBeInTheDocument();
    expect(screen.getByText("App.tsx")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove App.tsx (7)" }));
    await waitFor(() => expect(screen.queryByText("App.tsx (7)")).not.toBeInTheDocument());
    expect(screen.getByText("App.tsx")).toBeInTheDocument();
  });
});
