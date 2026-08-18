// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserTab } from "../bridge";
import { BrowserWindowShell } from "./BrowserWindowShell";

const mocks = vi.hoisted(() => ({
  initializeTheme: vi.fn(),
  normalizeThemePreferences: vi.fn((value: unknown) => value),
  setThemePreferences: vi.fn(),
  loadWorkspace: vi.fn(),
  listSettings: vi.fn(),
  open: vi.fn(),
  setPoppedOut: vi.fn(),
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  closeWindow: vi.fn(),
  setTitle: vi.fn(),
}));

const TABS: BrowserTab[] = [
  {
    id: "tab-a",
    taskId: "task-a",
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
    url: "https://example.com/b",
    title: "Beta",
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
  }),
}));

vi.mock("../bridge", () => ({
  bridge: {
    listSettings: mocks.listSettings,
    loadWorkspace: mocks.loadWorkspace,
  },
}));

vi.mock("../theme", () => ({
  initializeTheme: mocks.initializeTheme,
  normalizeThemePreferences: mocks.normalizeThemePreferences,
  setThemePreferences: mocks.setThemePreferences,
}));

vi.mock("../useBrowserTabs", () => ({
  useBrowserTabs: () => ({
    tabs: TABS,
    byId: Object.fromEntries(TABS.map((tab) => [tab.id, tab])),
    posters: {},
    message: null,
    allowExternalOpen: false,
    recordingTabId: null,
    annotatingTabId: null,
    open: mocks.open,
    setPoppedOut: mocks.setPoppedOut,
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
  }),
}));

vi.mock("./BrowserSurface", () => ({
  BrowserSurface: ({ tab }: { tab: BrowserTab }) => (
    <div data-testid="browser-surface">{tab.title}</div>
  ),
}));

describe("BrowserWindowShell chrome", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, "", "/?surface=browser&taskId=task-a");
    mocks.listSettings.mockResolvedValue([]);
    mocks.loadWorkspace.mockResolvedValue({
      tasks: [{ id: "task-a", title: "Browser Feature Wishlist" }],
    });
    mocks.open.mockResolvedValue({ ...TABS[0], id: "tab-new", title: "", url: "about:blank" });
    mocks.setPoppedOut.mockResolvedValue(undefined);
  });

  it("uses the task theme and name and exposes complete browser-window chrome", async () => {
    render(<BrowserWindowShell />);

    expect(await screen.findByText("Browser Feature Wishlist")).toBeInTheDocument();
    expect(mocks.initializeTheme).toHaveBeenCalled();
    expect(mocks.setTitle).toHaveBeenCalledWith("Browser Feature Wishlist — Integrator Browser");
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "New browser tab" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Minimize browser window" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Maximize or restore browser window" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close browser window" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Return Alpha to the app" })).toBeInTheDocument();
  });

  it("uses the native saved theme when the main window hydrated it from local data", async () => {
    const savedTheme = { themeId: "ash" };
    mocks.listSettings.mockResolvedValue([{ key: "appearance.theme", value: savedTheme }]);

    render(<BrowserWindowShell />);

    await waitFor(() => expect(mocks.normalizeThemePreferences).toHaveBeenCalledWith(savedTheme));
    expect(mocks.setThemePreferences).toHaveBeenCalledWith(savedTheme, { persist: false });
    expect(mocks.initializeTheme).not.toHaveBeenCalled();
  });

  it("adds, docks, and controls the independent window without conflating the actions", async () => {
    render(<BrowserWindowShell />);

    fireEvent.click(screen.getByRole("button", { name: "New browser tab" }));
    await waitFor(() => expect(mocks.setPoppedOut).toHaveBeenCalledWith("tab-new", true));

    fireEvent.click(screen.getByRole("button", { name: "Return Alpha to the app" }));
    expect(mocks.setPoppedOut).toHaveBeenCalledWith("tab-a", false);

    fireEvent.click(screen.getByRole("button", { name: "Minimize browser window" }));
    fireEvent.click(screen.getByRole("button", { name: "Maximize or restore browser window" }));
    fireEvent.click(screen.getByRole("button", { name: "Close browser window" }));
    expect(mocks.minimize).toHaveBeenCalledTimes(1);
    expect(mocks.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(mocks.closeWindow).toHaveBeenCalledTimes(1);
  });
});
