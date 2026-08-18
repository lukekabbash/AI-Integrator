/**
 * Tool output often carries a screenshot as MCP image JSON or a data URL.
 * The transcript should show that picture, not the base64 it was stored as.
 */

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|bmp|avif|ico|svg)(?:\?|#|$)/i;
const DATA_URL_PREFIX = "data:image/";

export function isImageFileName(path: string): boolean {
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  return IMAGE_NAME.test(name);
}

export function outputLooksLikeImage(text: string): boolean {
  if (!text) return false;
  if (text.includes(DATA_URL_PREFIX)) return true;
  if (/"imagePath"\s*:/.test(text) || /"image_path"\s*:/.test(text)) return true;
  if (/"type"\s*:\s*"image"/.test(text) && (/"mimeType"/.test(text) || /"data"\s*:/.test(text))) {
    return true;
  }
  const compact = text.replace(/\s+/g, "");
  if (compact.startsWith("iVBORw0KGgo") && compact.length >= 64) return true;
  return isImageFileName(text.trim());
}

export interface ActivityMedia {
  text: string;
  images: string[];
  imagePaths: string[];
}

/** Pulls renderable pictures out of a tool's stored output and leaves the
 *  readable metadata (size, note, path) for the text block. */
export function extractActivityImages(raw: string): ActivityMedia {
  const images: string[] = [];
  const imagePaths: string[] = [];
  const seen = new Set<string>();
  const addImage = (src: string) => {
    const normalized = src.replace(/\s+/g, "");
    if (!isRenderableDataUrl(normalized) || seen.has(normalized)) return;
    seen.add(normalized);
    images.push(normalized);
  };
  const addPath = (path: string) => {
    const trimmed = path.trim();
    if (!trimmed || !isImageFileName(trimmed) || seen.has(trimmed)) return;
    seen.add(trimmed);
    imagePaths.push(trimmed);
  };

  const trimmed = raw.trim();
  if (!trimmed) return { text: "", images, imagePaths };

  try {
    const parsed: unknown = JSON.parse(trimmed);
    collectFromValue(parsed, addImage, addPath);
    return { text: displayJson(parsed), images, imagePaths };
  } catch {
    collectFromLooseText(trimmed, addImage, addPath);
    return { text: sanitizeLooseText(trimmed), images, imagePaths };
  }
}

function collectFromValue(
  value: unknown,
  addImage: (src: string) => void,
  addPath: (path: string) => void,
): void {
  if (typeof value === "string") {
    if (value.startsWith(DATA_URL_PREFIX)) addImage(value);
    else if (isImageFileName(value) && (value.includes("/") || value.includes("\\")))
      addPath(value);
    else if (looksLikePngBase64(value))
      addImage(`data:image/png;base64,${value.replace(/\s+/g, "")}`);
    else {
      const inner = tryParseJson(value);
      if (inner !== undefined) collectFromValue(inner, addImage, addPath);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectFromValue(entry, addImage, addPath);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  const mime =
    (typeof record.mimeType === "string" && record.mimeType) ||
    (typeof record.media_type === "string" && record.media_type) ||
    "image/png";
  const data = typeof record.data === "string" ? record.data : undefined;
  if (type === "image" && data) {
    addImage(
      data.startsWith(DATA_URL_PREFIX) ? data : `data:${mime};base64,${data.replace(/\s+/g, "")}`,
    );
  }
  if (typeof record.preview === "string") addImage(record.preview);
  if (typeof record.imagePath === "string") addPath(record.imagePath);
  if (typeof record.image_path === "string") addPath(record.image_path);
  for (const entry of Object.values(record)) collectFromValue(entry, addImage, addPath);
}

function collectFromLooseText(
  text: string,
  addImage: (src: string) => void,
  addPath: (path: string) => void,
): void {
  const dataUrls = text.match(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi) ?? [];
  for (const url of dataUrls) addImage(url);
  if (looksLikePngBase64(text)) addImage(`data:image/png;base64,${text.replace(/\s+/g, "")}`);
  collectQuotedImagePaths(text, addPath);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^[-*]\s*/, "");
    if (isImageFileName(trimmed)) addPath(trimmed);
  }
}

/** Recovers `imagePath` from pretty JSON, including a truncated Codex dump
 *  where the path is still sitting in the escaped opening text block. */
function collectQuotedImagePaths(text: string, addPath: (path: string) => void): void {
  const marker = /image_?path/gi;
  let found: RegExpExecArray | null;
  while ((found = marker.exec(text))) {
    const after = text.slice(found.index + found[0].length);
    const quoted = after.match(
      /^\s*\\*"\s*:\s*\\*"((?:\\.|[^"\\])*?\.(?:png|jpe?g|gif|webp|bmp|avif|ico|svg))/i,
    );
    if (!quoted) continue;
    let path = unescapeJsonString(quoted[1] ?? "");
    if (!isImageFileName(path)) path = unescapeJsonString(path);
    addPath(path);
  }
}

function unescapeJsonString(value: string): string {
  return value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\[\\/"bfnrt]/g, (token) => {
      switch (token) {
        case "\\\\":
          return "\\";
        case "\\/":
          return "/";
        case '\\"':
          return '"';
        case "\\b":
          return "\b";
        case "\\f":
          return "\f";
        case "\\n":
          return "\n";
        case "\\r":
          return "\r";
        case "\\t":
          return "\t";
        default:
          return token;
      }
    });
}

function displayJson(value: unknown): string {
  const cleaned = stripImagePayloads(value);
  const unwrapped = unwrapToolText(cleaned);
  if (typeof unwrapped === "string") return sanitizeLooseText(unwrapped);
  try {
    const pretty = JSON.stringify(unwrapped, null, 2);
    return sanitizeLooseText(pretty === "{}" || pretty === "[]" ? "" : pretty);
  } catch {
    return "";
  }
}

function unwrapToolText(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const content = record.content;
  if (!Array.isArray(content)) return value;
  const texts = content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const entry = block as Record<string, unknown>;
      return typeof entry.text === "string" ? entry.text : "";
    })
    .filter((text) => text.trim().length > 0);
  if (texts.length === 1) {
    const parsed = tryParseJson(texts[0]);
    return parsed !== undefined ? parsed : texts[0];
  }
  if (texts.length > 1) return texts.join("\n\n");
  return value;
}

function stripImagePayloads(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.startsWith(DATA_URL_PREFIX) || looksLikePngBase64(value)) return undefined;
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(stripImagePayloads).filter((entry) => entry !== undefined && entry !== null);
  }
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record.type === "image") return undefined;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key === "data" || key === "preview") {
      if (
        typeof entry === "string" &&
        (entry.startsWith(DATA_URL_PREFIX) || looksLikePngBase64(entry))
      ) {
        continue;
      }
    }
    const cleaned = stripImagePayloads(entry);
    if (cleaned !== undefined) next[key] = cleaned;
  }
  return next;
}

function sanitizeLooseText(text: string): string {
  return text
    .replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi, "")
    .replace(/iVBORw0KGgo[A-Za-z0-9+/=\s]{32,}/g, "")
    .replace(/\n\[truncated\]\s*$/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function looksLikePngBase64(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  return (
    compact.startsWith("iVBORw0KGgo") && compact.length >= 64 && !compact.includes("[truncated]")
  );
}

function isRenderableDataUrl(src: string): boolean {
  if (!src.startsWith(DATA_URL_PREFIX) || !src.includes(";base64,")) return false;
  const payload = src.slice(src.indexOf(",") + 1);
  if (payload.length < 32 || payload.includes("[truncated]")) return false;
  return /^[A-Za-z0-9+/=]+$/.test(payload);
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}
