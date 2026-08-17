import { useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Keyboard, RotateCcw, TriangleAlert } from "lucide-react";
import {
  KEYBINDING_GROUP_LABELS,
  KEYBINDING_GROUP_ORDER,
  type KeybindingCommandId,
  type KeybindingGroup,
  type ResolvedKeybinding,
  bindingFromEvent,
  detectMac,
  keybindingCommand,
  keycaps,
  readOverrides,
  resolveKeybindings,
  serializeBinding,
} from "../keybindings";
import { ARROW_NAVIGATION_SETTING, WRAP_NAVIGATION_SETTING } from "../spatialNavigation";
import { Dropdown } from "./Dropdown";
import { SettingRow } from "./SettingControls";
import { readSetting, type SettingsMap } from "./settingsModel";
import "./keybindingsSettings.css";

export const KEYBINDINGS_SETTING = "keybindings.overrides";

const settleSpring = { type: "spring" as const, stiffness: 540, damping: 38, mass: 0.7 };
const NO_OVERRIDES: Record<string, never> = {};

export interface KeybindingsSettingsProps {
  settings: SettingsMap;
  setSetting: (key: string, value: unknown) => void;
}

/** Keycaps, or the quiet placeholder a cleared command shows instead. */
function Keys({ binding, isMac }: { binding: string | null; isMac: boolean }) {
  const caps = keycaps(binding, isMac);
  if (caps.length === 0) return <span className="keybinding-unbound">Not bound</span>;
  return (
    <span className="keybinding-keys">
      {caps.map((cap, index) => (
        <kbd key={`${cap}-${index}`}>{cap}</kbd>
      ))}
    </span>
  );
}

function KeybindingRow({
  entry,
  isMac,
  recording,
  onRecord,
  onReset,
}: {
  entry: ResolvedKeybinding;
  isMac: boolean;
  recording: boolean;
  onRecord: () => void;
  onReset: () => void;
}) {
  const conflicts = entry.conflictsWith
    .map((id) => keybindingCommand(id)?.label)
    .filter((label): label is string => Boolean(label));
  return (
    <div
      className="keybinding-row"
      data-recording={recording || undefined}
      data-conflicted={conflicts.length > 0 || undefined}
    >
      <span className="keybinding-label">
        <strong>{entry.command.label}</strong>
        <small>{entry.command.hint}</small>
        {conflicts.length > 0 ? (
          <span className="keybinding-conflict">
            <TriangleAlert aria-hidden />
            Also bound to {conflicts.join(", ")}. The first one listed wins.
          </span>
        ) : null}
      </span>
      <div className="keybinding-controls">
        <button
          type="button"
          className="keybinding-record"
          onClick={onRecord}
          aria-label={`Change the shortcut for ${entry.command.label}`}
        >
          {recording ? (
            <span className="keybinding-listening">Press keys…</span>
          ) : (
            <Keys binding={entry.binding} isMac={isMac} />
          )}
        </button>
        <button
          type="button"
          className="keybinding-reset"
          onClick={onReset}
          disabled={!entry.customized}
          aria-label={`Reset the shortcut for ${entry.command.label}`}
          title="Reset to the default"
        >
          <RotateCcw aria-hidden />
        </button>
      </div>
    </div>
  );
}

export function KeybindingsSettings({ settings, setSetting }: KeybindingsSettingsProps) {
  const reduceMotion =
    Boolean(useReducedMotion()) || document.documentElement.dataset.motion === "none";
  const [recording, setRecording] = useState<KeybindingCommandId | null>(null);
  const isMac = useMemo(() => detectMac(navigator.platform || navigator.userAgent), []);
  // A stable fallback: a fresh `{}` here would defeat the memos below.
  const stored = readSetting<unknown>(settings, KEYBINDINGS_SETTING, NO_OVERRIDES);
  const overrides = useMemo(() => readOverrides(stored), [stored]);
  const resolved = useMemo(() => resolveKeybindings(overrides), [overrides]);
  const grouped = useMemo(() => {
    const byGroup = new Map<KeybindingGroup, ResolvedKeybinding[]>();
    for (const entry of resolved) {
      const bucket = byGroup.get(entry.command.group);
      if (bucket) bucket.push(entry);
      else byGroup.set(entry.command.group, [entry]);
    }
    return byGroup;
  }, [resolved]);
  const customizedCount = resolved.filter((entry) => entry.customized).length;

  // Committing writes the whole map so a reset can drop a key entirely; an
  // explicit `null` is how "the user cleared this" survives a reload.
  const commit = (id: KeybindingCommandId, binding: string | null | undefined) => {
    const next = { ...overrides };
    if (binding === undefined) delete next[id];
    else next[id] = binding;
    setSetting(KEYBINDINGS_SETTING, next);
  };

  useEffect(() => {
    if (!recording) return;
    // The global dispatcher stands down while the recorder owns the keyboard.
    document.body.dataset.recordingKeybinding = "true";
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(null);
        return;
      }
      if (event.code === "Backspace" || event.code === "Delete") {
        commit(recording, null);
        setRecording(null);
        return;
      }
      const binding = bindingFromEvent(event, isMac);
      // A modifier held on its own is the user still assembling the chord.
      if (!binding) return;
      commit(recording, serializeBinding(binding));
      setRecording(null);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      delete document.body.dataset.recordingKeybinding;
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- commit reads the overrides this recording session started with
  }, [recording, isMac]);

  return (
    <>
      <div className="settings-page-heading">
        <span>
          <Keyboard />
        </span>
        <div>
          <h1>Keyboard</h1>
          <p>
            Shortcuts slew to a pane; arrows move inside it. Every shortcut below runs a real
            command — click one to record new keys, press Escape to cancel, or press Backspace to
            leave it unbound.
          </p>
        </div>
      </div>
      <section className="settings-section">
        <header>
          <h2>Arrow navigation</h2>
          <p>
            In rails and lists, Up and Down move the cursor, Right opens a group, and Left closes it
            or steps out to the group above. Typing a letter jumps to the next row that starts with
            it. These keys are structural and are not rebindable; the shortcuts that reach each pane
            are.
          </p>
        </header>
        <SettingRow
          label="Arrow keys"
          description="Turn the rail cursor off if you would rather Tab through every control."
        >
          <Dropdown
            aria-label="Arrow keys"
            value={readSetting(settings, ARROW_NAVIGATION_SETTING, true) ? "on" : "off"}
            onChange={(value) => setSetting(ARROW_NAVIGATION_SETTING, value === "on")}
            options={[
              { value: "on", label: "Move the cursor" },
              { value: "off", label: "Off" },
            ]}
          />
        </SettingRow>
        <SettingRow
          label="At the end of a list"
          description="Whether the cursor continues past the last row or holds there."
        >
          <Dropdown
            aria-label="At the end of a list"
            value={readSetting(settings, WRAP_NAVIGATION_SETTING, true) ? "wrap" : "stop"}
            onChange={(value) => setSetting(WRAP_NAVIGATION_SETTING, value === "wrap")}
            options={[
              { value: "wrap", label: "Wrap to the other end" },
              { value: "stop", label: "Stop" },
            ]}
          />
        </SettingRow>
      </section>
      <section className="settings-section keybinding-summary">
        <header>
          <h2>Your bindings</h2>
          <p>
            {customizedCount === 0
              ? "All shortcuts are at their shipped defaults."
              : `${customizedCount} shortcut${customizedCount === 1 ? "" : "s"} changed from the defaults.`}
          </p>
        </header>
        <button
          type="button"
          className="ghost-button"
          onClick={() => setSetting(KEYBINDINGS_SETTING, {})}
          disabled={customizedCount === 0}
        >
          <RotateCcw aria-hidden /> Restore defaults
        </button>
      </section>
      {KEYBINDING_GROUP_ORDER.map((group) => {
        const entries = grouped.get(group) ?? [];
        if (entries.length === 0) return null;
        return (
          <section className="settings-section keybinding-group" key={group}>
            <header>
              <h2>{KEYBINDING_GROUP_LABELS[group]}</h2>
            </header>
            <motion.div
              className="keybinding-list"
              layout={reduceMotion ? false : "position"}
              transition={reduceMotion ? { duration: 0 } : settleSpring}
            >
              {entries.map((entry) => (
                <KeybindingRow
                  key={entry.command.id}
                  entry={entry}
                  isMac={isMac}
                  recording={recording === entry.command.id}
                  onRecord={() =>
                    setRecording((current) =>
                      current === entry.command.id ? null : entry.command.id,
                    )
                  }
                  onReset={() => commit(entry.command.id, undefined)}
                />
              ))}
            </motion.div>
          </section>
        );
      })}
    </>
  );
}
