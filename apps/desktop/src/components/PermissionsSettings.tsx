import { ShieldCheck } from "lucide-react";
import { Dropdown } from "./Dropdown";
import { SettingRow } from "./SettingControls";
import { readSetting, type SettingsMap } from "./settingsModel";

export interface PermissionsSettingsProps {
  settings: SettingsMap;
  setSetting: (key: string, value: unknown) => void;
}

export function PermissionsSettings({ settings, setSetting }: PermissionsSettingsProps) {
  return (
    <>
      <div className="settings-page-heading">
        <span>
          <ShieldCheck />
        </span>
        <div>
          <h1>Permissions</h1>
          <p>The permission profile for new tasks and the task you came from.</p>
        </div>
      </div>
      <section className="settings-section">
        <header>
          <h2>Default permission profile</h2>
          <p>
            Applied to new tasks and the task you came from. Other existing tasks keep their last
            explicit choice.
          </p>
        </header>
        <SettingRow
          label="Default profile"
          description="Sets the current task now and preselects the permission picker for new tasks."
        >
          <Dropdown
            aria-label="Default profile"
            value={readSetting(settings, "permissions.defaultProfile", "project-write")}
            onChange={(value) => setSetting("permissions.defaultProfile", value)}
            options={[
              { value: "read-only", label: "Read only" },
              { value: "project-write", label: "Project write" },
              { value: "ask", label: "Ask as needed" },
              { value: "full-access", label: "Full access · explicit" },
            ]}
          />
        </SettingRow>
      </section>
    </>
  );
}
