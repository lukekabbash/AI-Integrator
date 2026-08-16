// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { clearOptimisticMessageForTask, isComposerTurnBusy } from "./appTurnState";
import { bridge } from "./bridge";
import { createDemoSnapshot, createEmptySnapshot } from "./demoData";

const DEMO_STORAGE_KEY = "aiintegrator.demo.workspace.v2";

function storeSnapshot(snapshot: ReturnType<typeof createDemoSnapshot>) {
  window.localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(snapshot));
}

afterEach(() => {
  vi.restoreAllMocks();
  bridge.invalidateModelCatalog("codex");
  bridge.invalidateModelCatalog("claude");
  bridge.invalidateModelCatalog("antigravity");
  bridge.invalidateModelCatalog("cursor");
  bridge.invalidateModelCatalog("grok");
  bridge.invalidateModelCatalog("custom");
  window.localStorage.clear();
  document.documentElement.removeAttribute("style");
});

describe("AI Integrator desktop workspace", () => {
  it("does not let an older task clear another task's optimistic message", () => {
    const current = {
      taskId: "task-b",
      event: {
        id: "optimistic-b",
        kind: "user" as const,
        body: "Newer task message",
        timestamp: "2026-07-16T03:00:00Z",
        status: "neutral" as const,
      },
    };

    expect(clearOptimisticMessageForTask(current, "task-a")).toBe(current);
    expect(clearOptimisticMessageForTask(current, "task-b")).toBeNull();
  });

  it("treats every launch and queue handoff phase as composer-busy", () => {
    const idle = {
      projectedTurnActive: false,
      optimisticTurnStarting: false,
      resuming: false,
      queueBusy: false,
      queueAwaiting: false,
    };
    expect(isComposerTurnBusy(idle)).toBe(false);

    for (const key of Object.keys(idle) as Array<keyof typeof idle>) {
      expect(isComposerTurnBusy({ ...idle, [key]: true })).toBe(true);
    }
  });

  it("renders the agent-first workspace with Git and local usage evidence", async () => {
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "Construct the native v1 workspace" }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("tab", { name: /^Git/ }, { timeout: 5_000 })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // No provider reports quota in the demo snapshot: the pill shows tokens
    // only instead of a dead "—%".
    const usagePill = screen.getByRole("button", { name: /Plan usage not exposed/ });
    expect(usagePill).not.toHaveTextContent("%");
    expect(usagePill).toHaveTextContent("tokens");
    expect(screen.getByPlaceholderText("Commit message")).toBeInTheDocument();
  });

  it("opens a new chat without reloading the warmed model catalog", async () => {
    bridge.invalidateModelCatalog("codex");
    const listModelCatalog = vi.spyOn(bridge, "listModelCatalog");

    render(<App />);
    await waitFor(() => expect(listModelCatalog).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "New chatCtrl N" }));
    await screen.findByRole("textbox", { name: "Task message" });

    expect(listModelCatalog).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Model" })).not.toHaveTextContent("Checking model…");
  });

  it("opens Review in the work pane from the view tabs", async () => {
    render(<App />);
    const tabs = await screen.findByRole("tablist", { name: "Task view" });
    const task = within(tabs).getByRole("tab", { name: "Task" });
    const review = within(tabs).getByRole("tab", { name: "Review" });
    expect(task.querySelector(".sliding-tab-indicator")).toBeInTheDocument();
    expect(tabs.querySelectorAll(".sliding-tab-indicator")).toHaveLength(1);

    // Review is a work-pane tab now; the transcript keeps the canvas.
    fireEvent.click(review);
    const surfaces = await screen.findByRole("tablist", { name: "Open surfaces" });
    expect(within(surfaces).getByRole("tab", { name: "Review" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(document.querySelector(".work-pane-content")).toHaveAttribute("data-kind", "review");
    expect(screen.getByRole("textbox", { name: "Task message" })).toBeInTheDocument();
  });

  it("takes the work pane off screen when it is closed", async () => {
    // Regression: the pane used to animate out and then stay mounted, holding
    // its width while every control reported it closed.
    render(<App />);
    const tabs = await screen.findByRole("tablist", { name: "Task view" });
    fireEvent.click(within(tabs).getByRole("tab", { name: "Review" }));
    await screen.findByRole("tablist", { name: "Open surfaces" });
    const appRoot = document.querySelector<HTMLElement>(".app-root");
    expect(appRoot).toHaveAttribute("data-subagent-visible", "true");

    fireEvent.click(screen.getByRole("button", { name: "Close work pane" }));
    await waitFor(() => expect(document.querySelector(".work-pane")).toBeNull());
    expect(appRoot).toHaveAttribute("data-subagent-visible", "false");
    expect(screen.getByRole("button", { name: "Open work pane" })).toBeInTheDocument();
  });

  it("collapses and reopens both sidebars from the header corner buttons", async () => {
    render(<App />);
    const appRoot = document.querySelector<HTMLElement>(".app-root");
    expect(appRoot).not.toBeNull();
    expect(
      await screen.findByRole("complementary", { name: "Chat navigation" }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("complementary", { name: "Task tools" })).toBeInTheDocument();
    expect(appRoot).toHaveAttribute("data-sidebar-visible", "true");
    expect(appRoot).toHaveAttribute("data-rail-visible", "true");

    const viewMenu = screen.getByRole("button", { name: "View" }).closest(".titlebar-menu-group");
    const sidebarToggle = screen.getByRole("button", { name: "Close chat navigation" });
    expect(viewMenu?.nextElementSibling).toBe(sidebarToggle);

    // Collapse fully unmounts each panel once the slide-out animation ends.
    fireEvent.click(sidebarToggle);
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Chat navigation" }),
      ).not.toBeInTheDocument(),
    );
    expect(appRoot).toHaveAttribute("data-sidebar-visible", "false");
    expect(appRoot).toHaveAttribute("data-rail-visible", "true");
    fireEvent.click(screen.getByRole("button", { name: "Close task tools" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Task tools" })).not.toBeInTheDocument(),
    );
    expect(appRoot).toHaveAttribute("data-rail-visible", "false");

    // The corner buttons stay put and bring each panel back.
    expect(screen.getByRole("button", { name: "Open chat navigation" })).toBe(sidebarToggle);
    fireEvent.click(sidebarToggle);
    expect(
      await screen.findByRole("complementary", { name: "Chat navigation" }),
    ).toBeInTheDocument();
    expect(appRoot).toHaveAttribute("data-sidebar-visible", "true");
    expect(appRoot).toHaveAttribute("data-rail-visible", "false");
    fireEvent.click(screen.getByRole("button", { name: "Open task tools" }));
    expect(await screen.findByRole("complementary", { name: "Task tools" })).toBeInTheDocument();
    expect(appRoot).toHaveAttribute("data-rail-visible", "true");
  });

  it("loads the terminal on first use and keeps its session state mounted across toggles", async () => {
    const openTerminal = vi
      .spyOn(bridge, "openTerminal")
      .mockRejectedValue(new Error("Terminal unavailable for this test."));

    render(<App />);
    const toggle = await screen.findByRole("button", { name: "Toggle terminal" });
    expect(openTerminal).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    expect(
      await screen.findByText("Terminal unavailable for this test.", {
        selector: ".terminal-failure",
      }),
    ).toBeInTheDocument();
    expect(openTerminal).toHaveBeenCalledTimes(1);

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(document.querySelector(".terminal-drawer")).toHaveAttribute("aria-hidden", "true"),
    );
    expect(document.querySelector(".terminal-drawer")).toHaveAttribute("inert");
    fireEvent.click(toggle);

    expect(
      await screen.findByText("Terminal unavailable for this test.", {
        selector: ".terminal-failure",
      }),
    ).toBeInTheDocument();
    expect(document.querySelector(".terminal-drawer")).not.toHaveAttribute("aria-hidden");
    expect(openTerminal).toHaveBeenCalledTimes(1);
  });

  function mockStructuredUsageSummary() {
    vi.spyOn(bridge, "getUsageSummary").mockResolvedValue({
      measuredAt: "2026-07-17T18:00:00Z",
      providers: [
        {
          provider: "codex",
          taskCount: 2,
          turnCount: 8,
          inputTokens: 120_000,
          cachedInputTokens: 70_000,
          outputTokens: 20_000,
          reasoningOutputTokens: 5_000,
          totalTokens: 215_000,
          provenance: "vendor_exact",
          detail: "Provider-reported token usage from the persisted native projection.",
          subscription: {
            planType: "pro",
            resetCreditsAvailable: 3,
            updatedAt: "2026-07-17T18:00:00Z",
            buckets: [
              {
                limitId: "codex",
                limitName: "GPT-5 Codex",
                primary: {
                  usedPercent: 20,
                  windowDurationMins: 10_080,
                  resetsAt: 1_900_000_000,
                },
              },
              {
                limitId: "codex-spark",
                limitName: "GPT-5 Codex Spark",
                primary: {
                  usedPercent: 0,
                  windowDurationMins: 10_080,
                  resetsAt: 1_900_000_000,
                },
              },
            ],
          },
          accountUsage: {
            summary: {
              lifetimeTokens: 4_200_000,
              peakDailyTokens: 550_000,
              currentStreakDays: 4,
              longestStreakDays: 12,
            },
            dailyUsageBuckets: [{ startDate: "2026-07-17", tokens: 42_000 }],
            updatedAt: "2026-07-17T18:00:00Z",
          },
        },
      ],
    });
  }

  it("opens Settings as a full replacement view and applies a theme preset", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Settings" }));
    expect(
      await screen.findByRole("heading", { name: "General" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("complementary", { name: "Chat navigation" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    const themeGroup = await screen.findByRole("radiogroup", { name: "Theme preset" });
    const ocean = within(themeGroup).getByRole("radio", { name: /Ocean/i });
    fireEvent.click(ocean);
    expect(ocean).toHaveAttribute("aria-checked", "true");
    expect(document.documentElement.dataset.theme).toBe("ocean");

    fireEvent.click(screen.getByRole("button", { name: /Back to workspace/i }));
    expect(
      await screen.findByRole("complementary", { name: "Chat navigation" }),
    ).toBeInTheDocument();
  });

  it("moves one active marker with the selected Settings category", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Settings" }));
    await screen.findByRole("heading", { name: "General" }, { timeout: 5000 });

    const navigation = screen.getByRole("complementary", { name: "Settings navigation" });
    const appearance = within(navigation).getByRole("button", { name: "Appearance" });
    const general = within(navigation).getByRole("button", { name: "General" });

    expect(general.querySelector(".settings-nav-active")).toBeInTheDocument();
    expect(navigation.querySelectorAll(".settings-nav-active")).toHaveLength(1);

    fireEvent.click(appearance);
    await screen.findByRole("heading", { name: "Appearance" });
    await waitFor(() => {
      expect(appearance.querySelector(".settings-nav-active")).toBeInTheDocument();
      expect(general.querySelector(".settings-nav-active")).not.toBeInTheDocument();
      expect(navigation.querySelectorAll(".settings-nav-active")).toHaveLength(1);
    });
  });

  it("keeps Settings out of the workspace view tabs and reachable from the sidebar", async () => {
    render(<App />);
    await screen.findByRole("tab", { name: "Task" });
    expect(screen.queryByRole("tab", { name: "Settings" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(
      await screen.findByRole("heading", { name: "General" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Back to workspace/i })).toBeInTheDocument();
  });

  it("exposes only real, wired settings categories and persists local policy choices", async () => {
    mockStructuredUsageSummary();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Settings" }));
    await screen.findByRole("heading", { name: "General" }, { timeout: 5000 });
    // Scope to the settings rail: the workspace screen is still cross-fading
    // out when these assertions run, so global queries could see its buttons.
    const navigation = screen.getByRole("complementary", { name: "Settings navigation" });
    const categoryLabels = [
      "General",
      "Personalization",
      "Appearance",
      "Composer",
      "Runtimes and Models",
      "Skills and Plugins",
      "Subagents",
      "Permissions",
      "Git",
      "Browser",
      "Explain",
      "Usage and Budgets",
      "Archives",
    ];
    expect(
      Array.from(navigation.querySelectorAll("nav button"), (button) => button.textContent?.trim()),
    ).toEqual(categoryLabels);
    for (const label of categoryLabels) {
      expect(
        within(navigation).getByRole("button", { name: new RegExp(label, "i") }),
      ).toBeInTheDocument();
    }
    // Placeholder categories with no consuming behavior must not resurface.
    for (const removed of ["Delegation", "Memory & context", "Notifications", "Advanced"]) {
      expect(
        within(navigation).queryByRole("button", { name: new RegExp(removed, "i") }),
      ).not.toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole("button", { name: /General/i }));
    expect(
      await screen.findByRole("heading", { name: /Voice typing.*bring your own key/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("OpenAI API key for voice typing")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save key" })).toBeDisabled();
    expect(screen.getByText("Native app storage required")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Storage totals" })).toBeInTheDocument();
    const restore = screen.getByRole("switch", { name: "Restore last workspace" });
    expect(restore).toHaveAttribute("aria-checked", "true");
    fireEvent.click(restore);
    expect(restore).toHaveAttribute("aria-checked", "false");
    expect(window.localStorage.getItem("aiintegrator.settings.v1")).toContain(
      "general.openLastWorkspace",
    );
    const saveContext = screen.getByRole("switch", { name: "Save context on edit" });
    expect(saveContext).toHaveAttribute("aria-checked", "false");
    fireEvent.click(saveContext);
    expect(saveContext).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("button", { name: /Appearance/i }));
    expect(
      await screen.findByRole("heading", { name: "Semantic color overrides" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Body weight" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Body line height" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Search Settings" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Runtimes/ }));
    expect(await screen.findByRole("heading", { name: "Runtimes and Models" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit defaults for Codex" }));
    fireEvent.click(screen.getByRole("button", { name: "Preferred model for codex" }));
    fireEvent.click(screen.getByRole("option", { name: "GPT-5.4" }));
    expect(window.localStorage.getItem("aiintegrator.settings.v1")).toContain(
      "models.defaultsByRuntime",
    );
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: "Favorite runtime" })).toHaveTextContent("Last used");

    const settingsScroll = document.querySelector<HTMLElement>(".settings-content-scroll");
    expect(settingsScroll).not.toBeNull();
    if (settingsScroll) settingsScroll.scrollTop = 500;
    fireEvent.click(screen.getByRole("button", { name: /Usage and Budgets/i }));
    expect(await screen.findByRole("heading", { name: "Available now" })).toBeInTheDocument();
    await waitFor(() => expect(settingsScroll).toHaveProperty("scrollTop", 0));
    expect(await screen.findByText("80% remaining")).toBeInTheDocument();
    expect(screen.getByText("GPT-5 Codex Spark")).toBeInTheDocument();
    expect(screen.getByText("3 reset credits")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Codex account activity" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Local history" })).toBeInTheDocument();
  });

  it("manages archived chats from the Archives settings section", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Settings" }));
    await screen.findByRole("heading", { name: "General" }, { timeout: 5000 });
    const navigation = screen.getByRole("complementary", { name: "Settings navigation" });
    fireEvent.click(within(navigation).getByRole("button", { name: "Archives" }));
    expect(await screen.findByRole("heading", { name: "Archives" })).toBeInTheDocument();

    // Retention controls persist like every other setting.
    const autoDelete = screen.getByRole("button", { name: "Auto-delete archived chats" });
    fireEvent.click(autoDelete);
    fireEvent.click(screen.getByRole("option", { name: "After 7 days" }));
    expect(window.localStorage.getItem("aiintegrator.settings.v1")).toContain(
      "archive.autoDeleteAfter",
    );

    // Demo data starts with nothing archived; the list explains itself.
    expect(await screen.findByText(/Nothing archived/i)).toBeInTheDocument();

    // Restore the default so later tests are not left with an active retention
    // sweep from this settings change.
    fireEvent.click(screen.getByRole("button", { name: "Auto-delete archived chats" }));
    fireEvent.click(screen.getByRole("option", { name: "Never" }));
  });

  it("uses each selected model's advertised effort list in Settings", async () => {
    vi.spyOn(bridge, "listModelCatalog").mockResolvedValue([
      { id: "Provider default", label: "Provider default" },
      {
        id: "GPT-5.4",
        label: "GPT-5.4",
        efforts: [
          { id: "none", label: "None" },
          { id: "minimal", label: "Minimal" },
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
          { id: "xhigh", label: "Extra high" },
        ],
        defaultEffort: "none",
      },
      { id: "gpt-5-mini", label: "GPT-5 mini" },
    ]);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Runtimes/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit defaults for Codex" }));
    fireEvent.click(await screen.findByRole("button", { name: "Preferred model for codex" }));
    fireEvent.click(screen.getByRole("option", { name: "GPT-5.4" }));
    const effort = await screen.findByRole("button", { name: "Preferred effort for codex" });
    expect(effort).toHaveTextContent("None");

    fireEvent.click(effort);
    expect(screen.getByRole("option", { name: "None" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Minimal" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Extra high" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preferred model for codex" }));
    fireEvent.click(screen.getByRole("option", { name: "GPT-5 mini" }));
    expect(
      await screen.findByLabelText("Preferred effort unavailable for codex"),
    ).toHaveTextContent("Not exposed by this model");
  });

  it("applies saved default runtime and model to a new chat", async () => {
    window.localStorage.setItem(
      "aiintegrator.settings.v1",
      JSON.stringify({
        "settings.models.defaultRuntime": "claude",
        "settings.models.defaultModel": "Claude Fable 5",
      }),
    );

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New chat in AI Integrator" }));

    expect(await screen.findByRole("button", { name: "Runtime" })).toHaveTextContent("Claude Code");
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Claude Fable 5");
  });

  it("inherits the last-used runtime when no runtime is favorited", async () => {
    window.localStorage.setItem(
      "aiintegrator.settings.v1",
      JSON.stringify({
        "settings.models.defaultRuntime": "",
        "settings.models.lastRuntime": "claude",
        "settings.models.defaultsByRuntime": {
          claude: { model: "Claude Sonnet 5", effort: "high" },
        },
      }),
    );

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New chat in AI Integrator" }));

    expect(await screen.findByRole("button", { name: "Runtime" })).toHaveTextContent("Claude Code");
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Claude Sonnet 5");
  });

  it("uses Settings changes when the next chat is created", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Runtimes/ }));
    fireEvent.click(screen.getByRole("button", { name: "Favorite runtime" }));
    fireEvent.click(screen.getByRole("option", { name: "Claude Code" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit defaults for Claude Code" }));
    fireEvent.click(screen.getByRole("button", { name: "Preferred model for claude" }));
    fireEvent.click(screen.getByRole("option", { name: "Claude Sonnet 5" }));
    fireEvent.click(screen.getByRole("button", { name: /Back to workspace/i }));
    fireEvent.click(await screen.findByRole("button", { name: "New chat in AI Integrator" }));

    expect(await screen.findByRole("button", { name: "Runtime" })).toHaveTextContent("Claude Code");
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Claude Sonnet 5");
  }, 10_000);

  it("repairs a stale model default after a runtime change", async () => {
    window.localStorage.setItem(
      "aiintegrator.settings.v1",
      JSON.stringify({
        "settings.models.defaultRuntime": "claude",
        "settings.models.defaultModel": "GPT-5.4",
      }),
    );

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New chat in AI Integrator" }));

    expect(await screen.findByRole("button", { name: "Runtime" })).toHaveTextContent("Claude Code");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Claude Fable 5"),
    );
  });

  it("opens a syntax-aware review from the Git rail", async () => {
    render(<App />);
    const fileButton = await screen.findByRole("button", { name: "src/runtime/router.ts" });
    fireEvent.click(fileButton);
    expect(
      await screen.findByRole("region", { name: /Diff for src\/runtime\/router\.ts/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("resolveProvider", { selector: ".syntax-function" }),
    ).toBeInTheDocument();
    expect(document.querySelectorAll(".diff-line--add").length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".diff-line--delete").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Comment on line 43/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
    expect(screen.getByRole("button", { name: "Reviewed" })).toBeInTheDocument();
  });

  it("offers reasoning effort only for models that support it and follows the picker", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Model" }));
    const effortTrigger = await screen.findByRole("button", { name: "Reasoning effort" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(effortTrigger).toHaveTextContent("Medium");

    fireEvent.click(effortTrigger);
    fireEvent.click(await screen.findByRole("option", { name: "High" }));
    expect(screen.getByRole("button", { name: "Reasoning effort" })).toHaveTextContent("High");

    fireEvent.click(screen.getByRole("button", { name: "Runtime" }));
    fireEvent.click(await screen.findByRole("option", { name: /Cursor/ }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Reasoning effort" })).not.toBeInTheDocument(),
    );
  });

  it("sends a composer turn through the typed bridge fallback", async () => {
    render(<App />);
    const composer = await screen.findByRole("textbox", { name: "Task message" });
    fireEvent.change(composer, { target: { value: "Verify recovery after restart" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(screen.getByText("Verify recovery after restart")).toBeInTheDocument(),
    );
    expect(await screen.findByText("Queued for execution")).toBeInTheDocument();
  });

  it("honors the persisted Enter-key setting in the composer", async () => {
    window.localStorage.setItem(
      "aiintegrator.settings.v1",
      JSON.stringify({ "settings.composer.enterToSend": false }),
    );
    render(<App />);

    const composer = await screen.findByRole("textbox", { name: "Task message" });
    fireEvent.change(composer, { target: { value: "draft stays put" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(composer).toHaveValue("draft stays put");

    fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(
        screen.getByText("draft stays put", { selector: ".turn--user p" }),
      ).toBeInTheDocument(),
    );
  });

  it("keeps provider model and effort on a chat when switching away and back", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Model" }));
    const effortTrigger = await screen.findByRole("button", { name: "Reasoning effort" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(effortTrigger).toHaveTextContent("Medium");
    fireEvent.click(effortTrigger);
    fireEvent.click(await screen.findByRole("option", { name: "High" }));
    expect(screen.getByRole("button", { name: "Reasoning effort" })).toHaveTextContent("High");

    const sidebar = screen.getByRole("complementary", { name: "Chat navigation" });
    fireEvent.click(within(sidebar).getByText("Certify Codex and ACP adapters"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Runtime" })).toHaveTextContent(/Cursor/i),
    );

    fireEvent.click(within(sidebar).getByText("Construct the native v1 workspace"));
    fireEvent.click(await screen.findByRole("button", { name: "Model" }));
    expect(await screen.findByRole("button", { name: "Reasoning effort" })).toHaveTextContent(
      "High",
    );
    expect(screen.getByRole("button", { name: "Runtime" })).toHaveTextContent(/Codex/i);
  });

  it("preselects the persisted default permission profile for new chats", async () => {
    window.localStorage.setItem(
      "aiintegrator.settings.v1",
      JSON.stringify({ "settings.permissions.defaultProfile": "read-only" }),
    );
    render(<App />);

    await screen.findByRole("button", { name: "Permission" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Permission" })).toHaveTextContent("Read only"),
    );
  });

  it("applies a Settings permission change to the task the user returns to", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Permission" });

    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    await screen.findByRole("heading", { name: "General" }, { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: "Permissions" }));
    fireEvent.click(await screen.findByRole("button", { name: "Default profile" }));
    fireEvent.click(screen.getByRole("option", { name: /Full access/i }));
    fireEvent.click(screen.getByRole("button", { name: /Back to workspace/i }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Permission" })).toHaveTextContent("Full access"),
    );
  });

  it("opens a trusted project file as a work-pane tab beside the conversation", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("tab", { name: "Files" }, { timeout: 5000 }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Open src/runtime/router.ts" }, { timeout: 5000 }),
    );
    // The file becomes a work-pane tab; the transcript keeps the canvas.
    const fileTab = await screen.findByRole("tab", { name: /router\.ts/ });
    expect(fileTab).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByLabelText("Contents of src/runtime/router.ts")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Task message" })).toBeInTheDocument();

    fireEvent.click(
      await screen.findByRole(
        "button",
        { name: "Open src/components/UsageMeter.tsx" },
        { timeout: 5000 },
      ),
    );
    await screen.findByRole("tab", { name: /UsageMeter\.tsx/ }, { timeout: 5000 });
    const openFiles = screen.getByRole("tablist", { name: "Open surfaces" });
    expect(
      within(openFiles)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["router.ts", "UsageMeter.tsx"]);
    expect(screen.getByRole("tab", { name: /UsageMeter\.tsx/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // Clicking a tab brings that file back; closing it activates the neighbour.
    fireEvent.click(screen.getByRole("tab", { name: /router\.ts/ }));
    expect(await screen.findByLabelText("Contents of src/runtime/router.ts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close src/runtime/router.ts" }));
    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: /router\.ts/ })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("tab", { name: /UsageMeter\.tsx/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // The composer never left; the pane holds the file beside it.
    const composer = screen.getByRole("textbox", { name: "Task message" });
    fireEvent.change(composer, { target: { value: "Measure a local usage event" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Measure a local usage event");

    fireEvent.click(screen.getByRole("tab", { name: "Usage" }));
    expect(await screen.findByText("Local turns")).toBeInTheDocument();
    expect(screen.getByText("Input tokens (estimate)")).toBeInTheDocument();
    expect(screen.queryByText("API equivalent (estimate)")).not.toBeInTheDocument();
    expect(screen.getByText("Plan telemetry not exposed")).toBeInTheDocument();
  });

  it("turns the top File, Edit, and View labels into workspace actions", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "File" }));
    expect(screen.getByRole("menu", { name: "File" })).toHaveTextContent("Open project");
    expect(screen.getByRole("menu", { name: "File" })).toHaveTextContent("New chat");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Focus composer" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Task message" })).toHaveFocus(),
    );

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Review changes" }));
    expect(await screen.findByRole("region", { name: /Diff for / })).toBeInTheDocument();
  });

  it("keeps vendor login inside the guided setup flow", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Runtime setup" }));
    expect(await screen.findByRole("heading", { name: /coding agent/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Set up my runtimes/i }));
    expect(
      await screen.findByRole("heading", { name: /Connect your installed CLIs/i }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/never pass through or get stored by AI Integrator/),
    ).toBeInTheDocument();
  });

  it("offers a calm empty native state and opens a browser-demo project", async () => {
    const empty = createEmptySnapshot();
    empty.runtimes = createDemoSnapshot().runtimes;
    storeSnapshot(empty);
    render(<App />);

    const heading = await screen.findByRole("heading", { name: "Open a local project" });
    const emptyState = heading.closest("section");
    expect(emptyState).not.toBeNull();
    fireEvent.click(
      within(emptyState as HTMLElement).getByRole("button", { name: /Open project/ }),
    );

    const chooser = await screen.findByRole("dialog", { name: "Add a project" });
    fireEvent.click(within(chooser).getByRole("button", { name: /Open local folder/ }));

    expect(
      await screen.findByRole("heading", { name: "What are we working on?" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("demo-project", { selector: ".empty-task-kicker" }),
    ).toBeInTheDocument();
  });

  it("creates a brand-new project from scratch through the add-project modal", async () => {
    const empty = createEmptySnapshot();
    empty.runtimes = createDemoSnapshot().runtimes;
    storeSnapshot(empty);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Open project/ }));
    const chooser = await screen.findByRole("dialog", { name: "Add a project" });
    fireEvent.click(within(chooser).getByRole("button", { name: /Create new project/ }));

    const nameField = await screen.findByLabelText("Project name");
    fireEvent.change(nameField, { target: { value: "fresh-idea" } });
    fireEvent.click(screen.getByRole("button", { name: /^Create project$/ }));

    expect(
      await screen.findByRole("heading", { name: "What are we working on?" }),
    ).toBeInTheDocument();
    expect(screen.getByText("fresh-idea", { selector: ".empty-task-kicker" })).toBeInTheDocument();
  });

  it("clones a repository selected from the GitHub CLI catalog", async () => {
    const empty = createEmptySnapshot();
    empty.runtimes = createDemoSnapshot().runtimes;
    storeSnapshot(empty);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Open project/ }));
    const chooser = await screen.findByRole("dialog", { name: "Add a project" });
    fireEvent.click(within(chooser).getByRole("button", { name: /Clone repository/ }));
    fireEvent.click(await screen.findByRole("option", { name: /demo\/ai-integrator/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Clone repository$/ }));

    expect(
      await screen.findByRole("heading", { name: "What are we working on?" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("ai-integrator", { selector: ".empty-task-kicker" }),
    ).toBeInTheDocument();
  });

  it("creates a durable task before sending when a project has no active task", async () => {
    const snapshot = createDemoSnapshot();
    snapshot.tasks = [];
    snapshot.activeTaskId = "";
    snapshot.transcript = [];
    storeSnapshot(snapshot);
    const startTask = vi.spyOn(bridge, "startTask");
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "What are we working on?" }),
    ).toBeInTheDocument();
    const composer = screen.getByRole("textbox", { name: "Task message" });
    fireEvent.change(composer, { target: { value: "Audit the trusted project boundary" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(startTask).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: snapshot.activeProjectId,
          prompt: "Audit the trusted project boundary",
        }),
      ),
    );
    expect(await screen.findByRole("heading", { name: "Coding session" })).toBeInTheDocument();
    expect(
      await screen.findByText("Audit the trusted project boundary", { selector: ".turn--user p" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Queued for execution")).toBeInTheDocument();
  });

  it("reopens the same project-level new-chat draft without creating chat junk", async () => {
    const snapshot = createDemoSnapshot();
    snapshot.tasks = [];
    snapshot.activeTaskId = "";
    snapshot.transcript = [];
    storeSnapshot(snapshot);
    render(<App />);

    await screen.findByRole("heading", { name: "New chat" });
    const composer = await screen.findByRole("textbox", { name: "Task message" });
    const saveDraft = vi.spyOn(bridge, "saveComposerDraft");
    fireEvent.change(composer, { target: { value: "unsent draft" } });
    await waitFor(() =>
      expect(saveDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: { kind: "newChat", projectId: snapshot.activeProjectId },
          prompt: "unsent draft",
        }),
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "New chat in AI Integrator" }));
    expect(await screen.findByRole("heading", { name: "New chat" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Task message" })).toHaveValue("unsent draft");
    expect(screen.getByRole("heading", { name: "What are we working on?" })).toBeInTheDocument();
  });

  it("keeps independent drafts for a new chat and an ongoing chat", async () => {
    const snapshot = createDemoSnapshot();
    snapshot.composerDrafts = [];
    storeSnapshot(snapshot);
    const saveDraft = vi.spyOn(bridge, "saveComposerDraft");
    render(<App />);

    const composer = await screen.findByRole("textbox", { name: "Task message" });
    fireEvent.change(composer, { target: { value: "Follow up in the existing chat" } });
    await waitFor(() =>
      expect(saveDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: { kind: "task", taskId: snapshot.activeTaskId },
          prompt: "Follow up in the existing chat",
        }),
      ),
    );

    fireEvent.click(await screen.findByRole("button", { name: "New chat in AI Integrator" }));
    const newComposer = await screen.findByRole("textbox", { name: "Task message" });
    expect(newComposer).toHaveValue("");
    fireEvent.change(newComposer, { target: { value: "Start a separate piece of work" } });
    await waitFor(() =>
      expect(saveDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: { kind: "newChat", projectId: snapshot.activeProjectId },
          prompt: "Start a separate piece of work",
        }),
      ),
    );

    const sidebar = screen.getByRole("complementary", { name: "Chat navigation" });
    fireEvent.click(
      within(sidebar).getByRole("button", { name: /Construct the native v1 workspace/ }),
    );
    expect(await screen.findByRole("textbox", { name: "Task message" })).toHaveValue(
      "Follow up in the existing chat",
    );

    fireEvent.click(await screen.findByRole("button", { name: "New chat in AI Integrator" }));
    expect(await screen.findByRole("textbox", { name: "Task message" })).toHaveValue(
      "Start a separate piece of work",
    );
  });

  it("switches projects in one click and restores each project's last chat and center view", async () => {
    const snapshot = createDemoSnapshot();
    snapshot.taskContexts["v1-shell"] = {
      transcript: [
        {
          id: "integrator-message",
          kind: "user",
          body: "Integrator transcript",
          timestamp: "2026-07-10T10:00:00Z",
        },
      ],
      git: { ...snapshot.git, branch: "integrator-branch" },
      usage: { ...snapshot.usage, tokens: 111_000 },
      children: [],
    };
    snapshot.taskContexts.overnight = {
      transcript: [
        {
          id: "lotmind-message",
          kind: "user",
          body: "Lotmind transcript",
          timestamp: "2026-07-10T11:00:00Z",
        },
      ],
      git: { ...snapshot.git, branch: "lotmind-branch" },
      usage: { ...snapshot.usage, tokens: 222_000 },
      children: [],
    };
    storeSnapshot(snapshot);
    render(<App />);

    fireEvent.click(await screen.findByRole("tab", { name: "Review" }));
    expect(
      await screen.findByRole("region", { name: /Diff for src\/runtime\/router\.ts/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Lotmind AI" }));
    expect(
      await screen.findByRole("heading", { name: "Mobile intake overnight agent" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Lotmind transcript")).toBeInTheDocument();
    expect(screen.queryByText("Integrator transcript")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /222,000 tokens on this task/ })).toHaveTextContent(
      "222k tokens",
    );

    fireEvent.click(screen.getByRole("button", { name: "AI Integrator" }));
    expect(
      await screen.findByRole("region", { name: /Diff for src\/runtime\/router\.ts/i }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("complementary", { name: "Chat navigation" })).getByRole("button", {
        name: /Construct the native v1 workspace/,
      }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("uses the sidebar as the sole project and chat navigation", async () => {
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Construct the native v1 workspace" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Open workspace items")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Open projects" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Open chats" })).not.toBeInTheDocument();

    const sidebar = screen.getByRole("complementary", { name: "Chat navigation" });
    expect(
      within(sidebar).getByRole("button", { name: /Construct the native v1 workspace/ }),
    ).toHaveAttribute("aria-current", "page");

    fireEvent.click(
      within(sidebar).getByRole("button", { name: /Certify Codex and ACP adapters/ }),
    );
    expect(
      await screen.findByRole("heading", { name: "Certify Codex and ACP adapters" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Lotmind AI" }));
    expect(
      await screen.findByRole("heading", { name: "Mobile intake overnight agent" }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("complementary", { name: "Chat navigation" })).getByRole("button", {
        name: /Mobile intake overnight agent/,
      }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("opens keyboard search and moves focus into unique chat results", async () => {
    render(<App />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const search = await screen.findByRole("textbox", { name: "Search chats" });
    await waitFor(() => expect(search).toHaveFocus());
    fireEvent.change(search, { target: { value: "adapter" } });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(
      within(screen.getByRole("dialog", { name: "Search chats" })).getByRole("button", {
        name: /Certify Codex and ACP adapters/,
      }),
    ).toHaveFocus();
  });
});
