// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./components/Composer";
import {
  composerNoticeExpiry,
  isRuntimeHealthError,
  isRuntimeUpdateRequired,
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
  onSend: vi.fn(async () => true),
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

describe("runtime update notices", () => {
  it("recognizes provider version failures without treating unrelated turn errors as updates", () => {
    expect(
      isRuntimeUpdateRequired(
        "'gpt-5.6-luna' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.",
      ),
    ).toBe(true);
    expect(
      isRuntimeUpdateRequired("Claude CLI is out of date. Update to the latest version."),
    ).toBe(true);
    expect(isRuntimeUpdateRequired("The provider process exited unexpectedly.")).toBe(false);
  });

  it("distinguishes probe-recoverable provider failures from unrelated turn errors", () => {
    expect(isRuntimeHealthError("Codex is not connected for this task")).toBe(true);
    expect(isRuntimeHealthError("Transport closed while reading from Claude")).toBe(true);
    expect(isRuntimeHealthError("This model requires a newer version of Codex.")).toBe(true);
    expect(isRuntimeHealthError("The requested file does not exist")).toBe(false);
  });
});

describe("composer notices", () => {
  it("clears a submitted draft immediately and restores it when sending is rejected", async () => {
    let settle: (accepted: boolean) => void = () => undefined;
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
    );

    render(createElement(Composer, { ...baseComposerProps, onSend }));
    const composer = screen.getByRole("textbox", { name: "Task message" });
    fireEvent.change(composer, { target: { value: "Keep this if startup fails" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(composer).toHaveValue("");
    await act(async () => settle(false));
    expect(composer).toHaveValue("Keep this if startup fails");
  });

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

  it("offers an explicit runtime update action when the caller supplies one", () => {
    const onSelect = vi.fn();
    const notices: ComposerNotice[] = [
      {
        id: "runtime-old",
        title: "Turn error",
        message: "This model requires a newer version of Codex.",
        variant: "error",
        action: { label: "Update codex", onSelect },
      },
    ];

    render(createElement(Composer, { ...baseComposerProps, notices }));
    fireEvent.click(screen.getByRole("button", { name: "Update codex" }));

    expect(onSelect).toHaveBeenCalledOnce();
  });
});
