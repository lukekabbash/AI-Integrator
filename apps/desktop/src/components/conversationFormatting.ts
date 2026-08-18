import { splitAnnotationBlocks, type PendingAnnotation } from "../browserAnnotation";

export function formatCompactTokenCount(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(tokens < 10_000_000 ? 1 : 0)}m`;
}

/** Splits the trailing "Attached files:" block (written by the composer's +
 * attach flow) off a sent message so the transcript can render the paths as
 * inline previews instead of raw text. */
export function splitAttachmentBlock(body: string): { text: string; attachments: string[] } {
  const match = /(?:^|\n\n)Attached files:\n((?:- [^\n]+(?:\n|$))+)$/.exec(body);
  if (!match) return { text: body, attachments: [] };
  const attachments = match[1]
    .split("\n")
    .map((line) => line.replace(/^- /, "").trim())
    .filter(Boolean);
  return { text: body.slice(0, match.index).trimEnd(), attachments };
}

/** Strips the composer-authored attachment and annotation tails so the
 * transcript can render chips instead of the raw prompt the agent saw. */
export function splitSentUserMessage(body: string): {
  text: string;
  attachments: string[];
  annotations: PendingAnnotation[];
} {
  const { text: withoutAnnotations, annotations } = splitAnnotationBlocks(body);
  const { text, attachments } = splitAttachmentBlock(withoutAnnotations);
  return { text, attachments, annotations };
}

/** Finds the nearest ancestor (or self) of a selection endpoint matching
 * `selector` inside `container`. Text nodes hop to their parent element. */
export function selectionEndpointElement(
  node: Node,
  selector: string,
  container: HTMLElement,
): HTMLElement | null {
  const element = node instanceof HTMLElement ? node : node.parentElement;
  const match = element?.closest(selector) ?? null;
  return match && container.contains(match) ? (match as HTMLElement) : null;
}
