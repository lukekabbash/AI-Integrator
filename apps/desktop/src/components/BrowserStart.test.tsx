// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { localServers } = vi.hoisted(() => ({
  localServers: vi.fn().mockResolvedValue([
    {
      port: 5173,
      url: "http://localhost:5173",
      process: "vite",
      servesWeb: true,
      title: "vite",
    },
  ]),
}));

vi.mock("../bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge")>();
  return { ...actual, bridge: { ...actual.bridge, browser: { localServers } } };
});

import { toggleBrowserBookmark } from "./browserBookmarks";
import { rememberBrowserVisit } from "./browserRecents";
import { BrowserStart } from "./BrowserStart";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("BrowserStart", () => {
  it("shows recents, bookmarks, and local servers", async () => {
    rememberBrowserVisit("https://linear.app", "Linear");
    toggleBrowserBookmark("https://github.com", "GitHub");
    render(<BrowserStart onOpen={vi.fn()} />);

    expect(screen.getByRole("combobox", { name: /Search or enter a URL/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open GitHub" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Linear" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Open vite on localhost:5173/ })).toBeInTheDocument();
  });

  it("centers the Integrator mark on the home layout", () => {
    render(<BrowserStart layout="home" onOpen={vi.fn()} />);

    expect(screen.getByLabelText("AI Integrator")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /Search Google or enter a URL/ })).toBeInTheDocument();
    expect(document.querySelector(".browser-start-wordmark")).toHaveTextContent("Integrator");
    expect(document.querySelector(".browser-start-glow")).toBeInTheDocument();
  });

  it("offers a ghost tile when there are no bookmarks at home, and a quiet line in compact", () => {
    const { unmount } = render(<BrowserStart layout="home" onOpen={vi.fn()} />);
    expect(screen.getByText("Add a page")).toBeInTheDocument();
    expect(screen.queryByText(/Star a page/)).not.toBeInTheDocument();
    unmount();

    render(<BrowserStart layout="compact" onOpen={vi.fn()} />);
    expect(screen.queryByText("Add a page")).not.toBeInTheDocument();
    expect(screen.getByText(/Star a page/)).toBeInTheDocument();
    // Both layouts carry the lockup; compact just draws it smaller.
    expect(document.querySelector(".browser-start-wordmark")).not.toBeNull();
  });

  it("draws bookmarks as tiles with a hover-only remove control", () => {
    toggleBrowserBookmark("https://github.com", "GitHub");
    render(<BrowserStart layout="home" onOpen={vi.fn()} />);

    const tile = screen.getByRole("button", { name: "Open GitHub" });
    expect(tile.closest(".browser-start-tiles")).not.toBeNull();
    expect(tile.querySelector(".browser-start-tile-mark")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove GitHub" }));
    expect(screen.queryByRole("button", { name: "Open GitHub" })).not.toBeInTheDocument();
  });

  it("hosts the caller's quiet actions inside the page", () => {
    render(
      <BrowserStart onOpen={vi.fn()} actions={<button type="button">Review changes</button>} />,
    );

    const action = screen.getByRole("button", { name: "Review changes" });
    expect(action.closest(".browser-start-actions")).not.toBeNull();
    expect(action.closest(".browser-start")).not.toBeNull();
  });

  it("opens a bookmark", () => {
    const onOpen = vi.fn();
    toggleBrowserBookmark("https://github.com", "GitHub");
    render(<BrowserStart onOpen={onOpen} />);

    fireEvent.click(screen.getByRole("button", { name: "Open GitHub" }));
    expect(onOpen).toHaveBeenCalledWith("https://github.com");
  });
});
