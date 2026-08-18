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

/** The element name encoded in `Annotation · Sign in.png`. */
export function annotationAttachmentLabel(name: string): string {
  if (!isAnnotationAttachment(name)) return name;
  return name.slice(ANNOTATION_ATTACHMENT_PREFIX.length).replace(/\.png$/i, "");
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

/**
 * File names the composer should treat as this annotation's screenshot. The
 * crop is named from the page's accessible name, or the tag when that is
 * empty; the chip label uses the same fallback, written as `<tag>`.
 */
export function annotationImageNames(annotation: PendingAnnotation): string[] {
  const names = new Set([annotationAttachmentName(annotation.label)]);
  const tag = /^<([a-zA-Z0-9-]+)>$/.exec(annotation.label)?.[1];
  if (tag) names.add(annotationAttachmentName(tag));
  return [...names];
}

/**
 * Folds each annotation's screenshot into the annotation chip so the composer
 * shows one attachment, not a text chip beside a second image chip.
 */
export function pairAnnotationAttachments<T extends { name: string }>(
  annotations: PendingAnnotation[],
  attachments: T[],
): Map<number, T> {
  const pairs = new Map<number, T>();
  const used = new Set<T>();
  for (const annotation of annotations) {
    const names = new Set(annotationImageNames(annotation));
    const match = attachments.find((item) => !used.has(item) && names.has(item.name));
    if (!match) continue;
    pairs.set(annotation.id, match);
    used.add(match);
  }
  const leftoverAnnotations = annotations.filter((annotation) => !pairs.has(annotation.id));
  const leftoverImages = attachments.filter(
    (item) => isAnnotationAttachment(item.name) && !used.has(item),
  );
  if (leftoverAnnotations.length === 1 && leftoverImages.length === 1) {
    pairs.set(leftoverAnnotations[0].id, leftoverImages[0]);
  }
  return pairs;
}

export function isAnnotationBlock(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith(ANNOTATION_BLOCK_OPEN) && trimmed.endsWith(ANNOTATION_BLOCK_CLOSE);
}

/**
 * Pulls every annotation block out of a sent prompt so the transcript can
 * show a card instead of the markup the agent still receives.
 */
export function splitAnnotationBlocks(body: string): {
  text: string;
  annotations: PendingAnnotation[];
} {
  const annotations: PendingAnnotation[] = [];
  const pattern = new RegExp(`${ANNOTATION_BLOCK_OPEN}[\\s\\S]*?${ANNOTATION_BLOCK_CLOSE}`, "g");
  const text = body
    .replace(pattern, (raw) => {
      annotations.push(parseAnnotationBlock(raw, annotations.length + 1));
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, annotations };
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
