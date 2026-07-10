// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, openMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  openMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock }));

import { bridge } from "./bridge";

describe("native trusted-project bridge", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    invokeMock.mockReset();
    openMock.mockReset();
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("treats a cancelled native directory dialog as a no-op", async () => {
    openMock.mockResolvedValue(null);

    await expect(bridge.openProject()).resolves.toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("registers only the directory returned by the user-owned dialog", async () => {
    openMock.mockResolvedValue("H:\\Code\\sample");
    invokeMock.mockResolvedValue({
      id: "project-1",
      displayName: "sample",
      repositoryRoot: "H:\\Code\\sample",
      gitCommonDirectory: "H:\\Code\\sample\\.git",
      createdAt: "2026-07-10T15:00:00Z",
      lastOpenedAt: "2026-07-10T15:00:00Z",
    });

    await expect(bridge.openProject()).resolves.toMatchObject({
      id: "project-1",
      name: "sample",
      path: "H:\\Code\\sample",
    });
    expect(openMock).toHaveBeenCalledWith(
      expect.objectContaining({ directory: true, multiple: false }),
    );
    expect(invokeMock).toHaveBeenCalledWith("project_register", {
      path: "H:\\Code\\sample",
    });
  });
});
