/**
 * Display helpers for model identifiers.
 *
 * Wire/API ids stay unchanged (`gpt-5.6-sol`, `grok-4.5`). These helpers only
 * produce human-facing labels for pickers, transcripts, and agent routes.
 * Prefer a provider-supplied display name when it is already distinct from the
 * wire id; otherwise pretty-print the slug.
 */

/** Brand-cased words for turning raw model ids into display labels. */
const MODEL_LABEL_WORDS: Record<string, string> = {
  gpt: "GPT",
  glm: "GLM",
  oss: "OSS",
  claude: "Claude",
  gemini: "Gemini",
  grok: "Grok",
  deepseek: "DeepSeek",
  codex: "Codex",
  composer: "Composer",
  cursor: "Cursor",
  sonnet: "Sonnet",
  haiku: "Haiku",
  opus: "Opus",
  fable: "Fable",
  flash: "Flash",
  pro: "Pro",
  mini: "mini",
  nano: "nano",
  build: "Build",
  auto: "Auto",
  small: "Small",
  large: "Large",
  thinking: "Thinking",
  luna: "Luna",
  sol: "Sol",
  terra: "Terra",
};

function isVersionToken(token: string): boolean {
  // 5, 5.6, 4.5, 0.1, v3.1, r1, 120b
  return /^(?:v?\d+(?:\.\d+)*[a-z]?|r\d+)$/i.test(token);
}

function prettyToken(token: string): string {
  const lower = token.toLowerCase();
  if (MODEL_LABEL_WORDS[lower]) return MODEL_LABEL_WORDS[lower];
  if (isVersionToken(token)) {
    if (/^r\d/i.test(token)) return token.toUpperCase();
    if (/^v\d/i.test(token)) return `V${token.slice(1)}`;
    return token.replace(/([a-zA-Z]+)$/, (letters) => letters.toUpperCase());
  }
  if (token.length === 0) return token;
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

/**
 * Turn a wire model id into a readable label.
 *
 * Examples:
 * - `gpt-5.6-sol` → `GPT-5.6 Sol`
 * - `grok-4.5` → `Grok 4.5`
 * - `claude-haiku-4-5` → `Claude Haiku 4.5`
 * - `composer-2.5` → `Composer 2.5`
 * Already-pretty names (`Gemini 3.1 Pro`, `GPT-5.4`) are left alone.
 */
export function prettyModelLabel(modelId?: string | null): string {
  if (!modelId || modelId === "Provider default") return "";

  // Cursor session catalogs bracket config onto the id; drop that for display.
  const plain = (modelId.split("[")[0] ?? modelId).trim();
  if (!plain) return "";

  // Provider display names and Antigravity ids already look human.
  if (/\s/.test(plain) || /[A-Z]/.test(plain)) return plain;

  const tokens = plain.split("-").filter(Boolean);
  if (tokens.length === 0) return plain;

  const first = tokens[0]!.toLowerCase();

  // GPT family: glue the version with a hyphen (GPT-5.6 Luna, GPT-OSS 120B).
  if (first === "gpt" && tokens.length >= 2) {
    const rest = tokens.slice(1);
    if (rest[0]!.toLowerCase() === "oss") {
      return ["GPT-OSS", ...rest.slice(1).map(prettyToken)].join(" ");
    }
    if (isVersionToken(rest[0]!)) {
      return [`GPT-${rest[0]}`, ...rest.slice(1).map(prettyToken)].join(" ");
    }
  }

  // Claude ids encode minor versions as trailing digit-digit (haiku-4-5 → 4.5).
  if (first === "claude" && tokens.length >= 3) {
    const last = tokens[tokens.length - 1]!;
    const secondLast = tokens[tokens.length - 2]!;
    if (/^\d{1,2}$/.test(last) && /^\d{1,2}$/.test(secondLast)) {
      const head = tokens.slice(0, -2).map(prettyToken);
      return [...head, `${secondLast}.${last}`].join(" ");
    }
  }

  return tokens.map(prettyToken).join(" ");
}

/**
 * Prefer a provider-supplied display name when it is already distinct from the
 * wire id; otherwise pretty-print the id for human UI.
 */
export function resolveModelLabel(id: string, providerLabel?: string | null): string {
  const supplied = typeof providerLabel === "string" ? providerLabel.trim() : "";
  if (supplied && supplied !== id) return supplied;
  return prettyModelLabel(id) || id;
}
