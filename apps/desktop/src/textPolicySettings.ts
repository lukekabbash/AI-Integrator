/** Stored keys for how generated prose should read. */
export const TEXT_POLICY_SETTING = "text.policy";
/** The body of the `custom` policy. */
export const TEXT_POLICY_CUSTOM = "text.customPolicy";
/** Per-generator override map; an absent entry inherits the shared policy. */
export const TEXT_POLICY_OVERRIDES = "text.policyByGenerator";

export type TextPolicyId = "default" | "conventional" | "repository" | "custom";
export type TextGeneratorId = "commitMessage" | "chatTitle";

export interface TextPolicyOption {
  id: TextPolicyId;
  label: string;
  description: string;
}

/**
 * Unset means "match this repository", because that is the answer almost every
 * time — and with no usable history the native side degrades to the plain
 * voice, so a fresh clone is never worse off than having no policy at all.
 */
export const DEFAULT_TEXT_POLICY: TextPolicyId = "repository";

/** Long enough for a house style, short enough to leave the prompt room. */
export const CUSTOM_POLICY_MAX_CHARS = 1000;

export const TEXT_POLICIES: TextPolicyOption[] = [
  {
    id: "repository",
    label: "Match this repository",
    description: "Follow the voice of recent commit subjects in the open repository.",
  },
  {
    id: "default",
    label: "Plain",
    description: "Imperative, no ceremony, no prefixes.",
  },
  {
    id: "conventional",
    label: "Conventional Commits",
    description: "type(scope): summary, using the conventional type set.",
  },
  {
    id: "custom",
    label: "Custom",
    description: "Describe the house style in your own words.",
  },
];

export interface ResolvedTextPolicy {
  id: TextPolicyId;
  /** The sanitized custom body; empty unless `id` is `custom`. */
  custom: string;
}

function isPolicyId(value: unknown): value is TextPolicyId {
  return (
    value === "default" || value === "conventional" || value === "repository" || value === "custom"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Mirrors Rust's `char::is_control`, which the native sanitizer filters on. */
function withoutControlCharacters(line: string): string {
  return [...line]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);
    })
    .join("");
}

/**
 * A custom policy is quoted as content in the prompt, so the only thing that
 * can go wrong is a body that closes its own quotation. Drop the marker lines,
 * keep control characters out, and bound the length. The native side repeats
 * this, so a value stored by an older build cannot smuggle a marker through.
 */
export function normalizeCustomPolicy(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .split("\n")
    .filter((line) => {
      const bare = line.trim().toUpperCase();
      return bare !== "CUSTOM STYLE" && bare !== "END CUSTOM STYLE";
    })
    .map((line) => withoutControlCharacters(line).trimEnd())
    .join("\n")
    .trim()
    .slice(0, CUSTOM_POLICY_MAX_CHARS);
}

/** The id one generator is set to, or null when it inherits the shared policy. */
export function textPolicyOverride(
  settings: Record<string, unknown>,
  generator: TextGeneratorId,
): TextPolicyId | null {
  const overrides = settings[TEXT_POLICY_OVERRIDES];
  if (!isRecord(overrides)) return null;
  const stored = overrides[generator];
  return isPolicyId(stored) ? stored : null;
}

/**
 * How one generator should write, resolved the same way the native
 * `text_policy::resolve_policy` resolves it: an override wins over the shared
 * policy, an unrecognized id falls back to the default, and `custom` without a
 * body falls back rather than shipping an empty style block.
 */
export function resolveTextPolicy(
  settings: Record<string, unknown>,
  generator: TextGeneratorId,
): ResolvedTextPolicy {
  const shared = settings[TEXT_POLICY_SETTING];
  const id =
    textPolicyOverride(settings, generator) ?? (isPolicyId(shared) ? shared : DEFAULT_TEXT_POLICY);
  if (id !== "custom") return { id, custom: "" };
  const custom = normalizeCustomPolicy(settings[TEXT_POLICY_CUSTOM]);
  return custom ? { id, custom } : { id: DEFAULT_TEXT_POLICY, custom: "" };
}

/**
 * The override map with one generator set, or cleared back to inheriting.
 * Returned as a fresh object so the caller can hand it straight to the setting
 * write without mutating what the UI is still rendering.
 */
export function withTextPolicyOverride(
  settings: Record<string, unknown>,
  generator: TextGeneratorId,
  id: TextPolicyId | null,
): Record<string, TextPolicyId> {
  const overrides = settings[TEXT_POLICY_OVERRIDES];
  const next: Record<string, TextPolicyId> = {};
  if (isRecord(overrides)) {
    for (const [key, value] of Object.entries(overrides)) {
      if (isPolicyId(value)) next[key] = value;
    }
  }
  if (id) next[generator] = id;
  else delete next[generator];
  return next;
}
