// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BROWSER_SETTINGS, BrowserSettings } from "./BrowserSettings";

describe("BrowserSettings", () => {
  it("keeps external browser handoff off until the user enables it", () => {
    const setSetting = vi.fn();
    const view = render(<BrowserSettings settings={{}} setSetting={setSetting} />);
    const toggle = screen.getByRole("switch", {
      name: "Allow opening tabs in an external browser",
    });

    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    expect(setSetting).toHaveBeenCalledWith(BROWSER_SETTINGS.externalOpen, true);

    view.rerender(
      <BrowserSettings
        settings={{ [BROWSER_SETTINGS.externalOpen]: true }}
        setSetting={setSetting}
      />,
    );
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });
});
