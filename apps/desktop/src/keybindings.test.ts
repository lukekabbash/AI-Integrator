import { describe, expect, it } from "vitest";
import {
  KEYBINDING_COMMANDS,
  bindingFromEvent,
  detectMac,
  keybindingLookup,
  keycaps,
  matchKeybinding,
  normalizeBinding,
  parseBinding,
  readOverrides,
  resolveKeybindings,
  serializeBinding,
} from "./keybindings";

const event = (code: string, modifiers: Partial<Record<string, boolean>> = {}) => ({
  code,
  metaKey: Boolean(modifiers.metaKey),
  ctrlKey: Boolean(modifiers.ctrlKey),
  altKey: Boolean(modifiers.altKey),
  shiftKey: Boolean(modifiers.shiftKey),
});

describe("the shipped registry", () => {
  it("gives every command a unique id", () => {
    const ids = KEYBINDING_COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ships defaults that are all parseable and canonical", () => {
    for (const command of KEYBINDING_COMMANDS) {
      if (!command.defaultBinding) continue;
      expect(normalizeBinding(command.defaultBinding), command.id).toBe(command.defaultBinding);
    }
  });

  it("ships no conflicting defaults", () => {
    const conflicted = resolveKeybindings({}).filter((entry) => entry.conflictsWith.length > 0);
    expect(conflicted).toEqual([]);
  });
});

describe("parseBinding", () => {
  it("canonicalizes modifier order and aliases", () => {
    expect(normalizeBinding("shift+cmd+k")).toBe("Mod+Shift+K");
    expect(normalizeBinding("option+meta+j")).toBe("Mod+Alt+J");
    expect(normalizeBinding(" control + alt + / ")).toBe("Ctrl+Alt+/");
  });

  it("accepts punctuation, arrows, and function keys", () => {
    expect(normalizeBinding("Mod+,")).toBe("Mod+,");
    expect(normalizeBinding("Mod+`")).toBe("Mod+`");
    expect(normalizeBinding("Alt+ArrowDown")).toBe("Alt+ArrowDown");
    expect(normalizeBinding("F5")).toBe("F5");
  });

  it("rejects what nobody can type twice", () => {
    expect(parseBinding("")).toBe(null);
    expect(parseBinding("Mod+")).toBe(null);
    expect(parseBinding("Hyper+K")).toBe(null);
    expect(parseBinding("Mod+Shift")).toBe(null);
    expect(parseBinding("Escape"), "Escape stays reserved for closing things").toBe(null);
  });
});

describe("bindingFromEvent", () => {
  it("maps the platform modifier onto Mod", () => {
    expect(serializeBinding(bindingFromEvent(event("KeyN", { ctrlKey: true }), false)!)).toBe(
      "Mod+N",
    );
    expect(serializeBinding(bindingFromEvent(event("KeyN", { metaKey: true }), true)!)).toBe(
      "Mod+N",
    );
  });

  it("keeps physical Control distinct from Mod on macOS", () => {
    expect(serializeBinding(bindingFromEvent(event("KeyN", { ctrlKey: true }), true)!)).toBe(
      "Ctrl+N",
    );
  });

  it("never claims the Windows key", () => {
    expect(bindingFromEvent(event("KeyN", { metaKey: true }), false)).toBe(null);
  });

  it("reads the physical key, so Shift does not rewrite the token", () => {
    expect(serializeBinding(bindingFromEvent(event("Digit1", { shiftKey: true }), false)!)).toBe(
      "Shift+1",
    );
  });

  it("falls back to `key` when the event carries no physical code", () => {
    expect(serializeBinding(bindingFromEvent({ ...event("", { ctrlKey: true }), key: "k" }, false)!)).toBe(
      "Mod+K",
    );
    expect(
      serializeBinding(bindingFromEvent({ ...event("", { altKey: true }), key: "ArrowDown" }, false)!),
    ).toBe("Alt+ArrowDown");
    expect(bindingFromEvent({ ...event(""), key: "Unidentified" }, false)).toBe(null);
  });

  it("prefers the physical code over `key` when both are present", () => {
    expect(
      serializeBinding(bindingFromEvent({ ...event("Digit1", { shiftKey: true }), key: "!" }, false)!),
    ).toBe("Shift+1");
  });

  it("ignores modifier-only and unbindable presses", () => {
    expect(bindingFromEvent(event("ShiftLeft", { shiftKey: true }), false)).toBe(null);
    expect(bindingFromEvent(event("AudioVolumeUp"), false)).toBe(null);
    expect(bindingFromEvent(event("Escape"), false)).toBe(null);
  });
});

describe("readOverrides", () => {
  it("keeps only entries we still understand", () => {
    expect(
      readOverrides({
        "navigation.newChat": "mod+shift+n",
        "navigation.toggleSidebar": null,
        "chat.focusComposer": "Hyper+L",
        "removed.command": "Mod+Q",
        "chat.stopTurn": 42,
      }),
    ).toEqual({
      "navigation.newChat": "Mod+Shift+N",
      "navigation.toggleSidebar": null,
    });
  });

  it("treats a corrupt value as no overrides at all", () => {
    expect(readOverrides(null)).toEqual({});
    expect(readOverrides("Mod+N")).toEqual({});
    expect(readOverrides(["Mod+N"])).toEqual({});
  });
});

describe("resolveKeybindings", () => {
  it("marks an override as customized and leaves the rest at defaults", () => {
    const resolved = resolveKeybindings({ "navigation.newChat": "Mod+Shift+N" });
    const newChat = resolved.find((entry) => entry.command.id === "navigation.newChat")!;
    const sidebar = resolved.find((entry) => entry.command.id === "navigation.toggleSidebar")!;
    expect(newChat.binding).toBe("Mod+Shift+N");
    expect(newChat.customized).toBe(true);
    expect(sidebar.customized).toBe(false);
  });

  it("treats an explicit null as unbound and customized", () => {
    const resolved = resolveKeybindings({ "navigation.newChat": null });
    const newChat = resolved.find((entry) => entry.command.id === "navigation.newChat")!;
    expect(newChat.binding).toBe(null);
    expect(newChat.customized).toBe(true);
  });

  it("reports a collision on both sides", () => {
    const resolved = resolveKeybindings({ "navigation.toggleSidebar": "Mod+N" });
    const newChat = resolved.find((entry) => entry.command.id === "navigation.newChat")!;
    const sidebar = resolved.find((entry) => entry.command.id === "navigation.toggleSidebar")!;
    expect(newChat.conflictsWith).toEqual(["navigation.toggleSidebar"]);
    expect(sidebar.conflictsWith).toEqual(["navigation.newChat"]);
  });

  it("gives a collided binding to the command declared first", () => {
    const lookup = keybindingLookup({ "navigation.toggleSidebar": "Mod+N" });
    expect(lookup.get("Mod+N")).toBe("navigation.newChat");
  });
});

describe("matchKeybinding", () => {
  const lookup = keybindingLookup({});

  it("resolves a modified press to its command", () => {
    expect(matchKeybinding(event("KeyN", { ctrlKey: true }), lookup, false)).toBe(
      "navigation.newChat",
    );
  });

  it("does not fire a near-miss with an extra modifier", () => {
    expect(matchKeybinding(event("KeyN", { ctrlKey: true, altKey: true }), lookup, false)).toBe(
      null,
    );
  });

  it("lets a modified binding through while the user is typing", () => {
    const target = document.createElement("textarea");
    expect(matchKeybinding({ ...event("KeyN", { ctrlKey: true }), target }, lookup, false)).toBe(
      "navigation.newChat",
    );
  });

  it("suppresses an unmodified binding inside a text field", () => {
    const bare = keybindingLookup({ "navigation.newChat": "N" });
    const target = document.createElement("input");
    expect(matchKeybinding({ ...event("KeyN"), target }, bare, false)).toBe(null);
    expect(matchKeybinding(event("KeyN"), bare, false)).toBe("navigation.newChat");
  });
});

describe("keycaps", () => {
  it("spells the modifier out on Windows and symbolizes it on macOS", () => {
    expect(keycaps("Mod+Shift+K", false)).toEqual(["Ctrl", "Shift", "K"]);
    expect(keycaps("Mod+Shift+K", true)).toEqual(["⌘", "⇧", "K"]);
  });

  it("renders arrows as glyphs on both platforms", () => {
    expect(keycaps("Alt+ArrowDown", false)).toEqual(["Alt", "↓"]);
    expect(keycaps("Alt+ArrowDown", true)).toEqual(["⌥", "↓"]);
  });

  it("returns nothing for an unbound or unreadable command", () => {
    expect(keycaps(null, false)).toEqual([]);
    expect(keycaps("Hyper+K", false)).toEqual([]);
  });
});

describe("detectMac", () => {
  it("recognizes the macOS platform strings", () => {
    expect(detectMac("MacIntel")).toBe(true);
    expect(detectMac("macOS")).toBe(true);
    expect(detectMac("Win32")).toBe(false);
    expect(detectMac("Linux x86_64")).toBe(false);
  });
});
