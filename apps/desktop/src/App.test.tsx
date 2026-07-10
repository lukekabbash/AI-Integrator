// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import App from "./App";

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("style");
});

describe("AI Integrator desktop workspace", () => {
  it("renders the agent-first workspace with Git and local usage evidence", async () => {
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "Construct the native v1 workspace" }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("tab", { name: /^Git/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTitle("Subscription plan usage")).toHaveTextContent("34%");
    expect(screen.getByDisplayValue("Build polished native v1 workspace")).toBeInTheDocument();
  });

  it("opens Settings as a full replacement view and applies a theme preset", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Settings" }));
    expect(await screen.findByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(
      screen.queryByRole("complementary", { name: "Project navigation" }),
    ).not.toBeInTheDocument();

    const themeGroup = screen.getByRole("radiogroup", { name: "Theme preset" });
    const ocean = within(themeGroup).getByRole("radio", { name: /Ocean/i });
    fireEvent.click(ocean);
    expect(ocean).toHaveAttribute("aria-checked", "true");
    expect(document.documentElement.dataset.theme).toBe("ocean");

    fireEvent.click(screen.getByRole("button", { name: /Back to workspace/i }));
    expect(
      await screen.findByRole("complementary", { name: "Project navigation" }),
    ).toBeInTheDocument();
  });

  it("opens a syntax-aware review from the Git rail", async () => {
    render(<App />);
    const fileButton = await screen.findByTitle("src/runtime/router.ts");
    fireEvent.click(fileButton);
    expect(
      await screen.findByRole("region", { name: /Diff for src\/runtime\/router\.ts/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("resolveProvider", { selector: ".syntax-function" }),
    ).toBeInTheDocument();
    expect(document.querySelectorAll(".diff-line--add").length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".diff-line--delete").length).toBeGreaterThan(0);
    const commentButton = screen.getAllByRole("button", { name: /Comment on line 43/ })[0];
    commentButton.focus();
    expect(document.activeElement).toBe(commentButton);
  });

  it("sends a composer turn through the typed bridge fallback", async () => {
    render(<App />);
    const composer = await screen.findByRole("textbox", { name: "Task message" });
    fireEvent.change(composer, { target: { value: "Verify recovery after restart" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(screen.getByText("Verify recovery after restart")).toBeInTheDocument(),
    );
    expect(await screen.findByText("Queued for execution")).toBeInTheDocument();
  });

  it("keeps vendor login inside the guided setup flow", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Runtime setup" }));
    expect(await screen.findByRole("heading", { name: /coding agents/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Find my agents/i }));
    expect(
      await screen.findByRole("heading", { name: /Connect what is already here/i }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/Passwords and tokens are never imported into AI Integrator/),
    ).toBeInTheDocument();
  });
});
