import {
  draftOwnerKey,
  persistableComposerAttachment,
  type ComposerDraft,
  type ComposerDraftOwner,
  type ComposerDraftValue,
} from "./bridge";

function withoutPreviews(value: ComposerDraftValue): ComposerDraftValue {
  return {
    ...value,
    attachments: value.attachments.map(persistableComposerAttachment),
  };
}

export class ComposerDraftStore {
  readonly #drafts = new Map<string, ComposerDraft>();

  hydrate(drafts: ComposerDraft[]): void {
    this.#drafts.clear();
    for (const draft of drafts) {
      const key = draftOwnerKey(draft.owner);
      const current = this.#drafts.get(key);
      if (!current || draft.revision > current.revision) this.#drafts.set(key, draft);
    }
  }

  read(owner: ComposerDraftOwner): ComposerDraft | undefined {
    return this.#drafts.get(draftOwnerKey(owner));
  }

  update(owner: ComposerDraftOwner, value: ComposerDraftValue): ComposerDraft {
    const current = this.read(owner);
    const draft: ComposerDraft = {
      owner,
      ...withoutPreviews(value),
      revision: (current?.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    this.#drafts.set(draftOwnerKey(owner), draft);
    return draft;
  }

  promote(
    projectId: string,
    taskId: string,
    revision: number,
  ): {
    taskDraft: ComposerDraft;
    projectDraft: ComposerDraft;
  } | null {
    const projectOwner = { kind: "newChat", projectId } as const;
    const current = this.read(projectOwner);
    if (!current || current.revision !== revision) return null;
    const updatedAt = new Date().toISOString();
    const taskDraft: ComposerDraft = {
      ...current,
      owner: { kind: "task", taskId },
      updatedAt,
    };
    const projectDraft: ComposerDraft = {
      ...current,
      prompt: "",
      attachments: [],
      selectionStart: 0,
      selectionEnd: 0,
      revision: current.revision + 1,
      updatedAt,
    };
    this.#drafts.set(draftOwnerKey(taskDraft.owner), taskDraft);
    this.#drafts.set(draftOwnerKey(projectDraft.owner), projectDraft);
    return { taskDraft, projectDraft };
  }

  clear(owner: ComposerDraftOwner, revision: number): ComposerDraft | null {
    const current = this.read(owner);
    if (!current || current.revision !== revision) return null;
    const cleared: ComposerDraft = {
      ...current,
      prompt: "",
      attachments: [],
      selectionStart: 0,
      selectionEnd: 0,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    this.#drafts.set(draftOwnerKey(owner), cleared);
    return cleared;
  }
}
