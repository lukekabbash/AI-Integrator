import {
  attachmentKind,
  type ComposerDraftAttachment,
  type NativeProviderAction,
  type RuntimeConnection,
  type RuntimeId,
  type TaskSummary,
} from "../bridge";

export function normalizeRuntime(runtimes: RuntimeConnection[], desired: RuntimeId): RuntimeId {
  if (runtimes.length === 0) return desired;
  return runtimes.some((item) => item.id === desired) ? desired : (runtimes[0]?.id ?? "codex");
}

export interface AutocompleteToken {
  kind: "file" | "skill";
  query: string;
  /** Offset of the trigger character (@ or /) in the draft. */
  start: number;
}

/** Finds an @file or /skill token ending at the caret. `/` only triggers as
 * the very first character of the draft, like a slash command. */
export function activeAutocompleteToken(prompt: string, caret: number): AutocompleteToken | null {
  const before = prompt.slice(0, caret);
  const match = /(^|\s)([@/][^\s]*)$/.exec(before);
  if (!match) return null;
  const token = match[2];
  const start = caret - token.length;
  if (token.startsWith("@")) return { kind: "file", query: token.slice(1), start };
  if (start === 0) return { kind: "skill", query: token.slice(1), start };
  return null;
}

export interface AutocompleteMatch {
  value: string;
  label: string;
  detail: string;
  /** Distinguishes project files from folders in @-mention suggestions. */
  entry?: "file" | "folder";
  actionId?: string;
  kind?: NativeProviderAction["kind"];
  invocation?: NativeProviderAction["invocation"];
  chatTaskId?: string;
}

/** Folder structure derived from the flat project file list, so @-mention
 * suggestions can browse directories without a second backend call. */
export interface ContextIndex {
  fileSet: Set<string>;
  folderSet: Set<string>;
  /** Immediate children per folder path; the root is keyed by "". */
  children: Map<string, { folders: string[]; files: string[] }>;
}

export interface ComposerAttachment extends ComposerDraftAttachment {
  /** Project folders use the same compact context treatment as files, while
   * retaining a truthful folder icon. Picker attachments leave this unset. */
  entry?: "file" | "folder";
}

export function buildContextIndex(files: string[]): ContextIndex {
  const fileSet = new Set(files);
  const folderSet = new Set<string>();
  const raw = new Map<string, { folders: Set<string>; files: string[] }>();
  const childrenOf = (folder: string) => {
    let entry = raw.get(folder);
    if (!entry) {
      entry = { folders: new Set(), files: [] };
      raw.set(folder, entry);
    }
    return entry;
  };
  for (const path of files) {
    const segments = path.split("/").filter(Boolean);
    if (segments.length === 0) continue;
    let parent = "";
    for (let index = 0; index < segments.length - 1; index += 1) {
      const folder = parent ? `${parent}/${segments[index]}` : segments[index];
      folderSet.add(folder);
      childrenOf(parent).folders.add(folder);
      parent = folder;
    }
    childrenOf(parent).files.push(path);
  }
  const children = new Map<string, { folders: string[]; files: string[] }>();
  for (const [folder, entry] of raw) {
    children.set(folder, {
      folders: [...entry.folders].sort((a, b) => a.localeCompare(b)),
      files: entry.files.slice().sort((a, b) => a.localeCompare(b)),
    });
  }
  return { fileSet, folderSet, children };
}

export const CONTEXT_MATCH_LIMIT = 12;

function contextMatch(path: string, entry: "file" | "folder"): AutocompleteMatch {
  const name = path.split("/").at(-1) ?? path;
  return {
    value: path,
    label: entry === "folder" ? `${name}/` : name,
    detail: path.split("/").slice(0, -1).join("/"),
    entry,
  };
}

function nameRank(path: string, normalized: string): number {
  if (!normalized) return 0;
  const name = (path.split("/").at(-1) ?? "").toLocaleLowerCase();
  return name.startsWith(normalized) ? 0 : name.includes(normalized) ? 1 : -1;
}

/** Directory-first @-mention matching: an empty query or a query anchored to
 * an existing folder browses that folder (folders before files, like a file
 * tree); anything else fuzzy-ranks every folder and file in the project. */
export function matchContext(index: ContextIndex, query: string): AutocompleteMatch[] {
  const slash = query.lastIndexOf("/");
  const dir = slash >= 0 ? query.slice(0, slash) : "";
  const leaf = slash >= 0 ? query.slice(slash + 1) : query;
  const normalizedLeaf = leaf.toLocaleLowerCase();
  const browsing = slash < 0 ? query === "" : dir === "" || index.folderSet.has(dir);
  if (browsing) {
    const listing = index.children.get(dir) ?? { folders: [], files: [] };
    const pick = (paths: string[], entry: "file" | "folder") =>
      paths
        .map((path) => ({ path, rank: nameRank(path, normalizedLeaf) }))
        .filter((item) => item.rank >= 0)
        .sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path))
        .map((item) => contextMatch(item.path, entry));
    return [...pick(listing.folders, "folder"), ...pick(listing.files, "file")].slice(
      0,
      CONTEXT_MATCH_LIMIT,
    );
  }
  const normalizedQuery = query.toLocaleLowerCase();
  const rank = (path: string) => {
    const byName = nameRank(path, normalizedQuery);
    if (byName >= 0) return byName;
    return path.toLocaleLowerCase().includes(normalizedQuery) ? 2 : -1;
  };
  const candidates = [
    ...[...index.folderSet].map((path) => ({ path, entry: "folder" as const })),
    ...[...index.fileSet].map((path) => ({ path, entry: "file" as const })),
  ]
    .map((item) => ({ ...item, rank: rank(item.path) }))
    .filter((item) => item.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path));
  return candidates
    .slice(0, CONTEXT_MATCH_LIMIT)
    .map((item) => contextMatch(item.path, item.entry));
}

export function matchSkills(actions: NativeProviderAction[], query: string): AutocompleteMatch[] {
  const normalized = query.toLocaleLowerCase();
  return actions
    .filter(
      (action) =>
        !normalized ||
        action.name.toLocaleLowerCase().includes(normalized) ||
        action.description.toLocaleLowerCase().includes(normalized),
    )
    .slice(0, 40)
    .map((action) => ({
      value: action.name,
      label: `/${action.name}`,
      detail: `${action.source} · ${
        action.invocation === "interactiveOnly"
          ? "interactive provider terminal only"
          : action.description
      }`,
      actionId: action.id,
      kind: action.kind,
      invocation: action.invocation,
    }));
}

export function matchChats(chats: TaskSummary[], query: string): AutocompleteMatch[] {
  const normalized = query.trim().toLocaleLowerCase();
  return chats
    .filter((chat) => !normalized || chat.title.toLocaleLowerCase().includes(normalized))
    .slice(0, CONTEXT_MATCH_LIMIT)
    .map((chat) => ({
      value: chat.title,
      label: chat.title,
      detail: "Chat transcript",
      chatTaskId: chat.id,
    }));
}

const CODEX_GOAL_ACTION_ID = "builtin:codex:goal:v1";

export function leadingNativeActionName(prompt: string): string | undefined {
  return /^\/([^\s]+)(?=\s|$)/.exec(prompt)?.[1];
}

export function completedNativeAction(
  prompt: string,
  actions: NativeProviderAction[],
): NativeProviderAction | undefined {
  const token = leadingNativeActionName(prompt);
  if (!token) return undefined;
  return actions.find(
    (action) =>
      action.name === token && action.invocation === "direct" && action.id.trim().length > 0,
  );
}

export function codexGoalAction(
  prompt: string,
  runtime: RuntimeId,
): NativeProviderAction | undefined {
  if (runtime !== "codex" || leadingNativeActionName(prompt) !== "goal") return undefined;
  return {
    id: CODEX_GOAL_ACTION_ID,
    name: "goal",
    description: "Keep working until a completion condition is met",
    source: "built-in",
    kind: "command",
    invocation: "direct",
    inputHint: "completion condition",
  };
}

export interface DraftSegment {
  text: string;
  token?: "skill" | "mention";
}

/** Splits a draft into plain text and highlightable tokens: the verified
 * /skill prefix plus every @mention that names a real project file or folder
 * (folder mentions may carry a trailing slash). */
export function draftSegments(
  prompt: string,
  skillPrefix: string,
  index: ContextIndex,
): DraftSegment[] {
  const segments: DraftSegment[] = [];
  let offset = 0;
  if (skillPrefix && (prompt === skillPrefix || prompt.startsWith(`${skillPrefix} `))) {
    segments.push({ text: skillPrefix, token: "skill" });
    offset = skillPrefix.length;
  }
  const rest = prompt.slice(offset);
  const pattern = /(^|\s)(@[^\s]+)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(rest))) {
    const token = match[2].slice(1);
    const normalized = token.endsWith("/") ? token.slice(0, -1) : token;
    if (!index.fileSet.has(token) && !index.folderSet.has(normalized)) continue;
    const start = match.index + match[1].length;
    if (start > cursor) segments.push({ text: rest.slice(cursor, start) });
    segments.push({ text: match[2], token: "mention" });
    cursor = start + match[2].length;
  }
  if (cursor < rest.length || rest.length === 0) segments.push({ text: rest.slice(cursor) });
  return segments;
}

export function projectAttachment(path: string, entry: "file" | "folder"): ComposerAttachment {
  const attachmentPath = entry === "folder" && !path.endsWith("/") ? `${path}/` : path;
  const name = attachmentPath.split("/").filter(Boolean).at(-1) ?? attachmentPath;
  return {
    path: attachmentPath,
    name: entry === "folder" ? `${name}/` : name,
    kind: entry === "file" ? attachmentKind(name) : "file",
    entry,
  };
}

export function projectReference(token: string, index: ContextIndex): ComposerAttachment | null {
  if (index.fileSet.has(token)) return projectAttachment(token, "file");
  const folder = token.endsWith("/") ? token.slice(0, -1) : token;
  return index.folderSet.has(folder) ? projectAttachment(folder, "folder") : null;
}

/** Once a valid @reference is followed by whitespace it is committed as
 * context: the token leaves the prose draft and becomes a removable card. */
export function detachCommittedProjectReferences(
  prompt: string,
  index: ContextIndex,
): { prompt: string; attachments: ComposerAttachment[] } {
  const attachments: ComposerAttachment[] = [];
  let removedAtStart = false;
  const nextPrompt = prompt.replace(
    /(^|\s)@([^\s]+)(?=\s)/g,
    (match: string, _leading: string, token: string, offset: number) => {
      const attachment = projectReference(token, index);
      if (!attachment) return match;
      attachments.push(attachment);
      removedAtStart ||= offset === 0;
      return "";
    },
  );
  return {
    prompt: removedAtStart ? nextPrompt.replace(/^\s/, "") : nextPrompt,
    attachments,
  };
}

/** Selection cards from the same file are distinct per line range, while
 * whole-file references keep deduplicating by path alone. */
export function attachmentIdentity(attachment: ComposerAttachment): string {
  return attachment.selection
    ? `${attachment.path}#${attachment.selection.startLine ?? ""}-${attachment.selection.endLine ?? ""}`
    : attachment.path;
}

export function appendUniqueAttachments(
  current: ComposerAttachment[],
  additions: ComposerAttachment[],
): ComposerAttachment[] {
  const existing = new Set(current.map(attachmentIdentity));
  return [
    ...current,
    ...additions.filter((attachment) => {
      if (existing.has(attachmentIdentity(attachment))) return false;
      existing.add(attachmentIdentity(attachment));
      return true;
    }),
  ];
}

/** Collect image files from a paste event. Prefer `files` when present so we
 * do not double-count the same clipboard entry through `items`. */
export function clipboardImageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const fromFiles = [...data.files].filter((file) => file.type.startsWith("image/"));
  if (fromFiles.length > 0) return fromFiles;
  const fromItems: File[] = [];
  for (const item of data.items) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) fromItems.push(file);
  }
  return fromItems;
}
