export type ComposerNoticeVariant = "error" | "warning";

export interface ComposerNotice {
  id: string;
  title: string;
  message: string;
  variant: ComposerNoticeVariant;
  expiresAt?: number;
  action?: {
    label: string;
    onSelect: () => void;
  };
}

const USAGE_LIMIT_PATTERN =
  /usage\s+limit|usage_limit|rate\s+limit|credits?\s+(?:depleted|exhausted)/i;
const RESET_CLOCK_PATTERN = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)\b/i;
const RUNTIME_UPDATE_PATTERN =
  /requires? (?:a )?newer version|(?:cli|client|runtime|app)\s+(?:is\s+)?(?:out[ -]of[ -]date|too old)|(?:upgrade|update)\s+(?:to\s+)?(?:the\s+)?latest\s+(?:app|cli|client|runtime|version)/i;

export function isRuntimeUpdateRequired(message: string): boolean {
  return RUNTIME_UPDATE_PATTERN.test(message);
}

function localResetTime(value: string, baseline: number): number | undefined {
  const absolute = Date.parse(value);
  if (!Number.isNaN(absolute) && !/^\s*\d{1,2}(?::\d{2})?\s*[ap]m\s*$/i.test(value)) {
    return absolute;
  }

  const match = value.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m)$/i);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  if (hour < 1 || hour > 12 || minute > 59) return undefined;

  const candidate = new Date(baseline);
  const normalizedHour = (hour % 12) + (match[3].toLowerCase() === "pm" ? 12 : 0);
  candidate.setHours(normalizedHour, minute, 0, 0);
  if (candidate.getTime() <= baseline) candidate.setDate(candidate.getDate() + 1);
  return candidate.getTime();
}

/**
 * Finds the provider's local-clock reset time in a usage-limit message.
 * The baseline is the event timestamp so a reset that has already passed is
 * not incorrectly treated as tomorrow after a reload.
 */
export function usageResetAtFromMessage(message: string, occurredAt: string): number | undefined {
  if (!USAGE_LIMIT_PATTERN.test(message)) return undefined;
  const baseline = Date.parse(occurredAt);
  const match = message.match(RESET_CLOCK_PATTERN);
  return match
    ? localResetTime(match[0].slice(3), Number.isNaN(baseline) ? Date.now() : baseline)
    : undefined;
}

/**
 * Returns an expiry only for usage-limit notices. Other errors remain until
 * the user dismisses them because they do not have a safe automatic lifetime.
 */
export function composerNoticeExpiry(
  message: string,
  occurredAt: string,
  fallbackResetAt?: string,
): number | undefined {
  if (!USAGE_LIMIT_PATTERN.test(message)) return undefined;
  return (
    usageResetAtFromMessage(message, occurredAt) ??
    (fallbackResetAt
      ? localResetTime(fallbackResetAt, Date.parse(occurredAt) || Date.now())
      : undefined)
  );
}
