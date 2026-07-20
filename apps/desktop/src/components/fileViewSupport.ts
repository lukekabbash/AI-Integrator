import type { ProjectFileEntry } from "../bridge";

/** Matches `.file-code-editor` / `.file-reader-lines` `tab-size`. */
export const FILE_TAB_SIZE = 2;

export interface ProjectFileLocation {
  path: string;
  startLine?: number;
  endLine?: number;
}

const LINE_FRAGMENT = /^L([1-9]\d*)(?:-L([1-9]\d*))?$/;
const LINE_SUFFIX = /:([1-9]\d*)(?:-([1-9]\d*))?$/;

/** Parses only explicit local Markdown destinations. Web URLs and ambiguous
 * prose stay ordinary links; the host still resolves the path against the
 * active project's enumerated files before reading anything. */
export function parseProjectFileHref(href: string): ProjectFileLocation | undefined {
  const hashIndex = href.indexOf("#");
  const rawPath = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  const fragment = hashIndex >= 0 ? href.slice(hashIndex + 1) : "";
  const explicitLocalPath = rawPath.startsWith("./") || rawPath.startsWith("/");
  if (!explicitLocalPath) return undefined;

  let path = rawPath.startsWith("./") ? rawPath.slice(2) : rawPath;
  let startLine: number | undefined;
  let endLine: number | undefined;
  if (fragment) {
    const match = LINE_FRAGMENT.exec(fragment);
    if (!match) return undefined;
    startLine = Number(match[1]);
    endLine = match[2] ? Number(match[2]) : startLine;
  } else {
    const match = LINE_SUFFIX.exec(path);
    if (match) {
      path = path.slice(0, match.index);
      startLine = Number(match[1]);
      endLine = match[2] ? Number(match[2]) : startLine;
    }
  }

  const normalizedPath = path.replace(/\\/g, "/");
  const segments = normalizedPath.split("/").filter(Boolean);
  if (
    !segments.length ||
    segments.some((segment) => segment === "." || segment === "..") ||
    (startLine !== undefined && endLine !== undefined && endLine < startLine)
  ) {
    return undefined;
  }
  return { path: normalizedPath, startLine, endLine };
}

/** Transcript tool events may carry absolute or "./"-prefixed paths while the
 * project tree is root-relative; resolve by exact match first, then by the
 * longest tree path the requested path ends with. */
export function resolveRequestedFile(
  files: ProjectFileEntry[],
  requestedPath: string,
): ProjectFileEntry | undefined {
  const normalize = (path: string) => path.replace(/\\/g, "/").replace(/^\.\//, "");
  const requested = normalize(requestedPath);
  let suffixMatch: ProjectFileEntry | undefined;
  let suffixMatchLength = 0;
  for (const file of files) {
    const candidate = normalize(file.path);
    if (candidate === requested) return file;
    if (requested.endsWith(`/${candidate}`) && candidate.length > suffixMatchLength) {
      suffixMatch = file;
      suffixMatchLength = candidate.length;
    }
  }
  return suffixMatch;
}

/** Leading indent width in columns, expanding tabs to `tabSize`. */
export function leadingIndentColumns(line: string, tabSize = FILE_TAB_SIZE): number {
  let columns = 0;
  for (const character of line) {
    if (character === " ") {
      columns += 1;
      continue;
    }
    if (character === "\t") {
      columns += tabSize - (columns % tabSize);
      continue;
    }
    break;
  }
  return columns;
}

/** How many vertical indent guides a line should paint (one per indent stop). */
export function indentGuideCount(line: string, tabSize = FILE_TAB_SIZE): number {
  return Math.floor(leadingIndentColumns(line, tabSize) / tabSize);
}

/**
 * Per-line guide counts for a full buffer. Blank / whitespace-only lines carry
 * the previous content line's count so vertical guides stay continuous instead
 * of breaking into dashed gaps.
 */
export function indentGuideCountsForLines(
  lines: readonly string[],
  tabSize = FILE_TAB_SIZE,
): number[] {
  const counts = lines.map((line) => indentGuideCount(line, tabSize));
  let carry = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === "") {
      counts[index] = carry;
      continue;
    }
    carry = counts[index];
  }
  return counts;
}
