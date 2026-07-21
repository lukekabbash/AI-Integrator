import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { chatWelcomeGreeting } from "../chatWelcomeGreeting";
import { ChatWelcome } from "./ChatWelcome";

describe("ChatWelcome", () => {
  it("uses the simple unpersonalized greeting when no name is saved", () => {
    render(<ChatWelcome />);
    expect(
      screen.getByRole("heading", { name: "What can I help you with?" }),
    ).toBeInTheDocument();
  });

  it("selects a stable time-aware greeting and uses only the first name", () => {
    expect(chatWelcomeGreeting("Luke Kabbash", new Date(2026, 6, 20, 14))).toBe(
      "Good afternoon, Luke!",
    );
    expect(chatWelcomeGreeting("Luke Kabbash", new Date(2026, 6, 20, 19))).toBe(
      "Good evening, Luke!",
    );
  });
});
