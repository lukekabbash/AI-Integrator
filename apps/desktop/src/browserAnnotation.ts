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
