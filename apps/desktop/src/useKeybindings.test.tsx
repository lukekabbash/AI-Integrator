// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useKeybindings, type KeybindingActions } from "./useKeybindings";

function Harness({ overrides, actions }: { overrides?: unknown; actions: KeybindingActions }) {
  useKeybindings(overrides, actions);
  return <textarea aria-label="composer" />;
}

const press = (init: KeyboardEventInit) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(event);
  return event;
};

afterEach(() => {
  delete document.body.dataset.recordingKeybinding;
});

describe("useKeybindings", () => {
  it("runs the action for a bound press and claims the key", () => {
    const newChat = vi.fn();
    render(<Harness actions={{ "navigation.newChat": newChat }} />);
    const event = press({ code: "KeyN", ctrlKey: true });
    expect(newChat).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves a command with no action alone", () => {
    render(<Harness actions={{}} />);
    expect(press({ code: "KeyN", ctrlKey: true }).defaultPrevented).toBe(false);
  });

  it("lets an action decline so the key keeps its native meaning", () => {
    const closeFile = vi.fn(() => false);
    render(<Harness actions={{ "workPane.closeFile": closeFile }} />);
    const event = press({ code: "KeyW", ctrlKey: true });
    expect(closeFile).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(false);
  });

  it("honors a user override instead of the shipped default", () => {
    const newChat = vi.fn();
    render(
      <Harness
        overrides={{ "navigation.newChat": "Mod+Shift+N" }}
        actions={{ "navigation.newChat": newChat }}
      />,
    );
    expect(press({ code: "KeyN", ctrlKey: true }).defaultPrevented).toBe(false);
    press({ code: "KeyN", ctrlKey: true, shiftKey: true });
    expect(newChat).toHaveBeenCalledOnce();
  });

  it("ignores an unbound command", () => {
    const newChat = vi.fn();
    render(
      <Harness
        overrides={{ "navigation.newChat": null }}
        actions={{ "navigation.newChat": newChat }}
      />,
    );
    press({ code: "KeyN", ctrlKey: true });
    expect(newChat).not.toHaveBeenCalled();
  });

  it("stands down while a rebind recorder owns the keyboard", () => {
    const newChat = vi.fn();
    render(<Harness actions={{ "navigation.newChat": newChat }} />);
    document.body.dataset.recordingKeybinding = "true";
    press({ code: "KeyN", ctrlKey: true });
    expect(newChat).not.toHaveBeenCalled();
  });

  it("ignores auto-repeat and already-handled presses", () => {
    const newChat = vi.fn();
    render(<Harness actions={{ "navigation.newChat": newChat }} />);
    press({ code: "KeyN", ctrlKey: true, repeat: true });
    const handled = new KeyboardEvent("keydown", {
      code: "KeyN",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    handled.preventDefault();
    window.dispatchEvent(handled);
    expect(newChat).not.toHaveBeenCalled();
  });

  it("calls the latest action after a re-render", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Harness actions={{ "navigation.newChat": first }} />);
    rerender(<Harness actions={{ "navigation.newChat": second }} />);
    press({ code: "KeyN", ctrlKey: true });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("stops listening once unmounted", () => {
    const newChat = vi.fn();
    const { unmount } = render(<Harness actions={{ "navigation.newChat": newChat }} />);
    unmount();
    expect(press({ code: "KeyN", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(newChat).not.toHaveBeenCalled();
  });

  it("does not fire an unmodified binding while the user is typing", () => {
    const newChat = vi.fn();
    const view = render(
      <Harness overrides={{ "navigation.newChat": "N" }} actions={{ "navigation.newChat": newChat }} />,
    );
    fireEvent.keyDown(view.getByLabelText("composer"), { code: "KeyN", bubbles: true });
    expect(newChat).not.toHaveBeenCalled();
    press({ code: "KeyN" });
    expect(newChat).toHaveBeenCalledOnce();
  });
});
