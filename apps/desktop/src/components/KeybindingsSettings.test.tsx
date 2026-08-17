// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { KEYBINDINGS_SETTING, KeybindingsSettings } from "./KeybindingsSettings";
import type { SettingsMap } from "./settingsModel";

/** Mirrors SettingsView: the parent owns the map and echoes writes back down. */
function Harness({ onWrite }: { onWrite?: (value: unknown) => void }) {
  const [settings, setSettings] = useState<SettingsMap>({});
  return (
    <KeybindingsSettings
      settings={settings}
      setSetting={(key, value) => {
        onWrite?.(value);
        setSettings((current) => ({ ...current, [key]: value }));
      }}
    />
  );
}

const row = (label: string) => screen.getByText(label).closest(".keybinding-row") as HTMLElement;

const keysOf = (label: string) => {
  const scope = row(label);
  const caps = within(scope)
    .queryAllByText(/.*/, { selector: ".keybinding-keys kbd" })
    .map((cap) => cap.textContent);
  return caps.length > 0 ? caps.join(" ") : (scope.querySelector(".keybinding-unbound")?.textContent ?? "");
};

const record = (label: string, init: KeyboardEventInit) => {
  fireEvent.click(within(row(label)).getByRole("button", { name: /^Change the shortcut/ }));
  fireEvent.keyDown(window, { bubbles: true, ...init });
};

describe("KeybindingsSettings", () => {
  it("lists every group at its shipped default", () => {
    render(<Harness />);
    expect(screen.getByText("Navigation")).toBeInTheDocument();
    expect(screen.getByText("Work pane")).toBeInTheDocument();
    expect(keysOf("New chat")).toBe("Ctrl N");
    expect(keysOf("Search chats")).toBe("Ctrl K");
    expect(screen.getByText("All shortcuts are at their shipped defaults.")).toBeInTheDocument();
  });

  it("records a new binding and persists it canonically", () => {
    const onWrite = vi.fn();
    render(<Harness onWrite={onWrite} />);
    record("New chat", { code: "KeyN", key: "N", ctrlKey: true, shiftKey: true });
    expect(keysOf("New chat")).toBe("Ctrl Shift N");
    expect(onWrite).toHaveBeenCalledWith({ "navigation.newChat": "Mod+Shift+N" });
    expect(screen.getByText("1 shortcut changed from the defaults.")).toBeInTheDocument();
  });

  it("keeps listening while only modifiers are held", () => {
    render(<Harness />);
    record("New chat", { code: "ShiftLeft", key: "Shift", shiftKey: true });
    expect(screen.getByText("Press keys…")).toBeInTheDocument();
    fireEvent.keyDown(window, { code: "KeyJ", key: "J", ctrlKey: true, bubbles: true });
    expect(keysOf("New chat")).toBe("Ctrl J");
  });

  it("cancels on Escape and leaves the binding alone", () => {
    render(<Harness />);
    record("New chat", { code: "Escape", key: "Escape" });
    expect(screen.queryByText("Press keys…")).not.toBeInTheDocument();
    expect(keysOf("New chat")).toBe("Ctrl N");
  });

  it("clears a binding on Backspace", () => {
    render(<Harness />);
    record("New chat", { code: "Backspace", key: "Backspace" });
    expect(keysOf("New chat")).toBe("Not bound");
  });

  it("names the other command when two bindings collide", () => {
    render(<Harness />);
    record("Toggle chat sidebar", { code: "KeyN", key: "N", ctrlKey: true });
    expect(within(row("New chat")).getByText(/Also bound to Toggle chat sidebar/)).toBeInTheDocument();
    expect(within(row("Toggle chat sidebar")).getByText(/Also bound to New chat/)).toBeInTheDocument();
  });

  it("resets one row without touching the others", () => {
    render(<Harness />);
    record("New chat", { code: "KeyJ", key: "J", ctrlKey: true });
    record("Toggle chat sidebar", { code: "KeyM", key: "M", ctrlKey: true });
    fireEvent.click(within(row("New chat")).getByRole("button", { name: /^Reset the shortcut/ }));
    expect(keysOf("New chat")).toBe("Ctrl N");
    expect(keysOf("Toggle chat sidebar")).toBe("Ctrl M");
  });

  it("restores every default at once", () => {
    const onWrite = vi.fn();
    render(<Harness onWrite={onWrite} />);
    record("New chat", { code: "KeyJ", key: "J", ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Restore defaults" }));
    expect(onWrite).toHaveBeenLastCalledWith({});
    expect(keysOf("New chat")).toBe("Ctrl N");
    expect(screen.getByRole("button", { name: "Restore defaults" })).toBeDisabled();
  });

  it("stands the global dispatcher down only while recording", () => {
    render(<Harness />);
    fireEvent.click(within(row("New chat")).getByRole("button", { name: /^Change the shortcut/ }));
    expect(document.body.dataset.recordingKeybinding).toBe("true");
    fireEvent.keyDown(window, { code: "KeyJ", key: "J", ctrlKey: true, bubbles: true });
    expect(document.body.dataset.recordingKeybinding).toBeUndefined();
  });

  it("reads a stored override and marks it customized", () => {
    render(
      <KeybindingsSettings
        settings={{ [KEYBINDINGS_SETTING]: { "navigation.newChat": "mod+alt+n" } }}
        setSetting={vi.fn()}
      />,
    );
    expect(keysOf("New chat")).toBe("Ctrl Alt N");
    expect(within(row("New chat")).getByRole("button", { name: /^Reset the shortcut/ })).toBeEnabled();
  });
});
