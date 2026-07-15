// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, listenMock, openMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
  openMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import {
  bridge,
  deriveChatTitle,
  extractAcpCatalog,
  extractCodexCatalog,
  extractCursorModelParams,
  formatBridgeError,
  mergeCursorModelParams,
  parseDiffLines,
  resolveModelEffort,
  runtimeAuthWarning,
} from "./bridge";

describe("native Git diff parsing", () => {
  it("preserves hunk line numbers for the review workspace", () => {
    expect(
      parseDiffLines(
        "diff --git a/src/App.tsx b/src/App.tsx\nindex 1..2 100644\n--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -10,3 +10,4 @@ function App() {\n const ready = true;\n-old line\n+new line\n+second line\n }",
      ),
    ).toEqual([
      { kind: "hunk", content: "@@ -10,3 +10,4 @@ function App() {" },
      { kind: "context", oldNumber: 10, newNumber: 10, content: "const ready = true;" },
      { kind: "delete", oldNumber: 11, content: "old line" },
      { kind: "add", newNumber: 11, content: "new line" },
      { kind: "add", newNumber: 12, content: "second line" },
      { kind: "context", oldNumber: 12, newNumber: 13, content: "}" },
    ]);
  });

  it("keeps source lines whose content begins with diff header markers", () => {
    expect(
      parseDiffLines(
        "--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n---- removed heading\n++++ added heading",
      ),
    ).toEqual([
      { kind: "hunk", content: "@@ -1 +1 @@" },
      { kind: "delete", oldNumber: 1, content: "--- removed heading" },
      { kind: "add", newNumber: 1, content: "+++ added heading" },
    ]);
  });
});

describe("local chat title derivation", () => {
  it("turns the first message into a compact goal label", () => {
    expect(deriveChatTitle("Please fix the sidebar menu overlap\nAlso make the rows denser.")).toBe(
      "fix the sidebar menu overlap",
    );
  });

  it("normalizes long prompts without losing the first-line intent", () => {
    expect(deriveChatTitle("Build a very long task title that should be truncated", 24)).toBe(
      "Build a very long task…",
    );
  });
});

describe("provider model catalogs", () => {
  it("preserves Codex model-advertised reasoning order", () => {
    expect(
      extractCodexCatalog({
        data: [
          {
            id: "gpt-5.4",
            displayName: "GPT-5.4",
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Lower latency" },
              { reasoningEffort: "medium", description: "Balanced" },
              { reasoningEffort: "high", description: "More deliberate" },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        id: "gpt-5.4",
        label: "GPT-5.4",
        efforts: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
        defaultEffort: "medium",
      },
    ]);
  });

  it("preserves every provider-advertised Codex effort, including newer levels", () => {
    const [entry] = extractCodexCatalog({
      data: [
        {
          id: "gpt-5.4",
          supportedReasoningEfforts: [
            { reasoningEffort: "none" },
            { reasoningEffort: "minimal" },
            { reasoningEffort: "low" },
            { reasoningEffort: "medium" },
            { reasoningEffort: "high" },
            { reasoningEffort: "xhigh" },
            { reasoningEffort: "xhigh" },
          ],
          defaultReasoningEffort: "none",
        },
      ],
    });

    expect(entry.efforts?.map((effort) => effort.id)).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(entry.efforts?.map((effort) => effort.label)).toEqual([
      "None",
      "Minimal",
      "Low",
      "Medium",
      "High",
      "Extra high",
    ]);
    expect(resolveModelEffort(entry, "max")).toBe("none");
    expect(resolveModelEffort(entry, "high")).toBe("high");
  });

  it("places the provider-advertised Codex default model first", () => {
    expect(
      extractCodexCatalog({
        data: [
          { id: "gpt-5.5", displayName: "GPT-5.5" },
          { id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", isDefault: true },
        ],
      }).map((entry) => entry.id),
    ).toEqual(["gpt-5.6-luna", "gpt-5.5"]);
  });

  it("reads Cursor model and thought-level options from stable ACP configOptions", () => {
    expect(
      extractAcpCatalog({
        sessionId: "session-1",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "composer-2.5",
            options: [
              { value: "composer-2.5", name: "Composer 2.5" },
              {
                group: "Open weight",
                options: [{ value: "deepseek-r1", name: "DeepSeek R1" }],
              },
            ],
          },
          {
            id: "thought_level",
            name: "Thinking",
            category: "thought_level",
            type: "select",
            currentValue: "medium",
            options: [
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        id: "composer-2.5",
        label: "Composer 2.5",
        efforts: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
        defaultEffort: "medium",
      },
      {
        id: "deepseek-r1",
        label: "DeepSeek R1",
        efforts: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
        defaultEffort: "medium",
      },
    ]);
  });

  it("degrades safely when an ACP agent does not advertise model options", () => {
    expect(extractAcpCatalog({ sessionId: "session-1", modes: {} })).toEqual([]);
  });

  it("places the ACP session's current model first", () => {
    expect(
      extractAcpCatalog({
        configOptions: [
          {
            id: "model",
            category: "model",
            currentValue: "deepseek-r1",
            options: [
              { value: "composer-2.5", name: "Composer 2.5" },
              { value: "deepseek-r1", name: "DeepSeek R1" },
            ],
          },
        ],
      }).map((entry) => entry.id),
    ).toEqual(["deepseek-r1", "composer-2.5"]);
  });

  it("reads per-model reasoning options from cursor/list_available_models", () => {
    const params = extractCursorModelParams({
      models: [
        { value: "default", name: "Auto", configOptions: [] },
        {
          value: "claude-opus-4-8",
          name: "Opus 4.8",
          configOptions: [
            {
              id: "thinking",
              category: "thought_level",
              type: "select",
              currentValue: "true",
              options: [
                { value: "false", name: "Off" },
                { value: "true", name: "On" },
              ],
            },
            {
              id: "effort",
              category: "thought_level",
              type: "select",
              currentValue: "high",
              options: [
                { value: "low", name: "Low" },
                { value: "medium", name: "Medium" },
                { value: "high", name: "High" },
                { value: "xhigh", name: "Extra High" },
                { value: "max", name: "Max" },
              ],
            },
            {
              id: "fast",
              category: "model_config",
              type: "select",
              currentValue: "false",
              options: [
                { value: "false", name: "Off" },
                { value: "true", name: "Fast" },
              ],
            },
          ],
        },
        {
          value: "gpt-5.5",
          name: "GPT-5.5",
          configOptions: [
            {
              id: "reasoning",
              category: "thought_level",
              type: "select",
              currentValue: "medium",
              options: [
                { value: "none", name: "None" },
                { value: "medium", name: "Medium" },
                { value: "extra-high", name: "Extra High" },
              ],
            },
          ],
        },
      ],
    });
    // The binary thinking toggle must lose to the multi-level effort option.
    expect(params.get("claude-opus-4-8")).toEqual({
      configId: "effort",
      defaultEffort: "high",
      efforts: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
        { id: "xhigh", label: "Extra High" },
        { id: "max", label: "Max" },
      ],
    });
    expect(params.get("gpt-5.5")?.configId).toBe("reasoning");
    expect(params.has("default")).toBe(false);
  });

  it("merges Cursor reasoning params into bracketed session catalog ids", () => {
    const catalog = [
      { id: "default[]", label: "Auto" },
      { id: "claude-opus-4-8[thinking=true,context=300k,effort=high]", label: "claude-opus-4-8" },
    ];
    const params = new Map([
      [
        "claude-opus-4-8",
        {
          configId: "effort",
          defaultEffort: "high",
          efforts: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
        },
      ],
    ]);
    mergeCursorModelParams(catalog, params);
    expect(catalog[0]).toEqual({ id: "default[]", label: "Auto" });
    expect(catalog[1]).toMatchObject({
      efforts: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
      defaultEffort: "high",
    });
  });
});

describe("runtime authentication messaging", () => {
  it("does not warn after a native provider has authenticated", () => {
    expect(
      runtimeAuthWarning({
        id: "cursor",
        name: "Cursor",
        command: "agent",
        status: "connected",
        fidelity: "acp",
        models: [],
        detail: "Authenticated local CLI",
      }),
    ).toBeUndefined();
  });

  it("keeps degraded and login-required states actionable", () => {
    expect(
      runtimeAuthWarning({
        id: "antigravity",
        name: "Antigravity",
        command: "agy",
        status: "degraded",
        fidelity: "structured",
        models: [],
        detail: "auth-probe-timeout",
      }),
    ).toContain("timed out");
    expect(
      runtimeAuthWarning({
        id: "antigravity",
        name: "Antigravity",
        command: "agy",
        status: "degraded",
        fidelity: "structured",
        models: [],
        detail: "client-unsupported",
      }),
    ).toContain("installed CLI/account route is unsupported");
    expect(
      runtimeAuthWarning({
        id: "claude",
        name: "Claude Code",
        command: "claude",
        status: "login_required",
        fidelity: "structured",
        models: [],
        detail: "login-required",
      }),
    ).toContain("login is required");
  });
});

describe("native trusted-project bridge", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: { invoke: invokeMock },
    });
    invokeMock.mockReset();
    listenMock.mockReset();
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

  it("uses the bounded local message-search command", async () => {
    invokeMock.mockResolvedValue([{ taskId: "task-1", snippet: "matching local message" }]);

    await expect(bridge.searchTaskMessages("local message", 40)).resolves.toEqual([
      { taskId: "task-1", snippet: "matching local message" },
    ]);
    expect(invokeMock).toHaveBeenCalledWith("task_search_messages", {
      query: "local message",
      limit: 40,
    });
  });

  it("keeps settings reads live after the startup handoff is consumed", async () => {
    invokeMock.mockResolvedValue(undefined);
    await bridge.clearLocalData();
    invokeMock.mockReset();
    invokeMock
      .mockResolvedValueOnce([{ key: "sample", value: "first", updatedAt: "2026-07-13T00:00:00Z" }])
      .mockResolvedValueOnce([
        { key: "sample", value: "second", updatedAt: "2026-07-13T00:00:01Z" },
      ]);

    await expect(bridge.listSettings()).resolves.toEqual([
      { key: "sample", value: "first", updatedAt: "2026-07-13T00:00:00Z" },
    ]);
    await expect(bridge.listSettings()).resolves.toEqual([
      { key: "sample", value: "second", updatedAt: "2026-07-13T00:00:01Z" },
    ]);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "setting_list", undefined);
    expect(invokeMock).toHaveBeenNthCalledWith(2, "setting_list", undefined);
  });

  it("preserves serialized native error details", async () => {
    invokeMock.mockRejectedValue({
      code: "provider-disconnected",
      message: "Cursor session is not bound to this task",
    });

    await expect(bridge.loadTaskProjection("task-1")).rejects.toThrow(
      "Cursor session is not bound to this task (provider-disconnected)",
    );
    expect(
      formatBridgeError(
        { code: "provider-disconnected", message: "Cursor session is not bound to this task" },
        "fallback",
      ),
    ).toBe("Cursor session is not bound to this task (provider-disconnected)");
  });

  it("keeps push preview and confirmed push as separate guarded commands", async () => {
    const preview = {
      head: "0123456789abcdef0123456789abcdef01234567",
      branch: "main",
      remote: "origin",
      sanitizedRemoteUrl: "https://example.test/org/repo.git",
      upstream: "origin/main",
      ahead: 1,
      behind: 0,
      refspec: "refs/heads/main:refs/heads/main",
      force: false as const,
    };
    const confirmation = {
      expectedHead: preview.head,
      expectedBranch: preview.branch,
      expectedRemote: preview.remote,
      expectedRemoteUrl: preview.sanitizedRemoteUrl,
      expectedUpstream: preview.upstream,
      expectedRefspec: preview.refspec,
    };
    const result = {
      outcome: "pushed" as const,
      head: preview.head,
      branch: preview.branch,
      remote: preview.remote,
      refspec: preview.refspec,
      summary: "Pushed to origin.",
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "local_export") {
        return {
          projects: [
            {
              id: "project-push",
              displayName: "integrator-3",
              repositoryRoot: "H:\\Code\\integrator-3",
              gitCommonDirectory: "H:\\Code\\integrator-3\\.git",
              createdAt: "2026-07-13T00:00:00Z",
              lastOpenedAt: "2026-07-13T00:00:00Z",
            },
          ],
          tasks: [
            {
              id: "task-push",
              title: "Push guard",
              repositoryPath: "H:\\Code\\integrator-3",
              state: "ready",
              pinned: false,
              archived: false,
              createdAt: "2026-07-13T00:00:00Z",
              updatedAt: "2026-07-13T00:00:00Z",
            },
          ],
          settings: [],
          providerSessions: [],
          runtimeSessions: [],
        };
      }
      if (command === "git_push_preview") return preview;
      if (command === "git_push_confirmed") return result;
      return undefined;
    });

    await bridge.loadWorkspace();
    await expect(bridge.previewPush("task-push")).resolves.toEqual(preview);
    await expect(bridge.confirmPush("task-push", confirmation)).resolves.toEqual(result);

    expect(invokeMock).toHaveBeenCalledWith("git_push_preview", {
      repository: "H:\\Code\\integrator-3",
    });
    expect(invokeMock).toHaveBeenCalledWith("git_push_confirmed", {
      repository: "H:\\Code\\integrator-3",
      confirmation,
    });
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

  it("loads repository Git state immediately after cloning a project", async () => {
    const root = "H:\\Code\\cloned-project";
    invokeMock.mockImplementation((command: string) => {
      if (command === "local_export") {
        return Promise.resolve({
          projects: [],
          tasks: [],
          settings: [],
          providerSessions: [],
          composerDrafts: [],
        });
      }
      if (command === "project_clone") {
        return Promise.resolve({
          id: "project-cloned",
          displayName: "cloned-project",
          repositoryRoot: root,
          gitRepositoryRoot: root,
          gitCommonDirectory: `${root}\\.git`,
          createdAt: "2026-07-14T12:00:00Z",
          lastOpenedAt: "2026-07-14T12:00:00Z",
        });
      }
      if (command === "git_overview") {
        return Promise.resolve({
          identity: { root, branch: "main" },
          files: [],
          history: [],
          remotes: [
            {
              name: "origin",
              fetchUrl: "https://github.com/company/cloned-project.git",
              pushUrl: "https://github.com/company/cloned-project.git",
            },
          ],
        });
      }
      return Promise.resolve(undefined);
    });

    await bridge.loadWorkspace();
    const project = await bridge.cloneProject({
      remote: "https://github.com/company/cloned-project.git",
      parent: "H:\\Code",
      folderName: "cloned-project",
    });

    await expect(bridge.loadProjectGit(project.id)).resolves.toMatchObject({
      kind: "repository",
      branch: "main",
      worktree: root,
      remotes: [{ name: "origin" }],
    });
    expect(invokeMock).toHaveBeenCalledWith("git_overview", { repository: root });
    expect(invokeMock).not.toHaveBeenCalledWith("project_register", expect.anything());
  });

  it("re-detects Git for an older saved project before showing setup", async () => {
    const root = "H:\\Code\\existing-repository";
    const savedProject = {
      id: "project-existing",
      displayName: "existing-repository",
      repositoryRoot: root,
      createdAt: "2025-03-10T12:00:00Z",
      lastOpenedAt: "2026-07-14T12:00:00Z",
    };
    invokeMock.mockImplementation((command: string) => {
      if (command === "local_export") {
        return Promise.resolve({
          projects: [savedProject],
          tasks: [],
          settings: [],
          providerSessions: [],
          composerDrafts: [],
        });
      }
      if (command === "project_register") {
        return Promise.resolve({
          ...savedProject,
          gitRepositoryRoot: root,
          gitCommonDirectory: `${root}\\.git`,
        });
      }
      if (command === "git_overview") {
        return Promise.resolve({
          identity: { root, branch: "main" },
          files: [],
          history: [],
          remotes: [],
        });
      }
      return Promise.resolve(undefined);
    });

    const workspace = await bridge.loadWorkspace();

    await expect(bridge.loadProjectGit(workspace.projects[0]!.id)).resolves.toMatchObject({
      kind: "repository",
      branch: "main",
      worktree: root,
    });
    expect(invokeMock).toHaveBeenCalledWith("project_register", { path: root });
    expect(invokeMock).toHaveBeenCalledWith("git_overview", { repository: root });
  });

  it("stages project changes before a chat has created a task", async () => {
    const root = "H:\\Code\\new-chat-project";
    invokeMock.mockImplementation((command: string) => {
      if (command === "local_export") {
        return Promise.resolve({
          projects: [
            {
              id: "project-new-chat",
              displayName: "new-chat-project",
              repositoryRoot: root,
              gitRepositoryRoot: root,
              gitCommonDirectory: `${root}\\.git`,
              createdAt: "2026-07-14T12:00:00Z",
              lastOpenedAt: "2026-07-14T12:00:00Z",
            },
          ],
          tasks: [],
          settings: [],
          providerSessions: [],
          composerDrafts: [],
        });
      }
      if (command === "git_overview") {
        return Promise.resolve({
          identity: { root, branch: "main" },
          files: [
            {
              indexStatus: "M",
              worktreeStatus: " ",
              path: "src/App.tsx",
              stagedAdditions: 2,
              stagedDeletions: 0,
            },
          ],
          history: [],
          remotes: [],
        });
      }
      return Promise.resolve(undefined);
    });

    const workspace = await bridge.loadWorkspace();
    const projectId = workspace.projects[0]!.id;
    await expect(bridge.stageProjectFiles(projectId, ["src/App.tsx"], true)).resolves.toMatchObject(
      {
        kind: "repository",
        files: [{ path: "src/App.tsx", staged: true }],
      },
    );
    expect(invokeMock).toHaveBeenCalledWith("git_stage", {
      repository: root,
      paths: ["src/App.tsx"],
    });
    expect(invokeMock).toHaveBeenCalledWith("git_overview", { repository: root });
  });

  it("projects a partially staged path into independent staged and unstaged files", async () => {
    const root = "H:\\Code\\partial";
    invokeMock.mockImplementation((command: string) => {
      if (command === "local_export") {
        return Promise.resolve({
          projects: [
            {
              id: "project-partial",
              displayName: "partial",
              repositoryRoot: root,
              gitRepositoryRoot: root,
              gitCommonDirectory: `${root}\\.git`,
              createdAt: "2026-07-14T12:00:00Z",
              lastOpenedAt: "2026-07-14T12:00:00Z",
            },
          ],
          tasks: [
            {
              id: "task-partial",
              title: "Partial staging",
              repositoryPath: root,
              state: "ready",
              pinned: false,
              archived: false,
              createdAt: "2026-07-14T12:00:00Z",
              updatedAt: "2026-07-14T12:00:00Z",
            },
          ],
          settings: [],
          providerSessions: [],
          composerDrafts: [],
        });
      }
      if (command === "git_overview") {
        return Promise.resolve({
          identity: { root, branch: "main" },
          files: [
            {
              indexStatus: "M",
              worktreeStatus: "M",
              path: "src/App.tsx",
              stagedAdditions: 4,
              stagedDeletions: 1,
              unstagedAdditions: 2,
              unstagedDeletions: 0,
            },
          ],
          history: [],
          remotes: [],
        });
      }
      return Promise.resolve(undefined);
    });

    await bridge.loadWorkspace();

    await expect(bridge.loadTaskGit("task-partial")).resolves.toMatchObject({
      files: [
        {
          path: "src/App.tsx",
          staged: true,
          additions: 4,
          deletions: 1,
        },
        {
          path: "src/App.tsx",
          staged: false,
          additions: 2,
          deletions: 0,
        },
      ],
    });
  });

  it("keeps external file actions typed and repository-scoped", async () => {
    openMock.mockResolvedValue("H:\\Code\\file-actions");
    invokeMock.mockResolvedValueOnce({
      id: "project-file-actions",
      displayName: "file-actions",
      repositoryRoot: "H:\\Code\\file-actions",
      gitCommonDirectory: "H:\\Code\\file-actions\\.git",
      createdAt: "2026-07-13T09:00:00Z",
      lastOpenedAt: "2026-07-13T09:00:00Z",
    });
    await bridge.openProject();
    invokeMock.mockReset();
    invokeMock.mockResolvedValueOnce([
      { id: "cursor", label: "Cursor", description: "Open in Cursor" },
    ]);

    await expect(bridge.listProjectFileOpeners("project-file-actions")).resolves.toEqual([
      { id: "cursor", label: "Cursor", description: "Open in Cursor" },
    ]);
    await bridge.openProjectFileExternal("project-file-actions", "src/App.tsx", "cursor");
    await bridge.revealProjectFile("project-file-actions", "src/App.tsx");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "project_file_opener_list", {
      repository: "H:\\Code\\file-actions",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "project_file_open", {
      repository: "H:\\Code\\file-actions",
      input: { path: "src/App.tsx", openerId: "cursor" },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "project_file_reveal", {
      repository: "H:\\Code\\file-actions",
      input: { path: "src/App.tsx" },
    });
  });

  it("uses the normalized sequenced event and task-control command contracts", async () => {
    const unlisten = vi.fn();
    const listener = vi.fn();
    listenMock.mockResolvedValue(unlisten);
    invokeMock
      .mockResolvedValueOnce({ events: [], watermarkSeq: 41, runtimeLive: true })
      .mockResolvedValueOnce({ id: "approval-1", state: "responding" })
      .mockResolvedValueOnce({ turnId: "turn-1", stopRequested: true, alreadyRequested: false });

    await expect(bridge.subscribeRuntimeProjections(listener)).resolves.toBe(unlisten);
    expect(listenMock).toHaveBeenCalledWith("runtime://projection", expect.any(Function));
    await expect(bridge.loadTaskProjection("task-1")).resolves.toEqual({
      events: [],
      watermarkSeq: 41,
      runtimeLive: true,
    });
    await bridge.respondToApproval("task-1", "approval-1", "acceptForSession");
    await bridge.stopTurn("task-1");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "task_snapshot", { taskId: "task-1" });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "codex_respond_approval", {
      taskId: "task-1",
      approvalId: "approval-1",
      decision: "acceptForSession",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "codex_stop_turn", { taskId: "task-1" });
  });

  it("serializes Cursor model discovery with Send so the live ACP process is not replaced", async () => {
    let releaseConnect: (() => void) | undefined;
    const connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "app_bootstrap") return { value: {} };
      if (command === "local_export") {
        return {
          projects: [
            {
              id: "project-1",
              displayName: "integrator-3",
              repositoryRoot: "H:\\Code\\integrator-3",
              gitCommonDirectory: "H:\\Code\\integrator-3\\.git",
              createdAt: "2026-07-11T00:00:00Z",
              lastOpenedAt: "2026-07-11T00:00:00Z",
            },
          ],
          tasks: [
            {
              id: "task-cursor",
              title: "Cursor concurrency",
              repositoryPath: "H:\\Code\\integrator-3",
              state: "ready",
              pinned: false,
              archived: false,
              runtime: "cursor",
              model: "Provider default",
              createdAt: "2026-07-11T00:00:00Z",
              updatedAt: "2026-07-11T00:00:00Z",
            },
          ],
          settings: [],
          providerSessions: [],
          runtimeSessions: [],
        };
      }
      if (command === "provider_discover") {
        return [
          {
            provider: "cursor",
            installed: true,
            executable: "C:\\Cursor\\agent.cmd",
            version: "test",
            authentication: "authenticated",
            transport: "acpStdio",
          },
        ];
      }
      if (command === "acp_connect") return connectGate;
      if (command === "acp_list_cursor_models") {
        return {
          models: [
            { value: "grok-4.5", name: "grok-4.5", configOptions: [] },
            {
              value: "gpt-5.6-sol",
              name: "gpt-5.6-sol",
              configOptions: [
                {
                  id: "reasoning",
                  category: "thought_level",
                  currentValue: "medium",
                  options: [
                    { value: "low", name: "Low" },
                    { value: "medium", name: "Medium" },
                    { value: "high", name: "High" },
                  ],
                },
              ],
            },
          ],
        };
      }
      if (command === "acp_start_session") {
        return {
          sessionId: "cursor-session",
          configOptions: [
            {
              id: "model",
              category: "model",
              currentValue: "default[]",
              options: [
                { value: "default[]", name: "Auto" },
                { value: "grok-4.5[effort=high,fast=true]", name: "grok-4.5" },
                { value: "gpt-5.6-sol[reasoning=medium]", name: "gpt-5.6-sol" },
              ],
            },
          ],
        };
      }
      if (command === "acp_send_turn") return { turnId: "cursor-turn" };
      return undefined;
    });

    await bridge.loadWorkspace();
    const catalogPromise = bridge.listModelCatalog("cursor");
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("acp_connect", expect.anything()),
    );
    const sendPromise = bridge.sendTurn({
      taskId: "task-cursor",
      prompt: "Reply with OK",
      runtime: "cursor",
      model: "Provider default",
      permission: "project-write",
      delegation: "off",
    });
    await Promise.resolve();
    expect(invokeMock.mock.calls.filter(([command]) => command === "acp_connect")).toHaveLength(1);
    releaseConnect?.();

    await expect(catalogPromise).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "grok-4.5" }),
        expect.objectContaining({ label: "gpt-5.6-sol" }),
      ]),
    );
    await expect(sendPromise).resolves.toMatchObject({ kind: "user" });
    expect(invokeMock.mock.calls.filter(([command]) => command === "acp_connect")).toHaveLength(1);
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "acp_start_session"),
    ).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledWith("acp_send_turn", {
      taskId: "task-cursor",
      prompt: "Reply with OK",
      delegation: "off",
    });
  });

  it("keeps two Cursor chats on independent native runtimes", async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "app_bootstrap") return { value: {} };
      if (command === "local_export") {
        return {
          projects: [
            {
              id: "project-durable",
              displayName: "integrator-3",
              repositoryRoot: "H:\\Code\\integrator-3",
              gitCommonDirectory: "H:\\Code\\integrator-3\\.git",
              createdAt: "2026-07-13T00:00:00Z",
              lastOpenedAt: "2026-07-13T00:00:00Z",
            },
          ],
          tasks: ["task-durable-a", "task-durable-b"].map((id) => ({
            id,
            title: id,
            repositoryPath: "H:\\Code\\integrator-3",
            state: "ready",
            pinned: false,
            archived: false,
            runtime: "cursor",
            model: "Provider default",
            createdAt: "2026-07-13T00:00:00Z",
            updatedAt: "2026-07-13T00:00:00Z",
          })),
          settings: [],
          providerSessions: [],
          runtimeSessions: [],
        };
      }
      if (command === "acp_start_session") {
        return { sessionId: `session-${String(args?.taskId)}` };
      }
      if (command === "acp_send_turn") return { turnId: `turn-${String(args?.taskId)}` };
      return undefined;
    });

    await bridge.loadWorkspace();
    const base = {
      runtime: "cursor" as const,
      model: "Provider default",
      permission: "project-write" as const,
      delegation: "off" as const,
    };
    await bridge.sendTurn({ ...base, taskId: "task-durable-a", prompt: "Run A" });
    await bridge.sendTurn({ ...base, taskId: "task-durable-b", prompt: "Run B" });

    expect(invokeMock.mock.calls.filter(([command]) => command === "acp_connect")).toEqual([
      [
        "acp_connect",
        {
          provider: "cursor",
          workingDirectory: "H:\\Code\\integrator-3",
          taskId: "task-durable-a",
        },
      ],
      [
        "acp_connect",
        {
          provider: "cursor",
          workingDirectory: "H:\\Code\\integrator-3",
          taskId: "task-durable-b",
        },
      ],
    ]);
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "acp_start_session"),
    ).toHaveLength(2);
    expect(invokeMock.mock.calls.filter(([command]) => command === "acp_send_turn")).toHaveLength(
      2,
    );
  });

  it("scopes Codex connections and turns to their owning chat", async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "app_bootstrap") return { value: {} };
      if (command === "local_export") {
        return {
          projects: [
            {
              id: "project-codex-durable",
              displayName: "integrator-3",
              repositoryRoot: "H:\\Code\\integrator-3",
              gitCommonDirectory: "H:\\Code\\integrator-3\\.git",
              createdAt: "2026-07-13T00:00:00Z",
              lastOpenedAt: "2026-07-13T00:00:00Z",
            },
          ],
          tasks: ["task-codex-a", "task-codex-b"].map((id) => ({
            id,
            title: id,
            repositoryPath: "H:\\Code\\integrator-3",
            state: "ready",
            pinned: false,
            archived: false,
            runtime: "codex",
            model: "Provider default",
            createdAt: "2026-07-13T00:00:00Z",
            updatedAt: "2026-07-13T00:00:00Z",
          })),
          settings: [],
          providerSessions: [],
          runtimeSessions: [],
        };
      }
      if (command === "codex_start_thread") {
        return { thread: { id: `thread-${String(args?.taskId)}` } };
      }
      if (command === "codex_start_turn") return { turn: { id: `turn-${String(args?.taskId)}` } };
      return undefined;
    });

    await bridge.loadWorkspace();
    const base = {
      runtime: "codex" as const,
      model: "Provider default",
      permission: "project-write" as const,
      delegation: "off" as const,
    };
    await bridge.sendTurn({ ...base, taskId: "task-codex-a", prompt: "Run Codex A" });
    await bridge.sendTurn({ ...base, taskId: "task-codex-b", prompt: "Run Codex B" });

    expect(invokeMock.mock.calls.filter(([command]) => command === "codex_connect")).toEqual([
      ["codex_connect", { workingDirectory: "H:\\Code\\integrator-3", taskId: "task-codex-a" }],
      ["codex_connect", { workingDirectory: "H:\\Code\\integrator-3", taskId: "task-codex-b" }],
    ]);
    expect(invokeMock).toHaveBeenCalledWith("codex_start_turn", {
      taskId: "task-codex-a",
      threadId: "thread-task-codex-a",
      prompt: "Run Codex A",
      repository: "H:\\Code\\integrator-3",
      nativeActionId: undefined,
      delegation: "off",
    });
    expect(invokeMock).toHaveBeenCalledWith("codex_start_turn", {
      taskId: "task-codex-b",
      threadId: "thread-task-codex-b",
      prompt: "Run Codex B",
      repository: "H:\\Code\\integrator-3",
      nativeActionId: undefined,
      delegation: "off",
    });
  });

  it("starts Codex with broker delegation and rethreads only when the mode changes", async () => {
    let threadStarts = 0;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "app_bootstrap") return { value: {} };
      if (command === "local_export") {
        return {
          projects: [
            {
              id: "project-codex-delegation",
              displayName: "integrator-3",
              repositoryRoot: "H:\\Code\\integrator-3",
              gitCommonDirectory: "H:\\Code\\integrator-3\\.git",
              createdAt: "2026-07-13T00:00:00Z",
              lastOpenedAt: "2026-07-13T00:00:00Z",
            },
          ],
          tasks: [
            {
              id: "task-codex-delegation",
              title: "Codex delegation",
              repositoryPath: "H:\\Code\\integrator-3",
              state: "ready",
              pinned: false,
              archived: false,
              runtime: "codex",
              model: "Provider default",
              createdAt: "2026-07-13T00:00:00Z",
              updatedAt: "2026-07-13T00:00:00Z",
            },
          ],
          settings: [],
          providerSessions: [],
          runtimeSessions: [],
        };
      }
      if (command === "codex_start_thread") {
        threadStarts += 1;
        return { thread: { id: `thread-codex-delegation-${threadStarts}` } };
      }
      if (command === "codex_start_turn") return { turn: { id: "turn-codex-delegation" } };
      return undefined;
    });

    await bridge.loadWorkspace();
    const input = {
      taskId: "task-codex-delegation",
      prompt: "Delegate this bounded task",
      runtime: "codex" as const,
      model: "Provider default",
      permission: "project-write" as const,
      delegation: "balanced" as const,
    };
    await bridge.sendTurn(input);
    await bridge.sendTurn(input);
    await bridge.sendTurn({ ...input, delegation: "manual" });

    expect(
      invokeMock.mock.calls
        .filter(([command]) => command === "codex_start_thread")
        .map(([, args]) => args?.delegation),
    ).toEqual(["balanced", "manual"]);
    expect(
      invokeMock.mock.calls
        .filter(([command]) => command === "codex_start_turn")
        .map(([, args]) => [args?.threadId, args?.delegation]),
    ).toEqual([
      ["thread-codex-delegation-1", "balanced"],
      ["thread-codex-delegation-1", "balanced"],
      ["thread-codex-delegation-2", "manual"],
    ]);
  });

  it("recreates a Grok ACP session when its broker delegation mode changes", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "app_bootstrap") return { value: {} };
      if (command === "local_export") {
        return {
          projects: [
            {
              id: "project-grok-delegation",
              displayName: "integrator-3",
              repositoryRoot: "H:\\Code\\integrator-3",
              gitCommonDirectory: "H:\\Code\\integrator-3\\.git",
              createdAt: "2026-07-13T00:00:00Z",
              lastOpenedAt: "2026-07-13T00:00:00Z",
            },
          ],
          tasks: [
            {
              id: "task-grok-delegation",
              title: "Grok delegation",
              repositoryPath: "H:\\Code\\integrator-3",
              state: "ready",
              pinned: false,
              archived: false,
              runtime: "grok",
              model: "Provider default",
              createdAt: "2026-07-13T00:00:00Z",
              updatedAt: "2026-07-13T00:00:00Z",
            },
          ],
          settings: [],
          providerSessions: [],
          runtimeSessions: [],
        };
      }
      if (command === "acp_start_session") return { sessionId: "grok-session" };
      if (command === "acp_send_turn") return { turnId: "grok-turn" };
      return undefined;
    });

    await bridge.loadWorkspace();
    const input = {
      taskId: "task-grok-delegation",
      prompt: "Delegate from Grok",
      runtime: "grok" as const,
      model: "Provider default",
      permission: "project-write" as const,
      delegation: "balanced" as const,
    };
    await bridge.sendTurn(input);
    await bridge.sendTurn(input);
    await bridge.sendTurn({ ...input, delegation: "budget-first" });

    expect(
      invokeMock.mock.calls
        .filter(([command]) => command === "acp_start_session")
        .map(([, args]) => args?.delegation),
    ).toEqual(["balanced", "budget-first"]);
    expect(
      invokeMock.mock.calls
        .filter(([command]) => command === "acp_send_turn")
        .map(([, args]) => args?.delegation),
    ).toEqual(["balanced", "balanced", "budget-first"]);
  });

  it("replaces a persisted Codex thread that the provider no longer recognizes", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "app_bootstrap") return { value: {} };
      if (command === "local_export") {
        return {
          projects: [
            {
              id: "project-codex-recovery",
              displayName: "integrator-3",
              repositoryRoot: "H:\\Code\\integrator-3",
              gitCommonDirectory: "H:\\Code\\integrator-3\\.git",
              createdAt: "2026-07-13T00:00:00Z",
              lastOpenedAt: "2026-07-13T00:00:00Z",
            },
          ],
          tasks: [
            {
              id: "task-codex-recovery",
              title: "Recover Codex",
              repositoryPath: "H:\\Code\\integrator-3",
              state: "ready",
              pinned: false,
              archived: false,
              runtime: "codex",
              model: "Provider default",
              createdAt: "2026-07-13T00:00:00Z",
              updatedAt: "2026-07-13T00:00:00Z",
            },
          ],
          settings: [],
          providerSessions: [
            {
              taskId: "task-codex-recovery",
              provider: "codex",
              providerThreadId: "thread-missing-rollout",
            },
          ],
          runtimeSessions: [],
        };
      }
      if (command === "codex_resume_thread") {
        throw {
          code: "provider-protocol",
          message:
            "provider protocol error: -32600: no rollout found for thread id thread-missing-rollout",
        };
      }
      if (command === "codex_start_thread") {
        return { thread: { id: "thread-recovered" } };
      }
      if (command === "codex_start_turn") return { turn: { id: "turn-recovered" } };
      return undefined;
    });

    await bridge.loadWorkspace();
    await expect(
      bridge.sendTurn({
        taskId: "task-codex-recovery",
        prompt: "/openai-docs build the chat app",
        runtime: "codex",
        model: "Provider default",
        permission: "project-write",
        delegation: "off",
        nativeActionId: "opaque-openai-docs",
      }),
    ).resolves.toMatchObject({ kind: "user" });

    expect(invokeMock).toHaveBeenCalledWith("codex_resume_thread", {
      taskId: "task-codex-recovery",
      threadId: "thread-missing-rollout",
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "codex_start_thread",
      expect.objectContaining({ taskId: "task-codex-recovery" }),
    );
    expect(invokeMock).toHaveBeenCalledWith("codex_start_turn", {
      taskId: "task-codex-recovery",
      threadId: "thread-recovered",
      prompt: "/openai-docs build the chat app",
      repository: "H:\\Code\\integrator-3",
      nativeActionId: "opaque-openai-docs",
      delegation: "off",
    });
  });

  it("retries once on a Codex thread lost between resume and turn start", async () => {
    let threadStarts = 0;
    let turnStarts = 0;
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "app_bootstrap") return { value: {} };
      if (command === "local_export") {
        return {
          projects: [
            {
              id: "project-codex-race-recovery",
              displayName: "integrator-3",
              repositoryRoot: "H:\\Code\\integrator-3",
              gitCommonDirectory: "H:\\Code\\integrator-3\\.git",
              createdAt: "2026-07-13T00:00:00Z",
              lastOpenedAt: "2026-07-13T00:00:00Z",
            },
          ],
          tasks: [
            {
              id: "task-codex-race-recovery",
              title: "Recover a Codex race",
              repositoryPath: "H:\\Code\\integrator-3",
              state: "ready",
              pinned: false,
              archived: false,
              runtime: "codex",
              model: "Provider default",
              createdAt: "2026-07-13T00:00:00Z",
              updatedAt: "2026-07-13T00:00:00Z",
            },
          ],
          settings: [],
          providerSessions: [],
          runtimeSessions: [],
        };
      }
      if (command === "codex_start_thread") {
        threadStarts += 1;
        return { thread: { id: `thread-race-${threadStarts}` } };
      }
      if (command === "codex_start_turn") {
        turnStarts += 1;
        if (turnStarts === 1) {
          throw {
            code: "provider-protocol",
            message: `provider protocol error: -32600: no rollout found for thread id ${String(
              args?.threadId,
            )}`,
          };
        }
        return { turn: { id: "turn-after-race" } };
      }
      return undefined;
    });

    await bridge.loadWorkspace();
    await expect(
      bridge.sendTurn({
        taskId: "task-codex-race-recovery",
        prompt: "/openai-docs build the chat app",
        runtime: "codex",
        model: "Provider default",
        permission: "project-write",
        delegation: "off",
        nativeActionId: "opaque-openai-docs-race",
      }),
    ).resolves.toMatchObject({ kind: "user" });

    expect(threadStarts).toBe(2);
    expect(turnStarts).toBe(2);
    expect(invokeMock).toHaveBeenLastCalledWith("codex_start_turn", {
      taskId: "task-codex-race-recovery",
      threadId: "thread-race-2",
      prompt: "/openai-docs build the chat app",
      repository: "H:\\Code\\integrator-3",
      nativeActionId: "opaque-openai-docs-race",
      delegation: "off",
    });
  });

  it("does not discard a healthy Codex connection for a stale action error", async () => {
    let turnStarts = 0;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "app_bootstrap") return { value: {} };
      if (command === "local_export") {
        return {
          projects: [
            {
              id: "project-codex-stale-action",
              displayName: "integrator-3",
              repositoryRoot: "H:\\Code\\integrator-3",
              gitCommonDirectory: "H:\\Code\\integrator-3\\.git",
              createdAt: "2026-07-13T00:00:00Z",
              lastOpenedAt: "2026-07-13T00:00:00Z",
            },
          ],
          tasks: [
            {
              id: "task-codex-stale-action",
              title: "Keep Codex connected",
              repositoryPath: "H:\\Code\\integrator-3",
              state: "ready",
              pinned: false,
              archived: false,
              runtime: "codex",
              model: "Provider default",
              createdAt: "2026-07-13T00:00:00Z",
              updatedAt: "2026-07-13T00:00:00Z",
            },
          ],
          settings: [],
          providerSessions: [],
          runtimeSessions: [],
        };
      }
      if (command === "codex_start_thread") return { thread: { id: "thread-stale-action" } };
      if (command === "codex_start_turn") {
        turnStarts += 1;
        if (turnStarts === 1) {
          throw {
            code: "stale-native-action",
            message: "This provider action changed; open the slash menu and choose it again",
          };
        }
        return { turn: { id: "turn-after-reselection" } };
      }
      return undefined;
    });
    const input = {
      taskId: "task-codex-stale-action",
      prompt: "/openai-docs build the chat app",
      runtime: "codex" as const,
      model: "Provider default",
      permission: "project-write" as const,
      delegation: "off" as const,
      nativeActionId: "opaque-openai-docs-stale",
    };

    await bridge.loadWorkspace();
    await expect(bridge.sendTurn(input)).rejects.toThrow("This provider action changed");
    await expect(bridge.sendTurn(input)).resolves.toMatchObject({ kind: "user" });

    expect(invokeMock.mock.calls.filter(([command]) => command === "codex_connect")).toHaveLength(
      1,
    );
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "codex_start_thread"),
    ).toHaveLength(1);
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "codex_resume_thread"),
    ).toHaveLength(0);
  });

  it("opens an HTTP(S) link through the narrow native browser command after consent", async () => {
    invokeMock.mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    const { openExternalLink } = await import("./bridge");
    await openExternalLink("https://example.com/docs?q=one%20two");

    expect(confirmSpy).toHaveBeenCalledWith(
      "Open https://example.com/docs?q=one%20two in your default browser?",
    );
    expect(invokeMock).toHaveBeenCalledWith("open_external_url", {
      url: "https://example.com/docs?q=one%20two",
    });
    confirmSpy.mockRestore();
  });

  it("keeps a declined external-link confirmation inside the app", async () => {
    invokeMock.mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    const { openExternalLink } = await import("./bridge");
    await openExternalLink("https://example.com/docs");

    expect(invokeMock).not.toHaveBeenCalledWith("open_external_url", expect.anything());
    confirmSpy.mockRestore();
  });

  it("skips the external-link confirmation when the setting is off", async () => {
    invokeMock.mockImplementation(async (command: string) =>
      command === "setting_list"
        ? [
            {
              key: "settings.general.confirmExternalActions",
              value: false,
              updatedAt: "2026-07-11T00:00:00Z",
            },
          ]
        : undefined,
    );
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    const { openExternalLink } = await import("./bridge");
    await openExternalLink("https://example.com/docs");

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("open_external_url", {
      url: "https://example.com/docs",
    });
    confirmSpy.mockRestore();
  });

  it("keeps voice typing BYOK in the native credential command boundary", async () => {
    invokeMock
      .mockResolvedValueOnce({
        configured: false,
        storage: "os-credential-store",
        provider: "openai",
      })
      .mockResolvedValueOnce({
        configured: true,
        storage: "os-credential-store",
        provider: "openai",
      })
      .mockResolvedValue(undefined);
    listenMock.mockResolvedValue(vi.fn());

    await expect(bridge.getVoiceTypingCredentialStatus?.()).resolves.toMatchObject({
      configured: false,
      storage: "os-credential-store",
    });
    await expect(bridge.setVoiceTypingCredential?.("test-key-not-a-secret")).resolves.toMatchObject(
      {
        configured: true,
      },
    );
    await bridge.clearVoiceTypingCredential?.();
    await bridge.startVoiceTyping?.();
    await bridge.appendVoiceTypingPcm?.([0, 1, 255, 254]);
    await bridge.stopVoiceTyping?.();
    await bridge.subscribeVoiceTyping?.(vi.fn());

    expect(invokeMock).toHaveBeenNthCalledWith(1, "voice_typing_credential_status", undefined);
    expect(invokeMock).toHaveBeenNthCalledWith(2, "voice_typing_credential_set", {
      apiKey: "test-key-not-a-secret",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "voice_typing_credential_clear", undefined);
    expect(invokeMock).toHaveBeenNthCalledWith(4, "voice_typing_start", undefined);
    expect(invokeMock).toHaveBeenNthCalledWith(5, "voice_typing_append", {
      pcm: [0, 1, 255, 254],
    });
    expect(invokeMock).toHaveBeenNthCalledWith(6, "voice_typing_stop", undefined);
    expect(listenMock).toHaveBeenCalledWith("voice-typing://event", expect.any(Function));
  });

  it("keeps queued-message mutations behind narrow task-scoped commands", async () => {
    invokeMock.mockResolvedValue(undefined);
    await bridge.clearLocalData();
    invokeMock.mockReset();
    const input = {
      taskId: "task-queue",
      prompt: "Review the latest diff",
      attachments: [{ path: "src/App.tsx", name: "App.tsx", kind: "file" as const }],
      runtime: "claude" as const,
      model: "claude-sonnet-5",
      effort: "medium",
      permission: "project-write" as const,
      delegation: "balanced" as const,
    };
    const queued = {
      ...input,
      id: "queue-1",
      position: 0,
      state: "queued" as const,
      createdAt: "2026-07-14T19:00:00Z",
      updatedAt: "2026-07-14T19:00:00Z",
    };
    const dispatching = { ...queued, state: "dispatching" as const };
    invokeMock
      .mockResolvedValueOnce(queued)
      .mockResolvedValueOnce([queued])
      .mockResolvedValueOnce([queued])
      .mockResolvedValueOnce(dispatching)
      .mockResolvedValueOnce(dispatching);

    await expect(bridge.enqueueMessage(input)).resolves.toEqual(queued);
    await expect(bridge.listQueuedMessages("task-queue")).resolves.toEqual([queued]);
    await expect(bridge.reorderQueuedMessages("task-queue", ["queue-1"])).resolves.toEqual([
      queued,
    ]);
    await expect(
      bridge.setQueuedMessageDispatching("task-queue", "queue-1", true),
    ).resolves.toEqual(dispatching);
    await expect(bridge.takeQueuedMessage("task-queue", "queue-1")).resolves.toEqual(dispatching);

    expect(invokeMock).toHaveBeenNthCalledWith(1, "queued_message_enqueue", { input });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "queued_message_list", {
      taskId: "task-queue",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "queued_message_reorder", {
      taskId: "task-queue",
      orderedIds: ["queue-1"],
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, "queued_message_set_dispatching", {
      taskId: "task-queue",
      messageId: "queue-1",
      dispatching: true,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(5, "queued_message_take", {
      taskId: "task-queue",
      messageId: "queue-1",
    });
  });

  it("keeps storage and usage reads on narrow native commands", async () => {
    invokeMock
      .mockResolvedValueOnce({
        totalBytes: 128,
        databaseBytes: 96,
        walBytes: 24,
        sharedMemoryBytes: 8,
        measuredAt: "2026-07-11T00:00:00Z",
        kind: "sqlite",
      })
      .mockResolvedValueOnce({
        providers: [
          {
            provider: "codex",
            taskCount: 1,
            turnCount: 2,
            inputTokens: 10,
            cachedInputTokens: 2,
            outputTokens: 8,
            reasoningOutputTokens: 4,
            totalTokens: 20,
            provenance: "vendor_exact",
            detail: "Provider-reported token usage.",
          },
        ],
        measuredAt: "2026-07-11T00:00:00Z",
      });

    await expect(bridge.getStorageTotals()).resolves.toMatchObject({ kind: "sqlite" });
    await expect(bridge.getUsageSummary()).resolves.toMatchObject({
      providers: [expect.objectContaining({ provider: "codex", totalTokens: 20 })],
    });
    expect(invokeMock).toHaveBeenNthCalledWith(1, "storage_totals", undefined);
    expect(invokeMock).toHaveBeenNthCalledWith(2, "usage_summary", undefined);
  });
});

describe("browser fallback usage evidence", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("records local turn evidence without inventing vendor plan telemetry", async () => {
    const staleSnapshot = await bridge.loadWorkspace();
    const event = await bridge.sendTurn({
      taskId: "v1-shell",
      prompt: "Verify browser fallback local usage tracking",
      runtime: "codex",
      model: "Provider default",
      permission: "project-write",
      delegation: "off",
    });

    // This mirrors React persisting the snapshot from the render that submitted
    // the turn. The immediate ledger event must not be lost to that later write.
    await bridge.persistSession({
      ...staleSnapshot,
      transcript: [...staleSnapshot.transcript, event],
    });
    const persisted = await bridge.loadWorkspace();
    const usage = persisted.taskContexts["v1-shell"].usage;

    expect(usage.localObserved?.events.some((entry) => entry.id === event.id)).toBe(true);
    expect(usage.tokens).toBeGreaterThan(30);
    expect(usage.equivalentUsd).toBeGreaterThan(0);
    expect(usage.subscriptionPercent).toBeUndefined();
    expect(usage.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Local turns", provenance: "local_observed" }),
        expect.objectContaining({ label: "Input tokens (estimate)", provenance: "estimated" }),
        expect.objectContaining({ label: "Subscription usage", provenance: "unavailable" }),
      ]),
    );
  });

  it("searches only user and assistant message text in browser-local history", async () => {
    await expect(bridge.searchTaskMessages("typed local bridge")).resolves.toEqual([
      expect.objectContaining({
        taskId: "v1-shell",
        snippet: expect.stringMatching(/typed local bridge/i),
      }),
    ]);
    await expect(bridge.searchTaskMessages("Read 12 product contracts")).resolves.toEqual([]);
  });

  it("does not offer browser storage for the BYOK key", async () => {
    await expect(bridge.setVoiceTypingCredential?.("test-key-not-a-secret")).rejects.toThrow(
      "Secure BYOK storage is available in the native app only.",
    );
    expect(window.localStorage.getItem("aiintegrator.settings.v1") ?? "").not.toContain("test-key");
    await expect(bridge.getVoiceTypingCredentialStatus?.()).resolves.toEqual({
      configured: false,
      storage: "native-only",
      provider: "openai",
    });
  });

  it("reports browser storage and labels provider usage as local estimates", async () => {
    const totals = await bridge.getStorageTotals();
    const summary = await bridge.getUsageSummary();

    expect(totals.kind).toBe("browser-local-storage");
    expect(totals.totalBytes).toBeGreaterThanOrEqual(0);
    expect(summary.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "codex",
          provenance: "estimated",
          detail: expect.stringContaining("browser preview"),
        }),
      ]),
    );
  });
});
