import "@testing-library/jest-dom/vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import type { BrowserBridge, BrowserTab } from "./bridge";
import {
  browserRequestBelongsToTask,
  useBrowserTabs,
  type BrowserController,
  type BrowserHost,
} from "./useBrowserTabs";

const mocks = vi.hoisted(() => ({
  subscribeListener: undefined as (() => void) | undefined,
  openExternalLink: vi.fn(),
  browser: {
    list: vi.fn(),
    restore: vi.fn(),
    subscribe: vi.fn(),
    invoke: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
    setBounds: vi.fn(),
    navigate: vi.fn(),
    history: vi.fn(),
    screenshot: vi.fn(),
    setPoppedOut: vi.fn(),
    saveLogin: vi.fn(),
    fillLogin: vi.fn(),
  },
}));

vi.mock("./bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bridge")>();
  return {
    ...actual,
    bridge: { ...actual.bridge, browser: mocks.browser as unknown as BrowserBridge },
    openExternalLink: mocks.openExternalLink,
  };
});

function tab(taskId: string, id: string): BrowserTab {
  return {
    id,
    taskId,
    groupId: "project:test",
    groupName: "Test project",
    groupKind: "project",
    url: `https://example.com/${id}`,
    title: id,
    loading: false,
    poppedOut: false,
    hidden: true,
    sleeping: false,
  };
}

function Probe({
  taskId,
  onController,
  host = { attachImage: async () => undefined, insertText: () => undefined },
}: {
  taskId: string;
  onController?: (controller: BrowserController) => void;
  host?: BrowserHost;
}) {
  const controller = useBrowserTabs(host, { taskId });
  useEffect(() => onController?.(controller), [controller, onController]);
  return (
    <div>
      {controller.tabs.map((entry) => (
        <span key={entry.id}>{entry.id}</span>
      ))}
    </div>
  );
}

describe("useBrowserTabs task isolation", () => {
  it("rejects focus and sign-in events from another task", () => {
    const tabs = [tab("task-a", "tab-a")];
    expect(browserRequestBelongsToTask("task-a", tabs, { taskId: "task-b", tabId: "tab-a" })).toBe(
      false,
    );
    expect(browserRequestBelongsToTask("task-a", tabs, { taskId: "task-a", tabId: "tab-b" })).toBe(
      false,
    );
    expect(browserRequestBelongsToTask("task-a", tabs, { taskId: "task-a", tabId: "tab-a" })).toBe(
      true,
    );
  });

  it("never renders the previous task's tabs while a new task is loading", async () => {
    const taskA = [tab("task-a", "tab-a")];
    const taskB = [tab("task-b", "tab-b")];
    mocks.browser.restore.mockImplementation(async (taskId: string) =>
      taskId === "task-a" ? taskA : taskB,
    );
    mocks.browser.list.mockImplementation(async (taskId: string) =>
      taskId === "task-a" ? taskA : taskB,
    );
    mocks.browser.subscribe.mockImplementation(async (listener: () => void) => {
      mocks.subscribeListener = listener;
      return () => undefined;
    });
    mocks.browser.invoke.mockResolvedValue(null);

    const view = render(<Probe taskId="task-a" />);
    expect(await screen.findByText("tab-a")).toBeInTheDocument();

    view.rerender(<Probe taskId="task-b" />);
    expect(screen.queryByText("tab-a")).not.toBeInTheDocument();
    expect(await screen.findByText("tab-b")).toBeInTheDocument();
    expect(mocks.browser.list).not.toHaveBeenCalledWith(undefined);
  });

  it("binds renderer commands to the controller's task and keeps external handoff off", async () => {
    const taskTabs = [tab("task-a", "tab-a")];
    mocks.browser.restore.mockResolvedValue(taskTabs);
    mocks.browser.list.mockResolvedValue(taskTabs);
    mocks.browser.subscribe.mockResolvedValue(() => undefined);
    mocks.browser.invoke.mockResolvedValue(null);
    mocks.browser.close.mockResolvedValue(true);
    let controller: BrowserController | undefined;

    render(
      <Probe
        taskId="task-a"
        onController={(next) => {
          controller = next;
        }}
      />,
    );
    await screen.findByText("tab-a");
    await waitFor(() => expect(controller?.ready).toBe(true));
    await controller?.close("tab-a");
    await controller?.openExternally("tab-a");

    expect(mocks.browser.close).toHaveBeenCalledWith("task-a", "tab-a");
    expect(mocks.openExternalLink).not.toHaveBeenCalled();
  });

  it("stops recording and annotation timers when their task leaves the renderer", async () => {
    const taskA = [tab("task-a", "tab-a")];
    const taskB = [tab("task-b", "tab-b")];
    mocks.browser.restore.mockImplementation(async (taskId: string) =>
      taskId === "task-a" ? taskA : taskB,
    );
    mocks.browser.list.mockImplementation(async (taskId: string) =>
      taskId === "task-a" ? taskA : taskB,
    );
    mocks.browser.subscribe.mockResolvedValue(() => undefined);
    mocks.browser.invoke.mockResolvedValue(null);
    mocks.browser.screenshot.mockResolvedValue("");
    const interval = vi.spyOn(window, "setInterval");
    const clearInterval = vi.spyOn(window, "clearInterval");
    let controller: BrowserController | undefined;

    try {
      const view = render(
        <Probe
          taskId="task-a"
          onController={(next) => {
            controller = next;
          }}
        />,
      );
      await screen.findByText("tab-a");
      await act(async () => {
        await controller?.toggleRecording("tab-a");
        await controller?.toggleAnnotate("tab-a");
      });
      await waitFor(() => expect(controller?.recordingTabId).toBe("tab-a"));
      expect(controller?.annotatingTabId).toBe("tab-a");
      const captureTimers = interval.mock.calls
        .map((call, index) => ({ delay: call[1], timer: interval.mock.results[index]?.value }))
        .filter(({ delay }) => delay === 700 || delay === 250)
        .map(({ timer }) => timer);
      expect(captureTimers).toHaveLength(2);

      view.rerender(
        <Probe
          taskId="task-b"
          onController={(next) => {
            controller = next;
          }}
        />,
      );
      expect(screen.queryByText("tab-a")).not.toBeInTheDocument();
      expect(await screen.findByText("tab-b")).toBeInTheDocument();
      await waitFor(() => {
        for (const timer of captureTimers) expect(clearInterval).toHaveBeenCalledWith(timer);
      });
      expect(mocks.browser.invoke).toHaveBeenCalledWith("task-a", "tab-a", "cancelPick");
      expect(controller?.recordingTabId).toBeNull();
      expect(controller?.annotatingTabId).toBeNull();
    } finally {
      interval.mockRestore();
      clearInterval.mockRestore();
    }
  });

  it("turns a picked element into an annotation crop and block for the composer", async () => {
    const taskTabs = [tab("task-a", "tab-a")];
    mocks.browser.restore.mockResolvedValue(taskTabs);
    mocks.browser.list.mockResolvedValue(taskTabs);
    mocks.browser.subscribe.mockResolvedValue(() => undefined);
    mocks.browser.screenshot.mockResolvedValue("iVBORw0KGgo=");
    let attached = false;
    mocks.browser.invoke.mockClear();
    mocks.browser.invoke.mockImplementation(async (_task: string, _tab: string, method: string) => {
      if (method !== "pickResult") return null;
      if (!attached) return { picking: true, picked: null, comment: "", cancelled: false };
      attached = false;
      return {
        picking: false,
        picked: { ref: "e1", tag: "button", role: "button", name: "Sign in", selector: "#signin" },
        comment: "",
        cancelled: false,
      };
    });
    const images: string[] = [];
    const inserted: string[] = [];
    const host: BrowserHost = {
      attachImage: async (_file, name) => {
        images.push(name);
      },
      insertText: (text) => {
        inserted.push(text);
      },
    };
    let controller: BrowserController | undefined;
    render(
      <Probe
        taskId="task-a"
        host={host}
        onController={(next) => {
          controller = next;
        }}
      />,
    );
    await screen.findByText("tab-a");
    await act(async () => {
      await controller?.toggleAnnotate("tab-a");
    });
    await waitFor(() => expect(controller?.annotatingTabId).toBe("tab-a"));
    attached = true;
    await waitFor(() => expect(inserted).toHaveLength(1), { timeout: 3000 });
    await waitFor(() => expect(images).toEqual(["Annotation · Sign in.png"]));
    expect(inserted[0]).toContain("<browser_annotation>");
    expect(inserted[0]).toContain('name="Sign in"');
    // The picker re-arms for the next element instead of dropping the mode.
    await waitFor(() =>
      expect(
        mocks.browser.invoke.mock.calls
          .map((call) => call[2])
          .filter((method) => method !== "pickResult" && method !== "setTheme"),
      ).toEqual(["startPick", "annotate", "clearAnnotations", "startPick"]),
    );
    await waitFor(() => expect(controller?.annotatingTabId).toBe("tab-a"));
    // A second pick lands as a second chip.
    attached = true;
    await waitFor(() => expect(inserted).toHaveLength(2), { timeout: 3000 });
    // Toggling the toolbar button ends the session.
    await act(async () => {
      await controller?.toggleAnnotate("tab-a");
    });
    expect(controller?.annotatingTabId).toBeNull();
    expect(mocks.browser.invoke).toHaveBeenCalledWith("task-a", "tab-a", "cancelPick");
  });

  it("labels a delayed capture with the task that requested it", async () => {
    const taskA = [tab("task-a", "tab-a")];
    const taskB = [tab("task-b", "tab-b")];
    mocks.browser.restore.mockImplementation(async (taskId: string) =>
      taskId === "task-a" ? taskA : taskB,
    );
    mocks.browser.list.mockImplementation(async (taskId: string) =>
      taskId === "task-a" ? taskA : taskB,
    );
    mocks.browser.subscribe.mockResolvedValue(() => undefined);
    mocks.browser.invoke.mockResolvedValue(null);
    let finishScreenshot: ((image: string) => void) | undefined;
    mocks.browser.screenshot.mockReturnValue(
      new Promise<string>((resolve) => {
        finishScreenshot = resolve;
      }),
    );
    let activeTask = "task-a";
    const acceptedAttachments: string[] = [];
    const host: BrowserHost = {
      attachImage: async (_file, _name, ownerTaskId) => {
        if (ownerTaskId === activeTask) acceptedAttachments.push(ownerTaskId);
      },
      insertText: () => undefined,
    };
    let controller: BrowserController | undefined;
    const view = render(
      <Probe
        taskId="task-a"
        host={host}
        onController={(next) => {
          controller = next;
        }}
      />,
    );
    await screen.findByText("tab-a");
    const capture = controller?.screenshot("tab-a");

    activeTask = "task-b";
    view.rerender(
      <Probe
        taskId="task-b"
        host={host}
        onController={(next) => {
          controller = next;
        }}
      />,
    );
    await screen.findByText("tab-b");
    finishScreenshot?.("");
    await capture;

    expect(acceptedAttachments).toEqual([]);
    expect(controller?.message).toBeNull();
  });

  it("ignores an old recording frame after the next task starts recording", async () => {
    const taskA = [tab("task-a", "tab-a")];
    const taskB = [tab("task-b", "tab-b")];
    mocks.browser.restore.mockImplementation(async (taskId: string) =>
      taskId === "task-a" ? taskA : taskB,
    );
    mocks.browser.list.mockImplementation(async (taskId: string) =>
      taskId === "task-a" ? taskA : taskB,
    );
    mocks.browser.subscribe.mockResolvedValue(() => undefined);
    mocks.browser.invoke.mockResolvedValue(null);
    let finishOldFrame: ((image: string) => void) | undefined;
    mocks.browser.screenshot.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        finishOldFrame = resolve;
      }),
    );
    const recordingTicks: Array<() => void> = [];
    const nativeSetInterval = window.setInterval.bind(window);
    const interval = vi
      .spyOn(window, "setInterval")
      .mockImplementation((handler, delay, ...args) => {
        if (delay === 700) {
          recordingTicks.push(handler as () => void);
          return (100 + recordingTicks.length) as unknown as ReturnType<typeof setInterval>;
        }
        return nativeSetInterval(handler, delay, ...args) as unknown as ReturnType<
          typeof setInterval
        >;
      });
    let controller: BrowserController | undefined;

    try {
      const view = render(
        <Probe
          taskId="task-a"
          onController={(next) => {
            controller = next;
          }}
        />,
      );
      await screen.findByText("tab-a");
      await act(async () => controller?.toggleRecording("tab-a"));
      recordingTicks[0]?.();

      view.rerender(
        <Probe
          taskId="task-b"
          onController={(next) => {
            controller = next;
          }}
        />,
      );
      await screen.findByText("tab-b");
      await act(async () => controller?.toggleRecording("tab-b"));
      await waitFor(() => expect(controller?.recordingTabId).toBe("tab-b"));

      await act(async () => {
        finishOldFrame?.("");
        await Promise.resolve();
      });
      expect(controller?.recordingTabId).toBe("tab-b");
    } finally {
      interval.mockRestore();
    }
  });
});
