// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LazyMotion, domAnimation } from "motion/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserTab } from "../bridge";
import { BrowserWindowShell } from "./BrowserWindowShell";

const mocks = vi.hoisted(() => ({
  initializeTheme: vi.fn(),
  normalizeThemePreferences: vi.fn((value: unknown) => value),
  setThemePreferences: vi.fn(),
  loadWorkspace: vi.fn(),
  listSettings: vi.fn(),
  poppedOutTabs: vi.fn(),
  subscribe: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  setPoppedOut: vi.fn(),
  invoke: vi.fn(async () => undefined),
  onFocusRequest: vi.fn(),
  focusListener: null as null | ((request: { taskId: string; tabId: string }) => void),
  setFocus: vi.fn(async () => undefined),
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  closeWindow: vi.fn(),
  setTitle: vi.fn(async () => undefined),
  useBrowserTabs: vi.fn(),
  listener: null as null | (() => void),
}));

const TABS: BrowserTab[] = [
  {
    id: "tab-a",
    taskId: "task-a",
    groupId: "project:test",
    groupName: "Test project",
    groupKind: "project",
    url: "https://example.com/a",
    title: "Alpha",
    loading: false,
    poppedOut: true,
    hidden: false,
    sleeping: false,
  },
  {
    id: "tab-b",
    taskId: "task-a",
    groupId: "project:test",
    groupName: "Test project",
    groupKind: "project",
    url: "https://example.com/b",
    title: "Beta",
    loading: false,
    poppedOut: true,
    hidden: true,
    sleeping: false,
  },
];

const CHAT_TABS: BrowserTab[] = [
  TABS[0],
  {
    id: "tab-c",
    taskId: "task-c",
    groupId: "chat",
    groupName: "Chat",
    groupKind: "chat",
    url: "https://example.com/c",
    title: "Gamma",
    loading: false,
    poppedOut: true,
    hidden: true,
    sleeping: false,
  },
];

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: mocks.minimize,
    toggleMaximize: mocks.toggleMaximize,
    close: mocks.closeWindow,
    setTitle: mocks.setTitle,
    setFocus: mocks.setFocus,
  }),
}));

vi.mock("../bridge", () => ({
  bridge: {
    listSettings: mocks.listSettings,
    loadWorkspace: mocks.loadWorkspace,
    browser: {
      poppedOutTabs: mocks.poppedOutTabs,
      subscribe: mocks.subscribe,
      open: mocks.open,
      close: mocks.close,
      setPoppedOut: mocks.setPoppedOut,
      invoke: mocks.invoke,
      onFocusRequest: mocks.onFocusRequest,
    },
  },
}));

vi.mock("../theme", () => ({
  initializeTheme: mocks.initializeTheme,
  normalizeThemePreferences: mocks.normalizeThemePreferences,
  setThemePreferences: mocks.setThemePreferences,
}));

vi.mock("../useBrowserTabs", () => ({
  useBrowserTabs: (...args: unknown[]) => mocks.useBrowserTabs(...args),
}));

vi.mock("./BrowserSurface", () => ({
  BrowserSurface: ({ tab }: { tab: BrowserTab }) => (
    <div data-testid="browser-surface" data-task-id={tab.taskId}>
      {tab.title}
    </div>
  ),
}));

function controllerFor(taskId: string | null | undefined) {
  const tabs = [...TABS, ...CHAT_TABS].filter((tab) => tab.taskId === taskId);
  return {
    tabs,
    byId: Object.fromEntries(tabs.map((tab) => [tab.id, tab])),
    posters: {},
    message: null,
    allowExternalOpen: false,
    recordingTabId: null,
    annotatingTabId: null,
    open: vi.fn(),
    setPoppedOut: vi.fn(),
    setBounds: vi.fn(),
    navigate: vi.fn(),
    history: vi.fn(),
    screenshot: vi.fn(),
    toggleRecording: vi.fn(),
    toggleAnnotate: vi.fn(),
    openExternally: vi.fn(),
    saveLogin: vi.fn(),
    fillLogin: vi.fn(),
    setToolbarTooltip: vi.fn(),
    close: vi.fn(),
  };
}

function renderShell() {
  return render(
    <LazyMotion features={domAnimation} strict>
      <BrowserWindowShell />
    </LazyMotion>,
  );
}

describe("BrowserWindowShell chrome", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listener = null;
    window.history.replaceState({}, "", "/?surface=browser&taskId=task-a");
    mocks.listSettings.mockResolvedValue([]);
    mocks.loadWorkspace.mockResolvedValue({
      tasks: [{ id: "task-a", title: "Browser Feature Wishlist" }],
    });
    mocks.poppedOutTabs.mockResolvedValue(TABS);
    mocks.subscribe.mockImplementation(async (listener: () => void) => {
      mocks.listener = listener;
      return () => undefined;
    });
    mocks.open.mockResolvedValue({ ...TABS[0], id: "tab-new", title: "", url: "about:blank" });
    mocks.setPoppedOut.mockResolvedValue(undefined);
    mocks.close.mockResolvedValue(true);
    mocks.focusListener = null;
    mocks.onFocusRequest.mockImplementation(
      async (listener: (request: { taskId: string; tabId: string }) => void) => {
        mocks.focusListener = listener;
        return () => undefined;
      },
    );
    window.sessionStorage.clear();
    document.documentElement.dataset.motion = "none";
    mocks.useBrowserTabs.mockImplementation(
      (_host: unknown, options?: { taskId?: string | null }) => controllerFor(options?.taskId),
    );
  });

  it("uses the task theme and name and exposes complete browser-window chrome", async () => {
    renderShell();

    await waitFor(() =>
      expect(mocks.setTitle).toHaveBeenCalledWith("Browser Feature Wishlist — Integrator Browser"),
    );
    expect(mocks.initializeTheme).toHaveBeenCalled();
    expect(await screen.findAllByRole("tab")).toHaveLength(2);
    // The group pill names the strip now: one pill, in front of its tabs.
    const pill = screen.getByRole("button", { name: "Test project, 2 tabs, expanded" });
    expect(pill).toHaveAttribute("data-color");
    expect(pill.nextElementSibling).toHaveClass("browser-window-tab");
    const addTab = screen.getByRole("button", { name: "New browser tab" });
    expect(screen.getByRole("tablist").nextElementSibling).toBe(addTab);
    expect(addTab.nextElementSibling).toHaveClass("browser-window-strip-spacer");
    expect(screen.getByRole("button", { name: "Minimize browser window" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Maximize or restore browser window" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close browser window" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send Alpha to the app" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close Alpha" })).toBeInTheDocument();
    expect(screen.getByTestId("browser-surface")).toHaveTextContent("Alpha");
    expect(mocks.useBrowserTabs).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ taskId: "task-a", poppedOutHost: true }),
    );
  });

  it("uses the native saved theme when the main window hydrated it from local data", async () => {
    const savedTheme = { themeId: "ash" };
    mocks.listSettings.mockResolvedValue([{ key: "appearance.theme", value: savedTheme }]);

    renderShell();

    await waitFor(() => expect(mocks.normalizeThemePreferences).toHaveBeenCalledWith(savedTheme));
    expect(mocks.setThemePreferences).toHaveBeenCalledWith(savedTheme, { persist: false });
    expect(mocks.initializeTheme).not.toHaveBeenCalled();
  });

  it("adds, docks, and controls the independent window without conflating the actions", async () => {
    renderShell();
    await screen.findAllByRole("tab");

    fireEvent.click(screen.getByRole("button", { name: "New browser tab" }));
    await waitFor(() => expect(mocks.open).toHaveBeenCalledWith("task-a"));
    await waitFor(() => expect(mocks.setPoppedOut).toHaveBeenCalledWith("task-a", "tab-new", true));

    fireEvent.click(screen.getByRole("button", { name: "Send Alpha to the app" }));
    expect(mocks.setPoppedOut).toHaveBeenCalledWith("task-a", "tab-a", false);

    // X closes for real; Minus is the way back to the pane.
    fireEvent.click(screen.getByRole("button", { name: "Close Beta" }));
    await waitFor(() => expect(mocks.close).toHaveBeenCalledWith("task-a", "tab-b"));

    fireEvent.click(screen.getByRole("button", { name: "Minimize browser window" }));
    fireEvent.click(screen.getByRole("button", { name: "Maximize or restore browser window" }));
    fireEvent.click(screen.getByRole("button", { name: "Close browser window" }));
    expect(mocks.minimize).toHaveBeenCalledTimes(1);
    expect(mocks.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(mocks.closeWindow).toHaveBeenCalledTimes(1);
  });

  it("focuses a newly popped tab when the native list changes, and closes on middle click", async () => {
    renderShell();
    await screen.findAllByRole("tab");
    expect(mocks.listener).not.toBeNull();

    const arriving: BrowserTab = { ...TABS[1], id: "tab-z", title: "Zeta", taskId: "task-a" };
    mocks.poppedOutTabs.mockResolvedValue([...TABS, arriving]);
    await act(async () => {
      mocks.listener?.();
    });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Zeta" })).toHaveAttribute("aria-selected", "true"),
    );

    fireEvent(
      screen.getByRole("tab", { name: "Alpha" }).parentElement!,
      new MouseEvent("auxclick", { bubbles: true, button: 1 }),
    );
    expect(mocks.close).toHaveBeenCalledWith("task-a", "tab-a");
  });

  it("drives the strip from the keyboard unless a text field has focus", async () => {
    renderShell();
    await screen.findAllByRole("tab");
    expect(screen.getByRole("tab", { name: "Alpha" })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
    expect(screen.getByRole("tab", { name: "Beta" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true, shiftKey: true });
    expect(screen.getByRole("tab", { name: "Alpha" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(window, { key: "2", ctrlKey: true });
    expect(screen.getByRole("tab", { name: "Beta" })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(window, { key: "w", ctrlKey: true });
    await waitFor(() => expect(mocks.close).toHaveBeenCalledWith("task-a", "tab-b"));

    fireEvent.keyDown(window, { key: "t", ctrlKey: true });
    await waitFor(() => expect(mocks.open).toHaveBeenCalledWith("task-a"));

    // Ctrl+Shift+T brings back the tab Ctrl+W just closed, at its address.
    mocks.open.mockClear();
    fireEvent.keyDown(window, { key: "T", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(mocks.open).toHaveBeenCalledWith("task-a", "https://example.com/b"));

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    mocks.open.mockClear();
    fireEvent.keyDown(input, { key: "t", ctrlKey: true });
    expect(mocks.open).not.toHaveBeenCalled();
    input.remove();
  });

  it("collapses a group behind its pill and moves the selection to a neighbour", async () => {
    const other: BrowserTab = {
      ...TABS[0],
      id: "tab-o",
      taskId: "task-o",
      groupId: "project:other",
      groupName: "Other project",
      title: "Omega",
    };
    mocks.poppedOutTabs.mockResolvedValue([...TABS, other]);
    renderShell();
    expect(await screen.findAllByRole("tab")).toHaveLength(3);
    const pill = screen.getByRole("button", { name: "Test project, 2 tabs, expanded" });

    fireEvent.click(pill);
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
    expect(screen.getByRole("tab", { name: "Omega" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Test project, 2 tabs, collapsed" })).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    // Cycling skips the folded group.
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
    expect(screen.getByRole("tab", { name: "Omega" })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("button", { name: "Test project, 2 tabs, collapsed" }));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(3));
  });

  it("brings an agent's tab to the front inside a collapsed group without unfolding it", async () => {
    renderShell();
    await screen.findAllByRole("tab");
    fireEvent.click(screen.getByRole("button", { name: "Test project, 2 tabs, expanded" }));
    await waitFor(() => expect(screen.queryAllByRole("tab")).toHaveLength(0));
    await waitFor(() => expect(mocks.focusListener).not.toBeNull());

    await act(async () => {
      mocks.focusListener?.({ taskId: "task-a", tabId: "tab-b" });
    });
    expect(screen.getByTestId("browser-surface")).toHaveTextContent("Beta");
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Test project, 2 tabs, collapsed" })).toHaveAttribute(
      "data-active-hidden",
      "true",
    );
    expect(mocks.setFocus).toHaveBeenCalled();
  });

  it("marks a tab an agent is driving and names the chat in its tooltip text", async () => {
    mocks.poppedOutTabs.mockResolvedValue([{ ...TABS[0], heldBy: "the main agent" }, TABS[1]]);
    renderShell();
    await screen.findAllByRole("tab");
    const tab = screen.getByRole("tab", { name: "Alpha" }).parentElement!;
    expect(tab).toHaveAttribute("data-busy", "true");
    expect(screen.getByRole("button", { name: "Test project, 2 tabs, expanded" })).toHaveAttribute(
      "data-live",
      "true",
    );
  });
});

describe("BrowserWindowShell chat window", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listener = null;
    window.history.replaceState({}, "", "/?surface=browser&scope=chat");
    mocks.listSettings.mockResolvedValue([]);
    mocks.loadWorkspace.mockResolvedValue({ tasks: [] });
    mocks.poppedOutTabs.mockResolvedValue(CHAT_TABS);
    mocks.subscribe.mockImplementation(async (listener: () => void) => {
      mocks.listener = listener;
      return () => undefined;
    });
    mocks.open.mockResolvedValue({ ...CHAT_TABS[1], id: "tab-new", title: "", url: "about:blank" });
    mocks.setPoppedOut.mockResolvedValue(undefined);
    mocks.onFocusRequest.mockResolvedValue(() => undefined);
    window.sessionStorage.clear();
    mocks.useBrowserTabs.mockImplementation(
      (_host: unknown, options?: { taskId?: string | null }) => controllerFor(options?.taskId),
    );
  });

  it("lists tabs from several chats under their own pills, docks each with its own task, and names itself after the page", async () => {
    renderShell();

    expect(await screen.findAllByRole("tab")).toHaveLength(2);
    // Two groups in one strip: the project's pill and the Chat pill, in the
    // order their tabs arrived.
    const pills = screen.getAllByRole("button", { pressed: true });
    expect(pills.map((pill) => pill.getAttribute("data-group-id"))).toEqual([
      "project:test",
      "chat",
    ]);
    expect(pills[0].getAttribute("data-color")).not.toBe(pills[1].getAttribute("data-color"));
    expect(screen.getByText("Chat")).toBeInTheDocument();
    await waitFor(() => expect(mocks.setTitle).toHaveBeenCalledWith("Alpha — Integrator Browser"));
    expect(screen.getByTestId("browser-surface")).toHaveAttribute("data-task-id", "task-a");

    fireEvent.click(screen.getByRole("tab", { name: "Gamma" }));
    expect(screen.getByTestId("browser-surface")).toHaveAttribute("data-task-id", "task-c");
    expect(mocks.useBrowserTabs).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ taskId: "task-c" }),
    );
    await waitFor(() => expect(mocks.setTitle).toHaveBeenCalledWith("Gamma — Integrator Browser"));

    fireEvent.click(screen.getByRole("button", { name: "Send Gamma to the app" }));
    expect(mocks.setPoppedOut).toHaveBeenCalledWith("task-c", "tab-c", false);
    fireEvent.click(screen.getByRole("button", { name: "Send Alpha to the app" }));
    expect(mocks.setPoppedOut).toHaveBeenCalledWith("task-a", "tab-a", false);

    // A new tab opens under the chat whose page is in front.
    fireEvent.click(screen.getByRole("button", { name: "New browser tab" }));
    await waitFor(() => expect(mocks.open).toHaveBeenCalledWith("task-c"));
    await waitFor(() => expect(mocks.setPoppedOut).toHaveBeenCalledWith("task-c", "tab-new", true));
  });

  it("shows a quiet empty state and a plain title when nothing is out here", async () => {
    mocks.poppedOutTabs.mockResolvedValue([]);
    renderShell();

    expect(await screen.findByRole("status")).toHaveTextContent("Nothing out here yet");
    await waitFor(() => expect(mocks.setTitle).toHaveBeenCalledWith("Integrator Browser"));
  });
});
