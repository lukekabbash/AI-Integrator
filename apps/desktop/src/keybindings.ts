/**
 * Keyboard shortcuts: the registry, the canonical binding grammar, and the
 * resolver that turns a keydown into a command.
 *
 * Nothing here touches React, the bridge, or the DOM beyond reading a
 * `KeyboardEvent`, so the whole surface is unit-testable and the Settings
 * subtab and the global dispatcher share one source of truth.
 *
 * A binding is stored canonically as `Mod+Shift+K`. `Mod` means Command on
 * macOS and Control everywhere else, so one stored value is correct on both
 * platforms. Keys are matched on `KeyboardEvent.code`, not `key`, so holding
 * Shift does not turn `1` into `!` and a rebind survives a layout change.
 */

export type KeybindingGroup = "panes" | "navigation" | "chat" | "workPane" | "application";

export type KeybindingCommandId =
  | "panes.focusSidebar"
  | "panes.focusTranscript"
  | "panes.focusComposer"
  | "panes.focusWorkPane"
  | "navigation.newChat"
  | "navigation.nextChat"
  | "navigation.previousChat"
  | "navigation.toggleSidebar"
  | "navigation.searchChats"
  | "navigation.openScheduled"
  | "navigation.openSettings"
  | "chat.stopTurn"
  | "chat.copyConversation"
  | "workPane.toggle"
  | "workPane.review"
  | "workPane.files"
  | "workPane.agents"
  | "workPane.browser"
  | "workPane.terminal"
  | "workPane.closeFile"
  | "application.openKeybindings";

export interface KeybindingCommand {
  id: KeybindingCommandId;
  label: string;
  /** Shown under the label in Settings; says what the command does, not how to press it. */
  hint: string;
  group: KeybindingGroup;
  /** Canonical binding shipped with the app. `null` means unbound by default. */
  defaultBinding: string | null;
}

export const KEYBINDING_GROUP_LABELS: Record<KeybindingGroup, string> = {
  panes: "Panes",
  navigation: "Navigation",
  chat: "Chat",
  workPane: "Work pane",
  application: "Application",
};

export const KEYBINDING_GROUP_ORDER: readonly KeybindingGroup[] = [
  "panes",
  "navigation",
  "chat",
  "workPane",
  "application",
];

/**
 * Every command here is dispatched by `useKeybindings`. A row with no
 * behavior behind it does not belong in this list or in Settings.
 */
export const KEYBINDING_COMMANDS: readonly KeybindingCommand[] = [
  {
    id: "panes.focusSidebar",
    label: "Focus the chat rail",
    hint: "Puts the cursor on the active chat; arrows move from there.",
    group: "panes",
    defaultBinding: "Mod+1",
  },
  {
    id: "panes.focusTranscript",
    label: "Focus the transcript",
    hint: "Moves focus to the conversation so it scrolls with the keyboard.",
    group: "panes",
    defaultBinding: "Mod+2",
  },
  {
    id: "panes.focusComposer",
    label: "Focus the composer",
    hint: "Returns to the workspace and puts the cursor in the message box.",
    group: "panes",
    defaultBinding: "Mod+3",
  },
  {
    id: "panes.focusWorkPane",
    label: "Focus the work pane",
    hint: "Opens the right-hand pane if it is closed, then moves focus into it.",
    group: "panes",
    defaultBinding: "Mod+4",
  },
  {
    id: "navigation.newChat",
    label: "New chat",
    hint: "Start a chat in the active project.",
    group: "navigation",
    defaultBinding: "Mod+N",
  },
  {
    id: "navigation.nextChat",
    label: "Next chat",
    hint: "Move down the sidebar list.",
    group: "navigation",
    defaultBinding: "Alt+ArrowDown",
  },
  {
    id: "navigation.previousChat",
    label: "Previous chat",
    hint: "Move up the sidebar list.",
    group: "navigation",
    defaultBinding: "Alt+ArrowUp",
  },
  {
    id: "navigation.toggleSidebar",
    label: "Toggle chat sidebar",
    hint: "Collapse or restore the left navigation.",
    group: "navigation",
    defaultBinding: "Mod+B",
  },
  {
    id: "navigation.searchChats",
    label: "Search chats",
    hint: "Open search over chats, projects, and messages.",
    group: "navigation",
    defaultBinding: "Mod+K",
  },
  {
    id: "navigation.openScheduled",
    label: "Open scheduled",
    hint: "Show the scheduled automations screen.",
    group: "navigation",
    defaultBinding: "Mod+Shift+A",
  },
  {
    id: "navigation.openSettings",
    label: "Open settings",
    hint: "Jump to Settings and back with Escape.",
    group: "navigation",
    defaultBinding: "Mod+,",
  },
  {
    id: "chat.stopTurn",
    label: "Stop the current turn",
    hint: "Interrupt the running agent without clearing the queue.",
    group: "chat",
    defaultBinding: "Mod+.",
  },
  {
    id: "chat.copyConversation",
    label: "Copy conversation",
    hint: "Copy the visible transcript to the clipboard.",
    group: "chat",
    defaultBinding: "Mod+Shift+C",
  },
  {
    id: "workPane.toggle",
    label: "Toggle work pane",
    hint: "Show or hide the right-hand pane.",
    group: "workPane",
    defaultBinding: "Mod+I",
  },
  {
    id: "workPane.review",
    label: "Open Review",
    hint: "Show the working-tree diff in the work pane.",
    group: "workPane",
    defaultBinding: "Mod+Shift+G",
  },
  {
    id: "workPane.files",
    label: "Open Files",
    hint: "Show the project file tree in the work pane.",
    group: "workPane",
    defaultBinding: "Mod+Shift+E",
  },
  {
    id: "workPane.agents",
    label: "Open Subagents",
    hint: "Show delegated agents in the work pane.",
    group: "workPane",
    defaultBinding: "Mod+Shift+D",
  },
  {
    id: "workPane.browser",
    label: "Open Browser",
    hint: "Open a browser tab the agent can also drive.",
    group: "workPane",
    defaultBinding: "Mod+Shift+B",
  },
  {
    id: "workPane.terminal",
    label: "Toggle terminal",
    hint: "Show or hide the terminal drawer.",
    group: "workPane",
    defaultBinding: "Mod+`",
  },
  {
    id: "workPane.closeFile",
    label: "Close the open file",
    hint: "Closes the active file tab. With no file open the key keeps its native meaning.",
    group: "workPane",
    defaultBinding: "Mod+W",
  },
  {
    id: "application.openKeybindings",
    label: "Keyboard shortcuts",
    hint: "Open this settings page.",
    group: "application",
    defaultBinding: "Mod+Shift+K",
  },
];

const COMMANDS_BY_ID = new Map(KEYBINDING_COMMANDS.map((command) => [command.id, command]));

export function keybindingCommand(id: KeybindingCommandId): KeybindingCommand | undefined {
  return COMMANDS_BY_ID.get(id);
}

/**
 * `code` values we accept, mapped to the token stored and displayed. Anything
 * outside this table is not bindable — modifier-only presses, media keys, and
 * IME composition keys would all produce shortcuts nobody can type twice.
 */
const CODE_TOKENS = new Map<string, string>([
  ["Space", "Space"],
  ["Enter", "Enter"],
  ["Tab", "Tab"],
  ["Backspace", "Backspace"],
  ["Delete", "Delete"],
  ["Insert", "Insert"],
  ["Home", "Home"],
  ["End", "End"],
  ["PageUp", "PageUp"],
  ["PageDown", "PageDown"],
  ["ArrowUp", "ArrowUp"],
  ["ArrowDown", "ArrowDown"],
  ["ArrowLeft", "ArrowLeft"],
  ["ArrowRight", "ArrowRight"],
  ["Backquote", "`"],
  ["Minus", "-"],
  ["Equal", "="],
  ["BracketLeft", "["],
  ["BracketRight", "]"],
  ["Backslash", "\\"],
  ["Semicolon", ";"],
  ["Quote", "'"],
  ["Comma", ","],
  ["Period", "."],
  ["Slash", "/"],
]);

for (let index = 0; index < 26; index += 1) {
  const letter = String.fromCharCode(65 + index);
  CODE_TOKENS.set(`Key${letter}`, letter);
}
for (let digit = 0; digit <= 9; digit += 1) {
  CODE_TOKENS.set(`Digit${digit}`, String(digit));
  CODE_TOKENS.set(`Numpad${digit}`, `Numpad${digit}`);
}
for (let fn = 1; fn <= 12; fn += 1) {
  CODE_TOKENS.set(`F${fn}`, `F${fn}`);
}

const TOKEN_CODES = new Map([...CODE_TOKENS].map(([code, token]) => [token.toLowerCase(), code]));

/** Escape is reserved: it closes dialogs, panels, and the search modal. */
const RESERVED_TOKENS = new Set(["Escape"]);

export interface Binding {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** A token from `CODE_TOKENS`, e.g. `K`, `,`, `ArrowDown`, `F5`. */
  token: string;
}

export function serializeBinding(binding: Binding): string {
  const parts: string[] = [];
  if (binding.mod) parts.push("Mod");
  if (binding.ctrl) parts.push("Ctrl");
  if (binding.alt) parts.push("Alt");
  if (binding.shift) parts.push("Shift");
  parts.push(binding.token);
  return parts.join("+");
}

/**
 * Parses a stored or user-typed binding. Returns `null` for anything we cannot
 * canonicalize, so a corrupt settings value degrades to "unbound" rather than
 * to a shortcut that silently never fires.
 */
export function parseBinding(text: string): Binding | null {
  const parts = text
    .trim()
    .split("+")
    .map((part) => part.trim());
  // No token in `CODE_TOKENS` is "+" or empty, so an empty part is malformed.
  if (parts.length === 0 || parts.some((part) => !part)) return null;
  const binding: Binding = { mod: false, ctrl: false, alt: false, shift: false, token: "" };
  const keyPart = parts[parts.length - 1] ?? "";
  for (const part of parts.slice(0, -1)) {
    switch (part.toLowerCase()) {
      case "mod":
      case "cmd":
      case "command":
      case "meta":
      case "super":
        binding.mod = true;
        break;
      case "ctrl":
      case "control":
        binding.ctrl = true;
        break;
      case "alt":
      case "option":
        binding.alt = true;
        break;
      case "shift":
        binding.shift = true;
        break;
      default:
        return null;
    }
  }
  const code = TOKEN_CODES.get(keyPart.toLowerCase());
  if (!code) return null;
  binding.token = CODE_TOKENS.get(code) ?? "";
  if (!binding.token || RESERVED_TOKENS.has(binding.token)) return null;
  return binding;
}

/** Canonical form of a binding string, or `null` if it is not bindable. */
export function normalizeBinding(text: string): string | null {
  const parsed = parseBinding(text);
  return parsed ? serializeBinding(parsed) : null;
}

export interface KeyEventLike {
  code: string;
  /** Fallback for events that carry no physical code; see `eventToken`. */
  key?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Physical `code` first. Virtual keyboards, IMEs, and remote-desktop bridges
 * sometimes deliver a keydown with an empty `code`, so `key` is read as a
 * fallback — imprecise under Shift, but better than dropping the press.
 */
function eventToken(event: KeyEventLike): string | undefined {
  const fromCode = CODE_TOKENS.get(event.code);
  if (fromCode) return fromCode;
  const code = event.key ? TOKEN_CODES.get(event.key.toLowerCase()) : undefined;
  return code ? CODE_TOKENS.get(code) : undefined;
}

/**
 * Reads a binding out of a keydown. `mod` collapses the platform key so a
 * stored `Mod+N` matches Cmd+N on macOS and Ctrl+N elsewhere; a macOS user who
 * really wants physical Control gets `ctrl` instead.
 */
export function bindingFromEvent(event: KeyEventLike, isMac: boolean): Binding | null {
  const token = eventToken(event);
  if (!token || RESERVED_TOKENS.has(token)) return null;
  const binding: Binding = {
    mod: isMac ? event.metaKey : event.ctrlKey,
    ctrl: isMac ? event.ctrlKey : false,
    alt: event.altKey,
    shift: event.shiftKey,
    token,
  };
  // A non-mac Meta press is the OS key (Windows/Super); never claim it.
  if (!isMac && event.metaKey) return null;
  return binding;
}

/** Stored overrides: command id → canonical binding, or `null` for "unbound". */
export type KeybindingOverrides = Record<string, string | null>;

/**
 * Accepts whatever is in settings — the value round-trips through JSON and may
 * predate a command rename — and keeps only entries we still understand.
 */
export function readOverrides(value: unknown): KeybindingOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const overrides: KeybindingOverrides = {};
  for (const [id, binding] of Object.entries(value as Record<string, unknown>)) {
    if (!COMMANDS_BY_ID.has(id as KeybindingCommandId)) continue;
    if (binding === null) {
      overrides[id] = null;
      continue;
    }
    if (typeof binding !== "string") continue;
    const normalized = normalizeBinding(binding);
    if (normalized) overrides[id] = normalized;
  }
  return overrides;
}

export interface ResolvedKeybinding {
  command: KeybindingCommand;
  /** `null` when the user cleared the binding. */
  binding: string | null;
  /** True when the binding differs from what ships with the app. */
  customized: boolean;
  /** Other commands bound to the same keys; the first one wins at dispatch. */
  conflictsWith: KeybindingCommandId[];
}

/**
 * Resolves the full table. Conflicts are reported rather than rejected: a user
 * mid-rebind will pass through a colliding state, and the settings page needs
 * to show that instead of refusing the edit.
 */
export function resolveKeybindings(overrides: KeybindingOverrides): ResolvedKeybinding[] {
  const owners = new Map<string, KeybindingCommandId[]>();
  const resolved = KEYBINDING_COMMANDS.map((command) => {
    const binding = command.id in overrides ? overrides[command.id] : command.defaultBinding;
    if (binding) {
      const existing = owners.get(binding);
      if (existing) existing.push(command.id);
      else owners.set(binding, [command.id]);
    }
    return {
      command,
      binding: binding ?? null,
      customized: (binding ?? null) !== command.defaultBinding,
      conflictsWith: [] as KeybindingCommandId[],
    };
  });
  for (const entry of resolved) {
    if (!entry.binding) continue;
    entry.conflictsWith = (owners.get(entry.binding) ?? []).filter((id) => id !== entry.command.id);
  }
  return resolved;
}

/** Dispatch table: canonical binding → the command that wins it. */
export function keybindingLookup(overrides: KeybindingOverrides): Map<string, KeybindingCommandId> {
  const lookup = new Map<string, KeybindingCommandId>();
  for (const entry of resolveKeybindings(overrides)) {
    if (entry.binding && !lookup.has(entry.binding)) lookup.set(entry.binding, entry.command.id);
  }
  return lookup;
}

/** True while the user is typing somewhere a bare key belongs to the field. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Resolves a keydown to a command, or `null`. Bindings without a Mod/Ctrl/Alt
 * modifier are suppressed inside text fields so a rebind to a bare letter
 * cannot eat the user's typing.
 */
export function matchKeybinding(
  event: KeyEventLike & { target?: EventTarget | null },
  lookup: Map<string, KeybindingCommandId>,
  isMac: boolean,
): KeybindingCommandId | null {
  const binding = bindingFromEvent(event, isMac);
  if (!binding) return null;
  const commandId = lookup.get(serializeBinding(binding));
  if (!commandId) return null;
  const modified = binding.mod || binding.ctrl || binding.alt;
  if (!modified && isEditableTarget(event.target ?? null)) return null;
  return commandId;
}

const MAC_SYMBOLS: Record<string, string> = {
  Mod: "⌘",
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Enter: "↩",
  Tab: "⇥",
  Backspace: "⌫",
  Delete: "⌦",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

const KEYCAP_LABELS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Space: "Space",
};

/**
 * Splits a binding into the keycaps to render. Returns `[]` for an unbound
 * command so callers can show their own empty state.
 */
export function keycaps(binding: string | null, isMac: boolean): string[] {
  if (!binding) return [];
  const parsed = parseBinding(binding);
  if (!parsed) return [];
  return serializeBinding(parsed)
    .split("+")
    .map((part) => {
      if (part === "Mod") return isMac ? MAC_SYMBOLS.Mod : "Ctrl";
      if (isMac && MAC_SYMBOLS[part]) return MAC_SYMBOLS[part];
      return KEYCAP_LABELS[part] ?? part;
    });
}

/** True on macOS, where `Mod` is Command and `Meta` is ours to claim. */
export function detectMac(platform: string): boolean {
  return /mac/i.test(platform);
}
