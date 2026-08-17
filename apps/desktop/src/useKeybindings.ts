import { useEffect, useRef } from "react";
import {
  type KeybindingCommandId,
  detectMac,
  keybindingLookup,
  matchKeybinding,
  readOverrides,
} from "./keybindings";

/**
 * An action returns `false` to decline the press — the key then keeps whatever
 * meaning it had, which is how Mod+W can close a file tab when one is open and
 * still close the window when none is.
 */
export type KeybindingAction = () => void | boolean;

export type KeybindingActions = Partial<Record<KeybindingCommandId, KeybindingAction>>;

/**
 * Installs the one global keydown listener. Actions are read through a ref so
 * the listener is not torn down and rebuilt on every render of a component the
 * size of App, and a shortcut fired mid-render still sees current state.
 */
export function useKeybindings(overridesValue: unknown, actions: KeybindingActions): void {
  const actionsRef = useRef(actions);
  useEffect(() => {
    actionsRef.current = actions;
  });
  const serialized = JSON.stringify(readOverrides(overridesValue));

  useEffect(() => {
    const lookup = keybindingLookup(JSON.parse(serialized) as Record<string, string | null>);
    const isMac = detectMac(navigator.platform || navigator.userAgent);
    const onKeyDown = (event: KeyboardEvent) => {
      // A rebind recorder swallows the whole keyboard while it is open.
      if (document.body.dataset.recordingKeybinding === "true") return;
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      const commandId = matchKeybinding(event, lookup, isMac);
      if (!commandId) return;
      const action = actionsRef.current[commandId];
      if (!action) return;
      if (action() === false) return;
      // Claimed: stop the webview from also printing, bolding, or focusing a
      // browser chrome field on the same press.
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [serialized]);
}
