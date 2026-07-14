// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { bridge } from "./bridge";
import { createDemoSnapshot, createEmptySnapshot } from "./demoData";

const DEMO_STORAGE_KEY = "aiintegrator.demo.workspace.v2";

function storeSnapshot(snapshot: ReturnType<typeof createDemoSnapshot>) {
  window.localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(snapshot));
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.documentElement.removeAttribute("style");
});

describe("AI Integrator desktop workspace", () => {
  it("renders the agent-first workspace with Git and local usage evidence", async () => {
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "Construct the native v1 workspace" }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("tab", { name: /^Git/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // No provider reports quota in the demo snapshot: the pill shows tokens
    // only instead of a dead "—%".
    const usagePill = screen.getByTitle(/Subscription usage unavailable/);
    expect(usagePill).not.toHaveTextContent("%");
    expect(usagePill).toHaveTextContent("tokens");
    expect(screen.getByPlaceholderText("Commit message")).toBeInTheDocument();
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

    // Collapse fully unmounts each panel once the slide-out animation ends.
    fireEvent.click(screen.getByRole("button", { name: "Close chat navigation" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Open chat navigation" }));
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
    expect(await screen.findByText("Terminal unavailable for this test.")).toBeInTheDocument();
    expect(openTerminal).toHaveBeenCalledTimes(1);

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.queryByLabelText("Project terminal")).not.toBeInTheDocument(),
    );
    fireEvent.click(toggle);

    expect(await screen.findByText("Terminal unavailable for this test.")).toBeInTheDocument();
    expect(openTerminal).toHaveBeenCalledTimes(1);
  });

  it("opens Settings as a full replacement view and applies a theme preset", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Settings" }));
    expect(
      await screen.findByRole("heading", { name: "Appearance" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("complementary", { name: "Chat navigation" }),
    ).not.toBeInTheDocument();

    const themeGroup = screen.getByRole("radiogroup", { name: "Theme preset" });
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
    await screen.findByRole("heading", { name: "Appearance" });

    const navigation = screen.getByRole("complementary", { name: "Settings navigation" });
    const appearance = within(navigation).getByRole("button", { name: "Appearance" });
    const general = within(navigation).getByRole("button", { name: "General" });

    expect(appearance.querySelector(".settings-nav-active")).toBeInTheDocument();
    expect(navigation.querySelectorAll(".settings-nav-active")).toHaveLength(1);

    fireEvent.click(general);
    await screen.findByRole("heading", { name: "General" });
    await waitFor(() => {
      expect(general.querySelector(".settings-nav-active")).toBeInTheDocument();
      expect(appearance.querySelector(".settings-nav-active")).not.toBeInTheDocument();
      expect(navigation.querySelectorAll(".settings-nav-active")).toHaveLength(1);
    });
  });

  it("keeps Settings out of the workspace view tabs and reachable from the sidebar", async () => {
    render(<App />);
    await screen.findByRole("tab", { name: "Task" });
    expect(screen.queryByRole("tab", { name: "Settings" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(await screen.findByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Back to workspace/i })).toBeInTheDocument();
  });

  it("exposes only real, wired settings categories and persists local policy choices", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Settings" }));
    await screen.findByRole("heading", { name: "Appearance" });
    const categoryLabels = [
      "General",
      "Appearance",
      "Composer",
      "Models",
      "Runtimes",
      "Permissions",
      "Usage & budgets",
    ];
    for (const label of categoryLabels) {
      expect(screen.getByRole("button", { name: new RegExp(label, "i") })).toBeInTheDocument();
    }
    // Placeholder categories with no consuming behavior must not resurface.
    for (const removed of [
      "Delegation",
      "Skills",
      "Memory & context",
      "Notifications",
      "Advanced",
    ]) {
      expect(
        screen.queryByRole("button", { name: new RegExp(removed, "i") }),
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

    fireEvent.click(screen.getByRole("button", { name: /Appearance/i }));
    expect(
      await screen.findByRole("heading", { name: "Semantic color overrides" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Body weight" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Body line height" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Search Settings" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Models/ }));
    expect(await screen.findByRole("heading", { name: "Models" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Default model" }));
    fireEvent.click(screen.getByRole("option", { name: "GPT-5.4" }));
    expect(window.localStorage.getItem("aiintegrator.settings.v1")).toContain(
      "models.defaultModel",
    );
    fireEvent.click(screen.getByRole("button", { name: "Default runtime" }));
    fireEvent.click(screen.getByRole("option", { name: "Claude Code" }));
    expect(screen.queryByText("Vendor login warning")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Usage & budgets/i }));
    expect(await screen.findByRole("heading", { name: "Per-provider usage" })).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole("button", { name: /^Models/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Default model" }));
    fireEvent.click(screen.getByRole("option", { name: "GPT-5.4" }));
    const effort = await screen.findByRole("button", { name: "Default effort" });
    expect(effort).toHaveTextContent("Medium");

    fireEvent.click(effort);
    expect(screen.getByRole("option", { name: "None" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Minimal" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Extra high" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Default model" }));
    fireEvent.click(screen.getByRole("option", { name: "GPT-5 mini" }));
    expect(await screen.findByLabelText("Default effort unavailable")).toHaveTextContent(
      "Not exposed by this model",
    );
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
    fireEvent.click(await screen.findByRole("button", { name: /^New chat(?! in)/ }));

    expect(await screen.findByRole("button", { name: "Runtime" })).toHaveTextContent("Claude Code");
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Claude Fable 5");
  });

  it("uses Settings changes when the next chat is created", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Models/ }));
    fireEvent.click(screen.getByRole("button", { name: "Default runtime" }));
    fireEvent.click(screen.getByRole("option", { name: "Claude Code" }));
    fireEvent.click(screen.getByRole("button", { name: "Default model" }));
    fireEvent.click(screen.getByRole("option", { name: "Claude Sonnet 5" }));
    fireEvent.click(screen.getByRole("button", { name: /Back to workspace/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^New chat(?! in)/ }));

    expect(await screen.findByRole("button", { name: "Runtime" })).toHaveTextContent("Claude Code");
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Claude Sonnet 5");
  });

  it("repairs a stale model default after a runtime change", async () => {
    window.localStorage.setItem(
      "aiintegrator.settings.v1",
      JSON.stringify({
        "settings.models.defaultRuntime": "claude",
        "settings.models.defaultModel": "GPT-5.4",
      }),
    );

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /^New chat(?! in)/ }));

    expect(await screen.findByRole("button", { name: "Runtime" })).toHaveTextContent("Claude Code");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Claude Fable 5"),
    );
  });

  it("opens a syntax-aware review from the Git rail", async () => {
    render(<App />);
    const fileButton = await screen.findByTitle("src/runtime/router.ts");
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
    expect(await screen.findByText(/Ctrl Enter to send/)).toBeInTheDocument();
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

  it("opens a trusted project file from the Files tree into the rail reader", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("tab", { name: "Files" }));
    fireEvent.click(await screen.findByTitle("Open src/runtime/router.ts"));
    expect(await screen.findByRole("tab", { name: /router\.ts/ })).toBeInTheDocument();
    expect(await screen.findByLabelText("Contents of src/runtime/router.ts")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Task" }));
    const composer = screen.getByRole("textbox", { name: "Task message" });
    fireEvent.change(composer, { target: { value: "Measure a local usage event" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Measure a local usage event");

    fireEvent.click(screen.getByRole("tab", { name: "Usage" }));
    expect(await screen.findByText("Local turns")).toBeInTheDocument();
    expect(screen.getByText("Input tokens (estimate)")).toBeInTheDocument();
    expect(screen.getByText("Subscription usage")).toBeInTheDocument();
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
    expect(await screen.findByRole("heading", { name: /coding agents/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Find my agents/i }));
    expect(
      await screen.findByRole("heading", { name: /Connect what is already here/i }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/Passwords and tokens are never imported into AI Integrator/),
    ).toBeInTheDocument();
  });

  it("offers a calm empty native state and opens a browser-demo project", async () => {
    const empty = createEmptySnapshot();
    empty.runtimes = createDemoSnapshot().runtimes;
    storeSnapshot(empty);
    render(<App />);

    const heading = await screen.findByRole("heading", { name: "Open a local Git project" });
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
    fireEvent.click(within(chooser).getByRole("button", { name: /Create from scratch/ }));

    const nameField = await screen.findByLabelText("Project name");
    fireEvent.change(nameField, { target: { value: "fresh-idea" } });
    fireEvent.click(screen.getByRole("button", { name: /^Create project$/ }));

    expect(
      await screen.findByRole("heading", { name: "What are we working on?" }),
    ).toBeInTheDocument();
    expect(screen.getByText("fresh-idea", { selector: ".empty-task-kicker" })).toBeInTheDocument();
  });

  it("creates a durable task before sending when a project has no active task", async () => {
    const snapshot = createDemoSnapshot();
    snapshot.tasks = [];
    snapshot.activeTaskId = "";
    snapshot.transcript = [];
    storeSnapshot(snapshot);
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "What are we working on?" }),
    ).toBeInTheDocument();
    const composer = screen.getByRole("textbox", { name: "Task message" });
    fireEvent.change(composer, { target: { value: "Audit the trusted project boundary" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(
      await screen.findByRole("heading", { name: "Audit the trusted project boundary" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Audit the trusted project boundary", { selector: ".turn--user p" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Queued for execution")).toBeInTheDocument();
  });

  it("starts a clean local draft from New chat without creating durable chat junk", async () => {
    const snapshot = createDemoSnapshot();
    snapshot.tasks = [];
    snapshot.activeTaskId = "";
    snapshot.transcript = [];
    storeSnapshot(snapshot);
    render(<App />);

    const composer = await screen.findByRole("textbox", { name: "Task message" });
    fireEvent.change(composer, { target: { value: "unsent draft" } });
    const newChatLabel = await screen.findByText("New chat", {
      selector: ".new-task-button span",
    });
    fireEvent.click(newChatLabel.closest("button") as HTMLButtonElement);
    expect(await screen.findByRole("heading", { name: "New chat" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Task message" })).toHaveValue("");
    expect(screen.getByRole("heading", { name: "What are we working on?" })).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: "Open project Lotmind AI" }));
    expect(
      await screen.findByRole("heading", { name: "Mobile intake overnight agent" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Lotmind transcript")).toBeInTheDocument();
    expect(screen.queryByText("Integrator transcript")).not.toBeInTheDocument();
    expect(screen.getByTitle(/222,000 tokens on this task/)).toHaveTextContent("222k tokens");

    fireEvent.click(screen.getByRole("button", { name: "Open project AI Integrator" }));
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

    fireEvent.click(screen.getByRole("button", { name: "Open project Lotmind AI" }));
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
    expect(screen.getByRole("button", { name: /Certify Codex and ACP adapters/ })).toHaveFocus();
  });
});
