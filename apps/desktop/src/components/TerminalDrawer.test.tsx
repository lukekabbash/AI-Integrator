// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    expect(screen.getByText(/npm test/)).toBeInTheDocument();

    outputListener?.({
      sessionId: "term-1",
      runId: "run-1",
      stream: "stdout",
      line: "1 passed",
      cwd: "H:\\Code\\integrator-3",
    });
    expect(await screen.findByText("1 passed")).toBeInTheDocument();

    outputListener?.({
      sessionId: "term-1",
      runId: "run-1",
      stream: "exit",
      exitCode: 2,
      cwd: "H:\\Code\\integrator-3",
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
    expect(
      screen.queryByRole("textbox", { name: "Terminal command" }),
    ).not.toBeInTheDocument();
  });
});
