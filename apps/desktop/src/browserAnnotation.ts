/**
 * A browser annotation travels to the composer as an ordinary image
 * attachment, so the composer needs one honest way to recognise it and give it
 * its own chip. The name is that signal: both sides go through here rather
 * than repeating a literal that would silently drift apart.
 */

export const ANNOTATION_ATTACHMENT_PREFIX = "Annotation · ";

/** The attachment name for a marked-up element, e.g. `Annotation · Sign in.png`. */
export function annotationAttachmentName(label: string): string {
  // The page controls this label, so path separators and characters Windows
  // rejects are replaced before the name reaches a file. Trim last: a stripped
  // character at either end would otherwise leave a stray space.
  const safe = label
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${ANNOTATION_ATTACHMENT_PREFIX}${safe || "page"}.png`;
}

export function isAnnotationAttachment(name: string): boolean {
  return name.startsWith(ANNOTATION_ATTACHMENT_PREFIX);
}

export const ANNOTATION_BLOCK_OPEN = "<browser_annotation>";
const ANNOTATION_BLOCK_CLOSE = "</browser_annotation>";

/** One marked-up element waiting in the composer. */
export interface PendingAnnotation {
  id: number;
  /** The block sent to the agent, verbatim. */
  raw: string;
  /** What the chip says: the element, in the user's words. */
  label: string;
  /** Where it came from, e.g. `localhost:3773`. */
  origin: string;
  note: string;
}

export function isAnnotationBlock(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith(ANNOTATION_BLOCK_OPEN) && trimmed.endsWith(ANNOTATION_BLOCK_CLOSE);
}

/**
 * Reads the block back into something a chip can show. The block is authored
 * a few lines above this file, so this parses what we write rather than
 * guessing at arbitrary markup.
 */
export function parseAnnotationBlock(raw: string, id: number): PendingAnnotation {
  const line = (key: string) =>
    raw
      .split("\n")
      .find((entry) => entry.startsWith(`${key}:`))
      ?.slice(key.length + 1)
      .trim() ?? "";
  const element = line("Element");
  const named = /name="([^"]*)"/.exec(element)?.[1];
  const tag = /^<([a-zA-Z0-9-]+)>/.exec(element)?.[1];
  const url = line("URL");
  let origin = "";
  try {
    origin = url ? new URL(url).host : "";
  } catch {
    origin = url;
  }
  const noteIndex = raw.indexOf("\nNote:\n");
  const note =
    noteIndex === -1
      ? ""
      : raw
          .slice(noteIndex + "\nNote:\n".length)
          .replace(ANNOTATION_BLOCK_CLOSE, "")
          .trim();
  return {
    id,
    raw: raw.trim(),
    label: named || (tag ? `<${tag}>` : "") || line("Page") || "Page element",
    origin,
    note,
  };
}
