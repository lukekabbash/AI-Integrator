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
  resolveModelEffort,
  runtimeAuthWarning,
} from "./bridge";

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

  it("uses the normalized sequenced event and task-control command contracts", async () => {
    const unlisten = vi.fn();
    const listener = vi.fn();
    listenMock.mockResolvedValue(unlisten);
    invokeMock
      .mockResolvedValueOnce({ events: [], watermarkSeq: 41 })
      .mockResolvedValueOnce({ id: "approval-1", state: "responding" })
      .mockResolvedValueOnce({ turnId: "turn-1", stopRequested: true, alreadyRequested: false });

    await expect(bridge.subscribeRuntimeProjections(listener)).resolves.toBe(unlisten);
    expect(listenMock).toHaveBeenCalledWith("runtime://projection", expect.any(Function));
    await expect(bridge.loadTaskProjection("task-1")).resolves.toEqual({
      events: [],
      watermarkSeq: 41,
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
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("acp_connect", expect.anything()));
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
    expect(invokeMock.mock.calls.filter(([command]) => command === "acp_start_session")).toHaveLength(
      1,
    );
    expect(invokeMock).toHaveBeenCalledWith("acp_send_turn", {
      taskId: "task-cursor",
      prompt: "Reply with OK",
      delegation: "off",
    });
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
