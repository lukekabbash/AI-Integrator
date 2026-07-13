// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSummary, TerminalOutputEvent } from "../bridge";

const { terminalMock } = vi.hoisted(() => ({
  terminalMock: {
    openTerminal: vi.fn(),
    runTerminalCommand: vi.fn(),
    interruptTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    subscribeTerminalOutput: vi.fn(),
  },
}));

vi.mock("../bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge")>();
  return { ...actual, bridge: { ...actual.bridge, ...terminalMock } };
});

import { TerminalDrawer } from "./TerminalDrawer";

const project: ProjectSummary = {
  id: "integrator",
  name: "AI Integrator",
  path: "H:\\Code\\integrator-3",
  branch: "main",
  dirtyFiles: 0,
  expanded: true,
};

let outputListener: ((event: TerminalOutputEvent) => void) | undefined;

describe("TerminalDrawer", () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    for (const mock of Object.values(terminalMock)) mock.mockReset();
    outputListener = undefined;
    terminalMock.openTerminal.mockResolvedValue({
      id: "term-1",
      cwd: "H:\\Code\\integrator-3",
      shell: "PowerShell",
    });
    terminalMock.subscribeTerminalOutput.mockImplementation(async (listener) => {
      outputListener = listener;
      return vi.fn();
    });
    terminalMock.runTerminalCommand.mockResolvedValue({
      runId: "run-1",
      cwd: "H:\\Code\\integrator-3",
    });
    terminalMock.closeTerminal.mockResolvedValue(undefined);
    terminalMock.interruptTerminal.mockResolvedValue(undefined);
  });

  it("opens a project session, streams command output, and reports the exit", async () => {
    render(<TerminalDrawer open project={project} onClose={() => undefined} />);

    await waitFor(() => expect(terminalMock.openTerminal).toHaveBeenCalledWith("integrator"));
    const input = await screen.findByRole("textbox", { name: "Terminal command" });
    fireEvent.change(input, { target: { value: "npm test" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(terminalMock.runTerminalCommand).toHaveBeenCalledWith("term-1", "npm test"),
    );
    expect(await screen.findByText(/npm test/)).toBeInTheDocument();

    act(() => {
      outputListener?.({
        sessionId: "term-1",
        runId: "run-1",
        stream: "stdout",
        line: "1 passed",
        cwd: "H:\\Code\\integrator-3",
      });
    });
    expect(await screen.findByText("1 passed")).toBeInTheDocument();

    act(() => {
      outputListener?.({
        sessionId: "term-1",
        runId: "run-1",
        stream: "exit",
        exitCode: 2,
        cwd: "H:\\Code\\integrator-3",
      });
    });
    expect(await screen.findByText("Exited with code 2")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Terminal command" })).not.toBeDisabled();
  });

  it("ignores output that belongs to another session", async () => {
    render(<TerminalDrawer open project={project} onClose={() => undefined} />);
    await screen.findByRole("textbox", { name: "Terminal command" });

    outputListener?.({
      sessionId: "another-terminal",
      runId: "run-9",
      stream: "stdout",
      line: "foreign output",
      cwd: "C:\\Elsewhere",
    });
    expect(screen.queryByText("foreign output")).not.toBeInTheDocument();
  });

  it("explains itself in the browser preview instead of pretending to run", async () => {
    terminalMock.openTerminal.mockRejectedValue(
      new Error("The terminal is available in the native desktop app."),
    );
    render(<TerminalDrawer open project={project} onClose={() => undefined} />);
    expect(
      await screen.findByText("The terminal is available in the native desktop app."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Terminal command" })).not.toBeInTheDocument();
  });

  it("batches burst output into one frame and progressively exposes full scrollback", async () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    render(<TerminalDrawer open project={project} onClose={() => undefined} />);
    await screen.findByRole("textbox", { name: "Terminal command" });

    act(() => {
      for (let index = 0; index < 1_000; index += 1) {
        outputListener?.({
          sessionId: "term-1",
          runId: "run-1",
          stream: "stdout",
          line: `burst-line-${index}`,
          cwd: project.path,
        });
      }
    });
    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("burst-line-999")).not.toBeInTheDocument();

    act(() => frames.shift()?.(performance.now()));
    const log = screen.getByRole("log");
    expect(log.querySelectorAll("p")).toHaveLength(400);
    expect(screen.getByText("Showing 400 of 1,000 saved lines")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show all 1,000 saved lines" }));
    expect(log.querySelectorAll("p")).toHaveLength(1_000);
    expect(screen.getByText("burst-line-999")).toBeInTheDocument();
  });

  it("freezes visible output when scrolled away and exposes queued latest lines", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    render(<TerminalDrawer open project={project} onClose={() => undefined} />);
    await screen.findByRole("textbox", { name: "Terminal command" });

    act(() => {
      for (let index = 0; index < 500; index += 1) {
        outputListener?.({
          sessionId: "term-1",
          runId: "run-1",
          stream: "stdout",
          line: `anchored-line-${index}`,
          cwd: project.path,
        });
      }
      frames.shift()?.(performance.now());
    });
    const log = screen.getByRole("log");
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 1_000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 100 });
    log.scrollTop = 0;
    fireEvent.scroll(log);

    act(() => {
      for (let index = 500; index < 510; index += 1) {
        outputListener?.({
          sessionId: "term-1",
          runId: "run-1",
          stream: "stdout",
          line: `anchored-line-${index}`,
          cwd: project.path,
        });
      }
      frames.shift()?.(performance.now());
    });

    expect(
      screen.getByRole("button", { name: "10 new lines · Jump to latest" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("anchored-line-509")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "10 new lines · Jump to latest" }));
    expect(screen.getByText("anchored-line-509")).toBeInTheDocument();
  });
});
