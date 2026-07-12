// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./components/Composer";
import {
  composerNoticeExpiry,
  usageResetAtFromMessage,
  type ComposerNotice,
} from "./composerNotices";

const runtimes = [
  {
    id: "codex" as const,
    name: "Codex",
    command: "codex app-server",
    status: "connected" as const,
    fidelity: "native" as const,
    models: ["Provider default"],
    detail: "Test runtime",
  },
];

const baseComposerProps = {
  runtimes,
  defaultRuntime: "codex" as const,
  defaultModel: "Provider default",
  onSend: vi.fn(async () => undefined),
};

afterEach(() => {
  vi.useRealTimers();
});

describe("composer notice expiry", () => {
  it("uses the reset clock from a usage-limit message in the event's local day", () => {
    const occurredAt = "2026-07-11T04:00:00";
    const message = "You've hit your usage limit; try again at 5:03 AM.";

    expect(usageResetAtFromMessage(message, occurredAt)).toBe(
      new Date("2026-07-11T05:03:00").getTime(),
    );
  });

  it("treats an already-passed reset clock as the next day's reset", () => {
    const occurredAt = "2026-07-11T23:00:00";
    const message = "You've hit your usage limit; try again at 5:03 AM.";

    expect(usageResetAtFromMessage(message, occurredAt)).toBe(
      new Date("2026-07-12T05:03:00").getTime(),
    );
  });

  it("falls back to a reported usage reset when the error omits its own clock", () => {
    expect(
      composerNoticeExpiry("You've hit your usage limit.", "2026-07-11T04:00:00", "5:03 AM"),
    ).toBe(new Date("2026-07-11T05:03:00").getTime());
  });
});

describe("composer notices", () => {
  it("renders above the composer and dismisses through the top-right close button", async () => {
    const notices: ComposerNotice[] = [
      {
        id: "unsupported-gemini",
        title: "Turn error",
        message: "gemini turn execution is not implemented by the native backend",
        variant: "error",
      },
    ];

    render(createElement(Composer, { ...baseComposerProps, notices }));
    await act(async () => {
      await Promise.resolve();
    });

    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent("gemini turn execution is not implemented");
    expect(
      notice.compareDocumentPosition(screen.getByRole("textbox")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss Turn error" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("automatically removes a usage-limit notice at its expiry", async () => {
    vi.useFakeTimers();
    const expiresAt = Date.now() + 5_000;
    const notices: ComposerNotice[] = [
      {
        id: "usage-limit",
        title: "Turn error",
        message: "You've hit your usage limit. Try again later.",
        variant: "error",
        expiresAt,
      },
    ];

    render(createElement(Composer, { ...baseComposerProps, notices }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5_001);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
