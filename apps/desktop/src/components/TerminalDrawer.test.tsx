// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSummary, TerminalOutputEvent } from "../bridge";

const terminalMock = vi.hoisted(() => {
  const instances: FakeTerminal[] = [];

  class FakeTerminal {
    cols = 80;
    rows = 24;
    options = { disableStdin: false };
    writes: string[] = [];
    dataListener: ((data: string) => void) | undefined;

    constructor() {
      instances.push(this);
    }

    loadAddon = vi.fn();
    open = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    write = (data: string) => this.writes.push(data);
    onData = (listener: (data: string) => void) => {
      this.dataListener = listener;
      return { dispose: vi.fn() };
    };
    emitData = (data: string) => this.dataListener?.(data);
  }

  class FakeFitAddon {
    fit = vi.fn();
  }

  return {
    FakeTerminal,
    FakeFitAddon,
    instances,
    openTerminal: vi.fn(),
    writeTerminal: vi.fn(),
    resizeTerminal: vi.fn(),
    interruptTerminal: vi.fn(),
    terminalHasForegroundProcess: vi.fn(),
    closeTerminal: vi.fn(),
    subscribeTerminalOutput: vi.fn(),
  };
});

vi.mock("@xterm/xterm", () => ({ Terminal: terminalMock.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: terminalMock.FakeFitAddon }));
vi.mock("../bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge")>();
  return {
    ...actual,
    bridge: {
      ...actual.bridge,
      openTerminal: terminalMock.openTerminal,
      writeTerminal: terminalMock.writeTerminal,
      resizeTerminal: terminalMock.resizeTerminal,
      interruptTerminal: terminalMock.interruptTerminal,
      terminalHasForegroundProcess: terminalMock.terminalHasForegroundProcess,
      closeTerminal: terminalMock.closeTerminal,
      subscribeTerminalOutput: terminalMock.subscribeTerminalOutput,
    },
  };
});

import { TerminalDrawer } from "./TerminalDrawer";

const project: ProjectSummary = {
  id: "integrator",
  name: "AI Integrator",
  path: "/workspace/integrator-3",
  branch: "main",
  dirtyFiles: 0,
  expanded: true,
};

let outputListener: ((event: TerminalOutputEvent) => void) | undefined;
let outputListeners: Array<(event: TerminalOutputEvent) => void> = [];
let sessionOrdinal = 0;

describe("TerminalDrawer", () => {
  beforeEach(() => {
    terminalMock.instances.length = 0;
    outputListener = undefined;
    outputListeners = [];
    sessionOrdinal = 0;
    terminalMock.openTerminal.mockReset().mockImplementation(async () => {
      sessionOrdinal += 1;
      return {
        id: `term-${sessionOrdinal}`,
        cwd: project.path,
        shell: "PowerShell",
      };
    });
    terminalMock.writeTerminal.mockReset().mockResolvedValue(undefined);
    terminalMock.resizeTerminal.mockReset().mockResolvedValue(undefined);
    terminalMock.interruptTerminal.mockReset().mockResolvedValue(undefined);
    terminalMock.terminalHasForegroundProcess.mockReset().mockResolvedValue(false);
    terminalMock.closeTerminal.mockReset().mockResolvedValue(undefined);
    terminalMock.subscribeTerminalOutput
      .mockReset()
      .mockImplementation(async (listener: (event: TerminalOutputEvent) => void) => {
        outputListeners.push(listener);
        outputListener ??= listener;
        return vi.fn();
      });
  });

  afterEach(() => vi.restoreAllMocks());

  it("opens one real terminal session and forwards PTY input/output", async () => {
    render(<TerminalDrawer open project={project} onClose={() => undefined} />);

    await waitFor(() =>
      expect(terminalMock.openTerminal).toHaveBeenCalledWith("integrator", {
        cols: 80,
        rows: 24,
      }),
    );
    const terminal = terminalMock.instances[0];
    terminal.emitData("codex\n");
    expect(terminalMock.writeTerminal).toHaveBeenCalledWith("term-1", "codex\n");

    act(() => {
      outputListener?.({
        sessionId: "term-1",
        stream: "output",
        data: "\u001b[32mready\u001b[0m\r\n",
      });
    });
    expect(terminal.writes).toContain("\u001b[32mready\u001b[0m\r\n");
  });

  it("keeps the same session when the full-width surface is hidden and shown", async () => {
    const view = render(<TerminalDrawer open project={project} onClose={() => undefined} />);
    await waitFor(() => expect(terminalMock.openTerminal).toHaveBeenCalledTimes(1));

    view.rerender(<TerminalDrawer open={false} project={project} onClose={() => undefined} />);
    view.rerender(<TerminalDrawer open project={project} onClose={() => undefined} />);

    expect(terminalMock.openTerminal).toHaveBeenCalledTimes(1);
    expect(terminalMock.closeTerminal).not.toHaveBeenCalled();
  });

  it("creates, switches, and closes independent terminal sessions", async () => {
    render(<TerminalDrawer open project={project} onClose={() => undefined} />);
    await waitFor(() => expect(terminalMock.openTerminal).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    await waitFor(() => expect(terminalMock.openTerminal).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Terminal 2", { selector: ".terminal-title strong" })).toBeVisible();

    terminalMock.instances[1].emitData("pwd\r");
    expect(terminalMock.writeTerminal).toHaveBeenCalledWith("term-2", "pwd\r");

    act(() => {
      for (const listener of outputListeners) {
        listener({ sessionId: "term-2", stream: "output", data: "second terminal\r\n" });
      }
    });
    expect(terminalMock.instances[1].writes).toContain("second terminal\r\n");
    expect(terminalMock.instances[0].writes).not.toContain("second terminal\r\n");

    fireEvent.click(screen.getByTitle("Terminal 1"));
    expect(screen.getByText("Terminal 1", { selector: ".terminal-title strong" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Close Terminal 2" }));
    await waitFor(() => expect(terminalMock.closeTerminal).toHaveBeenCalledWith("term-2"));
    expect(screen.queryByTitle("Terminal 2")).not.toBeInTheDocument();
  });

  it("collapses the terminal list without removing its sessions or new-terminal action", async () => {
    render(<TerminalDrawer open project={project} onClose={() => undefined} />);
    await waitFor(() => expect(terminalMock.openTerminal).toHaveBeenCalled());
    const rail = screen.getByRole("complementary", { name: "Terminal sessions" });

    fireEvent.click(screen.getByRole("button", { name: "Collapse terminal list" }));

    expect(rail).toHaveAttribute("data-collapsed", "true");
    expect(screen.getByRole("button", { name: "Expand terminal list" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New terminal" })).toBeInTheDocument();
    expect(terminalMock.closeTerminal).not.toHaveBeenCalled();
  });

  it("resizes the panel from its accessible top-edge separator", async () => {
    render(<TerminalDrawer open project={project} onClose={() => undefined} />);
    const handle = screen.getByRole("separator", { name: "Resize terminal panel" });
    expect(handle).toHaveAttribute("aria-valuenow", "300");

    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(handle).toHaveAttribute("aria-valuenow", "324");

    fireEvent.keyDown(handle, { key: "Home" });
    expect(handle).toHaveAttribute("aria-valuenow", "180");

    fireEvent.doubleClick(handle);
    expect(handle).toHaveAttribute("aria-valuenow", "300");

    fireEvent.pointerDown(handle, { pointerId: 7, clientY: 500 });
    fireEvent.pointerMove(handle, { pointerId: 7, clientY: 400 });
    expect(handle).toHaveAttribute("aria-valuenow", "400");
    fireEvent.pointerUp(handle, { pointerId: 7, clientY: 400 });
  });

  it("ignores output for another session", async () => {
    render(<TerminalDrawer open project={project} onClose={() => undefined} />);
    await waitFor(() => expect(terminalMock.openTerminal).toHaveBeenCalled());
    const terminal = terminalMock.instances[0];

    act(() => {
      outputListener?.({
        sessionId: "another-terminal",
        stream: "output",
        data: "foreign output",
      });
    });

    expect(terminal.writes).not.toContain("foreign output");
  });

  it("explains native-only availability in the browser preview", async () => {
    terminalMock.openTerminal.mockRejectedValue(
      new Error("The terminal is available in the native desktop app."),
    );
    render(<TerminalDrawer open project={project} onClose={() => undefined} />);

    expect(
      await screen.findByText("The terminal is available in the native desktop app."),
    ).toHaveAttribute("role", "alert");
  });

  it("surfaces a disconnected PTY write and offers a clean restart", async () => {
    terminalMock.writeTerminal.mockRejectedValueOnce({
      code: "not-found",
      message: "unknown terminal session",
    });
    render(<TerminalDrawer open project={project} onClose={() => undefined} />);
    await waitFor(() => expect(terminalMock.openTerminal).toHaveBeenCalledTimes(1));

    terminalMock.instances[0].emitData("pwd\r");

    expect(
      await screen.findByText("The terminal session disconnected. Restart it to continue."),
    ).toHaveAttribute("role", "alert");
    expect(terminalMock.instances[0].options.disableStdin).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(terminalMock.openTerminal).toHaveBeenCalledTimes(2));
    expect(terminalMock.closeTerminal).toHaveBeenCalledWith("term-1");
  });

  it("hides the stop button while the terminal sits at an idle prompt", async () => {
    render(<TerminalDrawer open project={project} onClose={() => undefined} />);
    await waitFor(() => expect(terminalMock.openTerminal).toHaveBeenCalled());

    await waitFor(() =>
      expect(terminalMock.terminalHasForegroundProcess).toHaveBeenCalledWith("term-1"),
    );
    expect(screen.queryByRole("button", { name: "Interrupt Terminal 1" })).not.toBeInTheDocument();
  });

  it("shows the stop button while a foreground process runs and interrupts it", async () => {
    terminalMock.terminalHasForegroundProcess.mockResolvedValue(true);
    render(<TerminalDrawer open project={project} onClose={() => undefined} />);
    await waitFor(() => expect(terminalMock.openTerminal).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole("button", { name: "Interrupt Terminal 1" }));
    expect(terminalMock.interruptTerminal).toHaveBeenCalledWith("term-1");
  });

  it("updates xterm colors when the app theme changes", async () => {
    const view = render(<TerminalDrawer open project={project} onClose={() => undefined} />);
    await waitFor(() => expect(terminalMock.openTerminal).toHaveBeenCalled());

    document.documentElement.style.setProperty("--color-terminal-surface", "rgb(1, 2, 3)");

    await waitFor(() =>
      expect(terminalMock.instances[0].options).toMatchObject({
        theme: { background: "rgb(1, 2, 3)" },
      }),
    );
    view.unmount();
    document.documentElement.style.removeProperty("--color-terminal-surface");
  });
});
