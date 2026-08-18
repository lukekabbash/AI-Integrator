import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Dropdown, ProviderIcon } from "./Dropdown";

describe("Dropdown", () => {
  it("uses Kimi Code's official provider mark instead of the letter fallback", () => {
    render(<ProviderIcon provider="kimi" label="Kimi Code" />);

    expect(document.querySelector('img[src="/brand/providers/kimi-code.png"]')).toBeInTheDocument();
    expect(document.querySelector(".provider-icon--fallback")).not.toBeInTheDocument();
  });

  it("never stacks a leading glyph and the selected option's icon in the trigger", () => {
    render(
      <Dropdown
        aria-label="Runtime"
        defaultValue="codex"
        leading={<span data-testid="trigger-icon">L</span>}
        options={[
          {
            value: "codex",
            label: "Codex",
            icon: <span data-testid="trigger-icon">O</span>,
          },
        ]}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Runtime" });
    expect(trigger.querySelectorAll("[data-testid='trigger-icon']")).toHaveLength(1);
  });

  it("shows the selected option's icon when no leading glyph is set", () => {
    render(
      <Dropdown
        aria-label="Runtime"
        defaultValue="codex"
        options={[
          {
            value: "codex",
            label: "Codex",
            icon: <span data-testid="trigger-icon">O</span>,
          },
        ]}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Runtime" });
    expect(trigger.querySelectorAll("[data-testid='trigger-icon']")).toHaveLength(1);
  });

  it("opens with a themed menu and commits a selected option", async () => {
    render(
      <Dropdown
        aria-label="Provider"
        defaultValue="codex"
        options={[
          { value: "codex", label: "Codex" },
          { value: "cursor", label: "Cursor" },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Provider" }));
    expect(await screen.findByRole("listbox", { name: "Provider" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "Cursor" }));
    expect(screen.getByRole("button", { name: "Provider" })).toHaveTextContent("Cursor");
    await waitFor(() =>
      expect(screen.queryByRole("listbox", { name: "Provider" })).not.toBeInTheDocument(),
    );
  });

  it("can show a footer and a custom closed label", async () => {
    render(
      <Dropdown
        aria-label="Reasoning effort"
        defaultValue="high"
        triggerLabel="High Fast"
        footer={<div>Fast</div>}
        options={[
          { value: "low", label: "Low" },
          { value: "high", label: "High" },
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: "Reasoning effort" })).toHaveTextContent("High Fast");
    fireEvent.click(screen.getByRole("button", { name: "Reasoning effort" }));
    expect(await screen.findByRole("listbox", { name: "Reasoning effort" })).toBeInTheDocument();
    expect(screen.getByText("Fast")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "Low" }));
    expect(screen.getByRole("button", { name: "Reasoning effort" })).toHaveTextContent("High Fast");
  });

  it("can be directed to open upward", async () => {
    render(
      <Dropdown
        aria-label="Upward runtime"
        placement="up"
        defaultValue="codex"
        options={[{ value: "codex", label: "Codex" }]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Upward runtime" }));
    expect(
      (await screen.findByRole("listbox", { name: "Upward runtime" })).closest(".dropdown-menu"),
    ).toHaveClass("dropdown-menu--up");
  });
});
