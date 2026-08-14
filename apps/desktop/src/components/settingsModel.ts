export type SettingsMap = Record<string, unknown>;

export function readSetting<T>(settings: SettingsMap, key: string, fallback: T): T {
  return (key in settings ? settings[key] : fallback) as T;
}
