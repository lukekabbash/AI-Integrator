import type { ProjectFileEntry } from "../bridge";

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
