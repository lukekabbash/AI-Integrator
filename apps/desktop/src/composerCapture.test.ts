import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: mocks.emit,
  listen: mocks.listen,
}));

import {
  COMPOSER_ATTACH_EVENT,
  COMPOSER_INSERT_EVENT,
  listenComposerOffers,
  poppedOutComposerHost,
} from "./composerCapture";

describe("composerCapture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.emit.mockResolvedValue(undefined);
    mocks.listen.mockResolvedValue(() => undefined);
  });

  it("offers a popped-out screenshot to the main composer", async () => {
    const attachment = {
      path: "/tmp/shot.png",
      name: "browser-1.png",
      kind: "image" as const,
      dataUrl: "data:image/png;base64,aa",
    };
    const save = vi.fn(async () => attachment);
    const host = poppedOutComposerHost(save);

    await host.attachImage(new Blob(["png"], { type: "image/png" }), "browser-1.png", "task-a");

    expect(save).toHaveBeenCalledWith(expect.any(Blob), "browser-1.png", undefined);
    expect(mocks.emit).toHaveBeenCalledWith(COMPOSER_ATTACH_EVENT, {
      taskId: "task-a",
      attachment,
    });
  });

  it("offers annotation text to the main composer", async () => {
    poppedOutComposerHost().insertText("<browser_annotation>", "task-a");
    await vi.waitFor(() =>
      expect(mocks.emit).toHaveBeenCalledWith(COMPOSER_INSERT_EVENT, {
        taskId: "task-a",
        text: "<browser_annotation>",
      }),
    );
  });

  it("does not emit when the image could not be saved", async () => {
    const host = poppedOutComposerHost(async () => undefined);
    await host.attachImage(new Blob(["png"], { type: "image/png" }), "browser-1.png", "task-a");
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("delivers offers to the main window listener", async () => {
    const onAttach = vi.fn();
    const onInsert = vi.fn();
    const attach = { path: "/tmp/shot.png", name: "shot.png", kind: "image" as const };
    mocks.listen.mockImplementation(async (event: string, listener: (payload: unknown) => void) => {
      if (event === COMPOSER_ATTACH_EVENT) {
        listener({ payload: { taskId: "task-a", attachment: attach } });
      }
      if (event === COMPOSER_INSERT_EVENT) {
        listener({ payload: { taskId: "task-a", text: "note" } });
      }
      return () => undefined;
    });

    await listenComposerOffers({ onAttach, onInsert });

    expect(onAttach).toHaveBeenCalledWith({ taskId: "task-a", attachment: attach });
    expect(onInsert).toHaveBeenCalledWith({ taskId: "task-a", text: "note" });
  });
});
