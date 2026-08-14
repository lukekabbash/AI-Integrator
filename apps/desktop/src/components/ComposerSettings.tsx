import { Braces } from "lucide-react";
import { Dropdown } from "./Dropdown";
import { SettingRow } from "./SettingControls";
import { readSetting, type SettingsMap } from "./settingsModel";

export interface ComposerSettingsProps {
  settings: SettingsMap;
  setSetting: (key: string, value: unknown) => void;
}

export function ComposerSettings({ settings, setSetting }: ComposerSettingsProps) {
  return (
    <>
      <div className="settings-page-heading">
        <span>
          <Braces />
        </span>
        <div>
          <h1>Composer</h1>
          <p>What the Enter key does, and which metadata appears above transcript replies.</p>
        </div>
      </div>
      <section className="settings-section">
        <header>
          <h2>Turn behavior</h2>
          <p>Changes apply to every chat composer immediately.</p>
        </header>
        <SettingRow
          label="Enter key"
          description="Choose whether Enter sends or inserts a new line. Ctrl+Enter always sends."
        >
          <Dropdown
            aria-label="Enter key"
            value={readSetting(settings, "composer.enterToSend", true) ? "send" : "newline"}
            onChange={(value) => setSetting("composer.enterToSend", value === "send")}
            options={[
              { value: "send", label: "Send message" },
              { value: "newline", label: "New line" },
            ]}
          />
        </SettingRow>
      </section>
      <section className="settings-section">
        <header>
          <h2>Transcript</h2>
          <p>Metadata shown above each agent reply in every chat.</p>
        </header>
        <SettingRow label="Model attribution" description="Show which model produced each reply.">
          <Dropdown
            aria-label="Model attribution"
            value={readSetting(settings, "transcript.showModel", true) ? "show" : "hide"}
            onChange={(value) => setSetting("transcript.showModel", value === "show")}
            options={[
              { value: "show", label: "Show" },
              { value: "hide", label: "Hide" },
            ]}
          />
        </SettingRow>
        <SettingRow
          label="Timestamps"
          description="Show the clock time above replies and on your messages."
        >
          <Dropdown
            aria-label="Timestamps"
            value={readSetting(settings, "transcript.showTimestamps", true) ? "show" : "hide"}
            onChange={(value) => setSetting("transcript.showTimestamps", value === "show")}
            options={[
              { value: "show", label: "Show" },
              { value: "hide", label: "Hide" },
            ]}
          />
        </SettingRow>
        <SettingRow
          label="Activity detail"
          description="Summary collapses every tool step, Normal groups runs of activity, and Verbose shows each event."
        >
          <Dropdown
            aria-label="Activity detail"
            value={readSetting(settings, "transcript.activityDensity", "normal")}
            onChange={(value) => setSetting("transcript.activityDensity", value)}
            options={[
              { value: "summary", label: "Summary" },
              { value: "normal", label: "Normal" },
              { value: "verbose", label: "Verbose" },
            ]}
          />
        </SettingRow>
      </section>
    </>
  );
}
