// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import App from "./App";
import { createDemoSnapshot, createEmptySnapshot } from "./demoData";

const DEMO_STORAGE_KEY = "aiintegrator.demo.workspace.v1";

function storeSnapshot(snapshot: ReturnType<typeof createDemoSnapshot>) {
  window.localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(snapshot));
}

afterEach(() => {
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
    expect(screen.getByTitle("Subscription plan usage")).toHaveTextContent("34%");
    expect(screen.getByDisplayValue("Build polished native v1 workspace")).toBeInTheDocument();
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
    const commentButton = screen.getAllByRole("button", { name: /Comment on line 43/ })[0];
    commentButton.focus();
    expect(document.activeElement).toBe(commentButton);
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

  it("keeps vendor login inside the guided setup flow", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Runtime setup" }));
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

    expect(
      await screen.findByRole("heading", { name: "What should the first agent do?" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("demo-project", { selector: ".empty-task-kicker" }),
    ).toBeInTheDocument();
  });

  it("creates a durable task before sending when a project has no active task", async () => {
    const snapshot = createDemoSnapshot();
    snapshot.tasks = [];
    snapshot.activeTaskId = "";
    snapshot.transcript = [];
    storeSnapshot(snapshot);
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "What should the first agent do?" }),
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
    expect(
      screen.getByRole("heading", { name: "What should the first agent do?" }),
    ).toBeInTheDocument();
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
    expect(screen.getByTitle("Subscription plan usage")).toHaveTextContent("222k");

    fireEvent.click(screen.getByRole("button", { name: "Open project AI Integrator" }));
    expect(
      await screen.findByRole("region", { name: /Diff for src\/runtime\/router\.ts/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Construct the native v1 workspace/ }),
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
