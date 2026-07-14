import { describe, expect, it } from "vitest";
import type { ComposerDraft, ComposerDraftValue } from "./bridge";
import { ComposerDraftStore } from "./composerDraftStore";

const value: ComposerDraftValue = {
  prompt: "Keep this exact thought",
  attachments: [],
  runtime: "codex",
  model: "gpt-5.6-luna",
  effort: "high",
  permission: "project-write",
  delegation: "off",
  selectionStart: 23,
  selectionEnd: 23,
};

describe("ComposerDraftStore", () => {
  it("keeps new-chat and ongoing-chat drafts isolated", () => {
    const store = new ComposerDraftStore();
    store.update({ kind: "newChat", projectId: "project-a" }, value);
    store.update(
      { kind: "task", taskId: "task-a" },
      { ...value, prompt: "A different conversation" },
    );

    expect(store.read({ kind: "newChat", projectId: "project-a" })?.prompt).toBe(
      "Keep this exact thought",
    );
    expect(store.read({ kind: "task", taskId: "task-a" })?.prompt).toBe("A different conversation");
  });

  it("hydrates only the newest revision for an owner", () => {
    const store = new ComposerDraftStore();
    const older: ComposerDraft = {
      owner: { kind: "task", taskId: "task-a" },
      ...value,
      revision: 3,
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
    store.hydrate([
      { ...older, prompt: "newest", revision: 4 },
      { ...older, prompt: "stale" },
    ]);
    expect(store.read(older.owner)?.prompt).toBe("newest");
  });

  it("promotes a project draft to its created task without losing recovery state", () => {
    const store = new ComposerDraftStore();
    const draft = store.update({ kind: "newChat", projectId: "project-a" }, value);
    const promoted = store.promote("project-a", "task-a", draft.revision);

    expect(promoted?.taskDraft.prompt).toBe(value.prompt);
    expect(promoted?.projectDraft.prompt).toBe("");
    expect(promoted?.projectDraft.revision).toBe(draft.revision + 1);
  });

  it("does not clear newer text when an older send settles", () => {
    const store = new ComposerDraftStore();
    const submitted = store.update({ kind: "task", taskId: "task-a" }, value);
    store.update(submitted.owner, { ...value, prompt: "Typed while send was starting" });

    expect(store.clear(submitted.owner, submitted.revision)).toBeNull();
    expect(store.read(submitted.owner)?.prompt).toBe("Typed while send was starting");
  });

  it("drops inline image previews before persistence", () => {
    const store = new ComposerDraftStore();
    const draft = store.update(
      { kind: "newChat", projectId: "project-a" },
      {
        ...value,
        attachments: [
          {
            path: "/tmp/reference.png",
            name: "reference.png",
            kind: "image",
            dataUrl: "data:image/png;base64,private-preview",
          },
        ],
      },
    );
    expect(draft.attachments[0]).not.toHaveProperty("dataUrl");
  });
});
