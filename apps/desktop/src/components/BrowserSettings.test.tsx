// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { browserMock } = vi.hoisted(() => ({
  browserMock: {
    identityOverview: vi.fn(),
    savedLogins: vi.fn(),
    bucketSites: vi.fn(),
    clearBucket: vi.fn(),
    setIdentityScope: vi.fn(),
    forgetLogin: vi.fn(),
    forgetBucketLogins: vi.fn(),
  },
}));

vi.mock("../bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge")>();
  return { ...actual, bridge: { ...actual.bridge, browser: browserMock } };
});

import type { BrowserIdentityOverview } from "../bridge";
import { BROWSER_SETTINGS, BrowserSettings } from "./BrowserSettings";

const overview: BrowserIdentityOverview = {
  activeScope: "task",
  configuredScope: "task",
  restartRequired: false,
  buckets: [
    {
      id: "task:task-1",
      label: "Build API",
      kind: "task",
      taskId: "task-1",
      archived: false,
      updatedAt: "2026-08-17T12:00:00Z",
      profilePresent: true,
      savedLogins: 1,
      active: true,
    },
    {
      id: "chat-main",
      label: "Chat/Main Browser",
      kind: "chat",
      archived: false,
      updatedAt: "2026-08-17T11:00:00Z",
      profilePresent: false,
      savedLogins: 0,
      active: true,
    },
    {
      id: "shared",
      label: "Shared Browser",
      kind: "shared",
      archived: false,
      updatedAt: "",
      profilePresent: false,
      savedLogins: 0,
      active: false,
    },
  ],
};

afterEach(() => {
  window.localStorage.clear();
});

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  browserMock.identityOverview.mockResolvedValue(overview);
  browserMock.savedLogins.mockResolvedValue([
    {
      bucketId: "task:task-1",
      origin: "https://example.com",
      username: "ana",
      savedAt: "2026-08-17T10:00:00Z",
    },
  ]);
  browserMock.bucketSites.mockResolvedValue([
    { origin: "example.com", cookies: 2, persistent: true },
  ]);
  browserMock.clearBucket.mockResolvedValue(undefined);
  browserMock.forgetLogin.mockResolvedValue([]);
  browserMock.forgetBucketLogins.mockResolvedValue([]);
  browserMock.setIdentityScope.mockResolvedValue({
    activeScope: "task",
    configuredScope: "task",
    restartRequired: false,
    mergedCookies: 0,
    cookieConflicts: 0,
    skippedPartitionedCookies: 0,
    mergedLogins: 0,
    loginConflicts: 0,
    sourcesRetained: true,
  });
});

describe("BrowserSettings", () => {
  it("writes the search engine to settings and local storage", () => {
    const setSetting = vi.fn();
    render(<BrowserSettings settings={{}} setSetting={setSetting} />);
    fireEvent.click(screen.getByRole("button", { name: "Search engine" }));
    fireEvent.click(screen.getByRole("option", { name: "DuckDuckGo" }));
    expect(setSetting).toHaveBeenCalledWith(BROWSER_SETTINGS.searchEngine, "ddg");
    expect(window.localStorage.getItem("aiintegrator.browser-search-engine.v1")).toBe("ddg");
  });

  it("keeps the active-tab agent lock off until the user enables it", () => {
    const setSetting = vi.fn();
    const view = render(<BrowserSettings settings={{}} setSetting={setSetting} />);
    const toggle = screen.getByRole("switch", {
      name: "Lock agents out of the tab you are using",
    });

    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/lets them keep working in that same tab alongside you/)).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(setSetting).toHaveBeenCalledWith(BROWSER_SETTINGS.lockActiveTab, true);

    view.rerender(
      <BrowserSettings
        settings={{ [BROWSER_SETTINGS.lockActiveTab]: true }}
        setSetting={setSetting}
      />,
    );
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("keeps external browser handoff off until the user enables it", () => {
    const setSetting = vi.fn();
    const view = render(<BrowserSettings settings={{}} setSetting={setSetting} />);
    const toggle = screen.getByRole("switch", {
      name: "Allow opening tabs in an external browser",
    });

    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/Off keeps every browser handoff inside Integrator/)).toBeInTheDocument();
    expect(
      screen.getByText(/tells agents to use only Integrator browser tools/),
    ).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(setSetting).toHaveBeenCalledWith(BROWSER_SETTINGS.externalOpen, true);

    view.rerender(
      <BrowserSettings
        settings={{ [BROWSER_SETTINGS.externalOpen]: true }}
        setSetting={setSetting}
      />,
    );
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("groups metadata by task, then Chat/Main Browser, and loads cookies lazily", async () => {
    render(<BrowserSettings settings={{}} setSetting={vi.fn()} />);

    const task = await screen.findByRole("button", { name: /Build API/ });
    const chat = screen.getByRole("button", { name: /Chat\/Main Browser/ });
    expect(task.compareDocumentPosition(chat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(browserMock.bucketSites).not.toHaveBeenCalled();

    fireEvent.click(task);
    await waitFor(() => expect(browserMock.bucketSites).toHaveBeenCalledWith("task:task-1"));
    expect(await screen.findByText("example.com")).toBeInTheDocument();
    expect(screen.getByText("ana · never used")).toBeInTheDocument();
  });

  it("cancels the Shared merge without changing anything", async () => {
    render(<BrowserSettings settings={{}} setSetting={vi.fn()} />);
    await screen.findByRole("button", { name: /Build API/ });

    fireEvent.click(screen.getByRole("radio", { name: /^Shared/ }));
    const dialog = await screen.findByRole("dialog", {
      name: "Switch to one Shared browser identity?",
    });
    expect(within(dialog).getByText(/most recently active task wins/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/sign-in errors/i)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(browserMock.setIdentityScope).not.toHaveBeenCalled();
  });

  it("merges into Shared only after confirmation and reports restart", async () => {
    const sharedOverview = {
      ...overview,
      configuredScope: "shared" as const,
      restartRequired: true,
    };
    browserMock.setIdentityScope.mockImplementation(async () => {
      browserMock.identityOverview.mockResolvedValue(sharedOverview);
      return {
        activeScope: "task" as const,
        configuredScope: "shared" as const,
        restartRequired: true,
        mergedCookies: 3,
        cookieConflicts: 1,
        skippedPartitionedCookies: 0,
        mergedLogins: 1,
        loginConflicts: 0,
        sourcesRetained: true,
      };
    });
    const onIdentityScopeChanged = vi.fn();
    render(
      <BrowserSettings
        settings={{}}
        setSetting={vi.fn()}
        onIdentityScopeChanged={onIdentityScopeChanged}
      />,
    );
    await screen.findByRole("button", { name: /Build API/ });

    fireEvent.click(screen.getByRole("radio", { name: /^Shared/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Merge and use Shared" }));

    await waitFor(() => expect(browserMock.setIdentityScope).toHaveBeenCalledWith("shared"));
    expect(onIdentityScopeChanged).toHaveBeenCalledWith("shared");
    expect(
      await screen.findByText(/Shared browser prepared: 4 entries merged/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Restart Integrator to apply Shared/)).toBeInTheDocument();
  });

  it("keeps the warning open when a merge fails", async () => {
    browserMock.setIdentityScope.mockRejectedValue(new Error("Shared rollback completed"));
    render(<BrowserSettings settings={{}} setSetting={vi.fn()} />);
    await screen.findByRole("button", { name: /Build API/ });

    fireEvent.click(screen.getByRole("radio", { name: /^Shared/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Merge and use Shared" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Shared rollback completed");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
