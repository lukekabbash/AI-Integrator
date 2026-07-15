import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, m as motion } from "motion/react";
import {
  ArrowUp,
  Compass,
  Folder,
  Gauge,
  Mic,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Users,
  X,
} from "lucide-react";
import { FileIcon } from "./FileIcon";
import {
  attachmentKind,
  bridge,
  persistableComposerAttachment,
  PROVIDER_DEFAULT_MODEL,
  resolveModelEffort,
  type ComposerDraftAttachment,
  type ComposerDraftValue,
  type ModeProjection,
  type ModelCatalogEntry,
  type NativeActionReference,
  type NativeProviderAction,
  type RuntimeConnection,
  type RuntimeId,
} from "../bridge";
import type { ComposerNotice } from "../composerNotices";
import type { RuntimeRouteDefaults } from "../routingDefaults";
import { Dropdown, ProviderIcon } from "./Dropdown";
import { appendVoiceSegment, insertVoiceText, type VoiceInsertAnchor } from "./voiceTyping";

interface ComposerProps {
  runtimes: RuntimeConnection[];
  defaultRuntime: RuntimeId;
  defaultModel: string;
  /** Settings-provided reasoning effort, applied when the model supports it. */
  defaultEffort?: string;
  /** Preferred model and effort recalled when the user switches runtimes. */
  runtimeDefaults?: RuntimeRouteDefaults;
  /** Settings-provided permission profile preselected for new chats. */
  defaultPermission?: "read-only" | "project-write" | "ask" | "full-access";
  /** Settings-provided delegation mode preselected for new chats. */
  defaultDelegation?: "off" | "manual" | "balanced" | "budget-first";
  /** When false, plain Enter inserts a newline and Ctrl/Cmd+Enter sends. */
  enterToSend?: boolean;
  /** Memory-first state restored before this composer mounts. */
  initialDraft?: ComposerDraftValue;
  /** Runs after paint; owners persist it without putting storage on the input path. */
  onDraftChange?: (value: ComposerDraftValue) => void;
  /** Synchronously snapshots the exact submitted envelope and returns its durable revision. */
  onDraftSubmit?: (value: ComposerDraftValue) => number;
  onSend: (value: {
    prompt: string;
    draftPrompt: string;
    attachments: ComposerDraftAttachment[];
    runtime: RuntimeId;
    model: string;
    effort?: string;
    permission: "read-only" | "project-write" | "ask" | "full-access";
    delegation: "off" | "manual" | "balanced" | "budget-first";
    nativeActionId?: string;
    nativeAction?: NativeActionReference;
    draftRevision?: number;
  }) => Promise<boolean>;
  /** Canonical trusted repository/worktree used for provider-native discovery. */
  workingDirectory?: string;
  /** Persist provider/model/effort for an existing chat as soon as the user changes them. */
  onRoutingChange?: (value: { runtime: RuntimeId; model: string; effort?: string }) => void;
  /** Fires immediately when the user switches the permission profile, even mid-run. */
  onPermissionChange?: (permission: "read-only" | "project-write" | "ask" | "full-access") => void;
  /** Live session mode state for providers that advertise modes (e.g. Cursor
   * Agent/Plan/Ask). Absent hides the mode picker. */
  sessionModes?: ModeProjection;
  /** Fires when the user picks a session mode; applies immediately, even mid-run. */
  onSessionModeChange?: (modeId: string) => void;
  /** External permission set-request (e.g. the agent left plan mode). A new
   * id applies `value` to the permission picker, mirroring the session. */
  permissionRequest?: {
    id: string;
    value: "read-only" | "project-write" | "ask" | "full-access";
  } | null;
  /** Project-relative file paths offered by the @-mention autocomplete. */
  contextFiles?: string[];
  /** Requests the bounded project scan the first time an @-token is typed,
   * so mention suggestions work before the Files tab has ever been opened.
   * Owners keep this idempotent and cached. */
  onRequestContextFiles?: () => void;
  /** External text insertion (e.g. right-click → add file as context). A new
   * id inserts `text` at the caret of the current draft. */
  insertRequest?: { id: number; text: string } | null;
  /** Confirms an insert request was applied so the owner can clear it. */
  onInsertHandled?: (id: number) => void;
  /** Host-driven context cards (e.g. a highlighted selection from a file). */
  attachmentRequest?: { id: number; attachment: ComposerDraftAttachment } | null;
  onAttachmentHandled?: (id: number) => void;
  /** Replaces the current draft with a queued message selected for editing. */
  restoreRequest?: { id: number; value: ComposerDraftValue } | null;
  onRestoreHandled?: (id: number) => void;
  /** Blocking or actionable runtime feedback docked immediately above the composer. */
  notices?: ComposerNotice[];
  /** True while the active task's turn is in progress; swaps send for stop. */
  running?: boolean;
  /** True once a stop has been requested and is still settling. */
  stopping?: boolean;
  /** Stops the in-progress turn from the send position. */
  onStop?: () => void;
  /** Keeps provider/model/effort visible but immutable until the active turn settles. */
  routingDisabled?: boolean;
  permissionDisabled?: boolean;
  delegationDisabled?: boolean;
  /** Distinguishes simultaneous main/child composers for assistive technology. */
  messageLabel?: string;
  sendLabel?: string;
}

interface VoiceCapture {
  context: AudioContext;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  sink: GainNode;
}

function normalizeRuntime(runtimes: RuntimeConnection[], desired: RuntimeId): RuntimeId {
  if (runtimes.length === 0) return desired;
  return runtimes.some((item) => item.id === desired) ? desired : (runtimes[0]?.id ?? "codex");
}

type VoicePhase = "idle" | "starting" | "recording" | "stopping";

interface AutocompleteToken {
  kind: "file" | "skill";
  query: string;
  /** Offset of the trigger character (@ or /) in the draft. */
  start: number;
}

/** Finds an @file or /skill token ending at the caret. `/` only triggers as
 * the very first character of the draft, like a slash command. */
function activeAutocompleteToken(prompt: string, caret: number): AutocompleteToken | null {
  const before = prompt.slice(0, caret);
  const match = /(^|\s)([@/][^\s]*)$/.exec(before);
  if (!match) return null;
  const token = match[2];
  const start = caret - token.length;
  if (token.startsWith("@")) return { kind: "file", query: token.slice(1), start };
  if (start === 0) return { kind: "skill", query: token.slice(1), start };
  return null;
}

interface AutocompleteMatch {
  value: string;
  label: string;
  detail: string;
  /** Distinguishes project files from folders in @-mention suggestions. */
  entry?: "file" | "folder";
  actionId?: string;
  kind?: NativeProviderAction["kind"];
  invocation?: NativeProviderAction["invocation"];
}

/** Folder structure derived from the flat project file list, so @-mention
 * suggestions can browse directories without a second backend call. */
interface ContextIndex {
  fileSet: Set<string>;
  folderSet: Set<string>;
  /** Immediate children per folder path; the root is keyed by "". */
  children: Map<string, { folders: string[]; files: string[] }>;
}

interface ComposerAttachment extends ComposerDraftAttachment {
  /** Project folders use the same compact context treatment as files, while
   * retaining a truthful folder icon. Picker attachments leave this unset. */
  entry?: "file" | "folder";
}

function buildContextIndex(files: string[]): ContextIndex {
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

const CONTEXT_MATCH_LIMIT = 12;

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
function matchContext(index: ContextIndex, query: string): AutocompleteMatch[] {
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

function matchSkills(actions: NativeProviderAction[], query: string): AutocompleteMatch[] {
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

function completedNativeAction(
  prompt: string,
  actions: NativeProviderAction[],
): NativeProviderAction | undefined {
  const token = /^\/([^\s]+)(?=\s|$)/.exec(prompt)?.[1];
  if (!token) return undefined;
  return actions.find(
    (action) =>
      action.name === token && action.invocation === "direct" && action.id.trim().length > 0,
  );
}

export interface DraftSegment {
  text: string;
  token?: "skill" | "mention";
}

/** Splits a draft into plain text and highlightable tokens: the verified
 * /skill prefix plus every @mention that names a real project file or folder
 * (folder mentions may carry a trailing slash). */
// eslint-disable-next-line react-refresh/only-export-components
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

function projectAttachment(path: string, entry: "file" | "folder"): ComposerAttachment {
  const attachmentPath = entry === "folder" && !path.endsWith("/") ? `${path}/` : path;
  const name = attachmentPath.split("/").filter(Boolean).at(-1) ?? attachmentPath;
  return {
    path: attachmentPath,
    name: entry === "folder" ? `${name}/` : name,
    kind: entry === "file" ? attachmentKind(name) : "file",
    entry,
  };
}

function projectReference(token: string, index: ContextIndex): ComposerAttachment | null {
  if (index.fileSet.has(token)) return projectAttachment(token, "file");
  const folder = token.endsWith("/") ? token.slice(0, -1) : token;
  return index.folderSet.has(folder) ? projectAttachment(folder, "folder") : null;
}

/** Once a valid @reference is followed by whitespace it is committed as
 * context: the token leaves the prose draft and becomes a removable card. */
function detachCommittedProjectReferences(
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
function attachmentIdentity(attachment: ComposerAttachment): string {
  return attachment.selection
    ? `${attachment.path}#${attachment.selection.startLine ?? ""}-${attachment.selection.endLine ?? ""}`
    : attachment.path;
}

function appendUniqueAttachments(
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

function encodePcm16(samples: Float32Array, sourceRate: number): number[] {
  const targetRate = 24000;
  const outputLength = Math.max(1, Math.round((samples.length * targetRate) / sourceRate));
  const bytes = new Array<number>(outputLength * 2);
  for (let index = 0; index < outputLength; index += 1) {
    const start = Math.floor((index * sourceRate) / targetRate);
    const end = Math.min(
      samples.length,
      Math.max(start + 1, Math.floor(((index + 1) * sourceRate) / targetRate)),
    );
    let sum = 0;
    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) sum += samples[sampleIndex];
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    const pcm = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    const rounded = Math.round(pcm);
    bytes[index * 2] = rounded & 0xff;
    bytes[index * 2 + 1] = (rounded >> 8) & 0xff;
  }
  return bytes;
}

export function Composer({
  runtimes,
  defaultRuntime,
  defaultModel,
  defaultEffort,
  runtimeDefaults,
  defaultPermission,
  defaultDelegation,
  enterToSend = true,
  initialDraft,
  onDraftChange,
  onDraftSubmit,
  onSend,
  workingDirectory,
  onRoutingChange,
  onPermissionChange,
  sessionModes,
  onSessionModeChange,
  permissionRequest = null,
  contextFiles = [],
  onRequestContextFiles,
  insertRequest = null,
  onInsertHandled,
  attachmentRequest = null,
  onAttachmentHandled,
  restoreRequest = null,
  onRestoreHandled,
  notices = [],
  running = false,
  stopping = false,
  onStop,
  routingDisabled = false,
  permissionDisabled = false,
  delegationDisabled = false,
  messageLabel = "Task message",
  sendLabel = "Send message",
}: ComposerProps) {
  const [prompt, setPrompt] = useState(initialDraft?.prompt ?? "");
  const [caret, setCaret] = useState(initialDraft?.selectionStart ?? 0);
  // Highlight is stored with the token key it belongs to, so a new token (or
  // a different query under it) derives back to the top match without effects.
  const [autocompleteHighlight, setAutocompleteHighlight] = useState<{
    key: string;
    index: number;
  }>({ key: "", index: 0 });
  const [dismissedTokenKey, setDismissedTokenKey] = useState("");
  const [runtime, setRuntime] = useState<RuntimeId>(() =>
    normalizeRuntime(runtimes, initialDraft?.runtime ?? defaultRuntime),
  );
  const [model, setModel] = useState(initialDraft?.model ?? defaultModel);
  const [effort, setEffort] = useState<string | undefined>(initialDraft?.effort ?? defaultEffort);
  const [permission, setPermission] = useState<
    "read-only" | "project-write" | "ask" | "full-access"
  >(initialDraft?.permission ?? defaultPermission ?? "project-write");
  // Agent-driven permission changes (e.g. an approved plan exit) override
  // the picker even after the user touched it — the session already moved.
  // Applied once per request id with the adjust-state-during-render pattern.
  const [appliedPermissionRequestId, setAppliedPermissionRequestId] = useState("");
  if (permissionRequest && permissionRequest.id !== appliedPermissionRequestId) {
    setAppliedPermissionRequestId(permissionRequest.id);
    setPermission(permissionRequest.value);
  }
  const [delegation, setDelegation] = useState<"off" | "manual" | "balanced" | "budget-first">(
    runtime === "antigravity" || runtime === "custom"
      ? "off"
      : (initialDraft?.delegation ?? defaultDelegation ?? "off"),
  );
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(
    () => initialDraft?.attachments ?? [],
  );
  const [attachmentError, setAttachmentError] = useState("");
  const [providerCatalogs, setProviderCatalogs] = useState<Record<string, ModelCatalogEntry[]>>({});
  const providerCatalogLoads = useRef(new Set<RuntimeId>());
  const [nativeActionsByKey, setNativeActionsByKey] = useState<
    Record<string, NativeProviderAction[]>
  >({});
  const [nativeActionsError, setNativeActionsError] = useState("");
  const [nativeActionsLoadingKey, setNativeActionsLoadingKey] = useState("");
  const [nativeActionRetry, setNativeActionRetry] = useState(0);
  const nativeActionLoads = useRef(new Set<string>());
  const composerTextMirrorRef = useRef<HTMLDivElement>(null);
  const [voiceConfigured, setVoiceConfigured] = useState<boolean | null>(null);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>("idle");
  const [voiceError, setVoiceError] = useState("");
  const [voiceNotice, setVoiceNotice] = useState("");
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [micDeviceId, setMicDeviceId] = useState("default");
  const [controlsMenuOpen, setControlsMenuOpen] = useState(false);
  const [controlsSubmenu, setControlsSubmenu] = useState<
    "mode" | "permission" | "delegation" | null
  >(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const controlsMenuRef = useRef<HTMLDivElement>(null);
  const controlsMenuButtonRef = useRef<HTMLButtonElement>(null);
  const voiceCaptureRef = useRef<VoiceCapture | null>(null);
  const voiceAppendQueueRef = useRef(Promise.resolve());
  const voiceBaseRef = useRef("");
  const voiceAnchorRef = useRef<VoiceInsertAnchor>({ start: 0, end: 0 });
  const voiceCommittedTranscriptRef = useRef("");
  const voiceLiveTranscriptRef = useRef("");
  const voiceSessionActiveRef = useRef(false);
  const voiceNoticeTimerRef = useRef<number | undefined>(undefined);
  const [dismissedNoticeIds, setDismissedNoticeIds] = useState<Set<string>>(new Set());
  const [noticeClock, setNoticeClock] = useState(() => Date.now());
  /** Once the user picks any routing value, settings defaults stop syncing. */
  const routingTouched = useRef(Boolean(initialDraft));
  const draftEmissionReadyRef = useRef(false);
  const draftTouchedRef = useRef(false);
  const suppressDraftEmissionRef = useRef(false);
  const onDraftChangeRef = useRef(onDraftChange);
  const selectedRuntime = runtimes.find((item) => item.id === runtime) ?? runtimes[0];
  const catalogLoaded = Object.hasOwn(providerCatalogs, runtime);
  const runtimeCatalog =
    selectedRuntime?.models
      .filter((id) => id !== PROVIDER_DEFAULT_MODEL)
      .map((id) => ({ id, label: id })) ?? [];
  const catalog = (providerCatalogs[runtime] ?? runtimeCatalog).filter(
    (entry) => entry.id !== PROVIDER_DEFAULT_MODEL,
  );
  const activeEntry = catalog.find((entry) => entry.id === model) ?? catalog[0];
  const activeModel = activeEntry?.id ?? (model || PROVIDER_DEFAULT_MODEL);
  const modelOptions =
    catalog.length > 0
      ? catalog.map((entry) => ({ value: entry.id, label: entry.label }))
      : [
          {
            value: activeModel,
            label: catalogLoaded ? activeModel : "Checking model…",
            disabled: true,
          },
        ];
  const effortOptions = activeEntry?.efforts ?? [];
  const activeEffort = resolveModelEffort(activeEntry, effort);
  const preferredRuntimeEffort = runtimeDefaults?.[runtime]?.effort ?? defaultEffort;
  const delegationAvailable = runtime !== "antigravity" && runtime !== "custom";
  const delegationControlDisabled = delegationDisabled || !delegationAvailable;
  const effectiveDelegation = delegationAvailable ? delegation : "off";
  const draftValue = useMemo<ComposerDraftValue>(
    () => ({
      prompt,
      attachments: attachments.map(persistableComposerAttachment),
      runtime,
      model: activeModel,
      effort,
      permission,
      delegation: effectiveDelegation,
      selectionStart: caret,
      selectionEnd: caret,
    }),
    [activeModel, attachments, caret, effectiveDelegation, effort, permission, prompt, runtime],
  );
  const visibleNotices = notices.filter(
    (notice) =>
      !dismissedNoticeIds.has(notice.id) &&
      (notice.expiresAt === undefined || notice.expiresAt > noticeClock),
  );
  const voiceRecording = voicePhase === "recording";
  const voiceActive = voicePhase !== "idle";
  const motionDisabled =
    typeof document !== "undefined" &&
    (document.documentElement.dataset.motion === "none" ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  const draftPresent = Boolean(prompt.trim()) || attachments.length > 0;

  useEffect(() => {
    onDraftChangeRef.current = onDraftChange;
  }, [onDraftChange]);

  useEffect(() => {
    if (!draftEmissionReadyRef.current) {
      draftEmissionReadyRef.current = true;
      if (!draftTouchedRef.current) return;
    }
    if (suppressDraftEmissionRef.current) {
      if (!draftValue.prompt && draftValue.attachments.length === 0) return;
      suppressDraftEmissionRef.current = false;
    }
    if (!draftTouchedRef.current && !draftValue.prompt && draftValue.attachments.length === 0) {
      return;
    }
    onDraftChangeRef.current?.(draftValue);
  }, [draftValue]);

  useEffect(() => {
    if (!initialDraft) return;
    const frame = window.requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(
        initialDraft.selectionStart,
        initialDraft.selectionEnd,
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [initialDraft]);

  useEffect(() => {
    if (!controlsMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!controlsMenuRef.current?.contains(event.target as Node)) {
        setControlsMenuOpen(false);
        setControlsSubmenu(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setControlsMenuOpen(false);
      setControlsSubmenu(null);
      controlsMenuButtonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [controlsMenuOpen]);

  const autocompleteToken = activeAutocompleteToken(prompt, caret);
  const contextIndex = useMemo(() => buildContextIndex(contextFiles), [contextFiles]);
  const wantsContextFiles = autocompleteToken?.kind === "file";
  useEffect(() => {
    if (wantsContextFiles) onRequestContextFiles?.();
  }, [onRequestContextFiles, wantsContextFiles]);
  const nativeActionKey = workingDirectory ? `${runtime}\u0000${workingDirectory}` : "";
  const nativeActions = nativeActionsByKey[nativeActionKey] ?? [];
  const activeNativeAction = completedNativeAction(prompt, nativeActions);
  const activeNativeSkill = activeNativeAction?.kind === "skill" ? activeNativeAction : undefined;
  const activeNativeSkillPrefix = activeNativeSkill ? `/${activeNativeSkill.name}` : "";
  // The mirror renders behind the transparent-text textarea whenever the
  // draft holds at least one highlightable token (/skill or valid @mention).
  const mirrorSegments = useMemo(
    () => draftSegments(prompt, activeNativeSkillPrefix, contextIndex),
    [activeNativeSkillPrefix, contextIndex, prompt],
  );
  const mirrorActive = mirrorSegments.some((segment) => segment.token);
  useEffect(() => {
    if (!workingDirectory || !nativeActionKey) return;
    if (nativeActionsByKey[nativeActionKey] || nativeActionLoads.current.has(nativeActionKey)) {
      return;
    }
    let cancelled = false;
    nativeActionLoads.current.add(nativeActionKey);
    setNativeActionsLoadingKey(nativeActionKey);
    setNativeActionsError("");
    void bridge
      .listNativeProviderActions(runtime, workingDirectory)
      .then((actions) => {
        if (!cancelled) {
          setNativeActionsByKey((current) => ({ ...current, [nativeActionKey]: actions }));
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setNativeActionsError(
            error instanceof Error ? error.message : "Could not load provider skills",
          );
        }
      })
      .finally(() => {
        nativeActionLoads.current.delete(nativeActionKey);
        if (!cancelled) setNativeActionsLoadingKey("");
      });
    return () => {
      cancelled = true;
    };
  }, [nativeActionKey, nativeActionRetry, nativeActionsByKey, runtime, workingDirectory]);
  const autocompleteMatches = useMemo(
    () =>
      !autocompleteToken
        ? []
        : autocompleteToken.kind === "file"
          ? matchContext(contextIndex, autocompleteToken.query)
          : matchSkills(nativeActions, autocompleteToken.query),
    [autocompleteToken?.kind, autocompleteToken?.query, contextIndex, nativeActions], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Dismissal (Escape) sticks to the trigger position; the highlight resets
  // whenever the query under that trigger changes.
  const autocompleteTokenKey = autocompleteToken
    ? `${autocompleteToken.kind}:${autocompleteToken.start}`
    : "";
  const autocompleteHighlightKey = autocompleteToken
    ? `${autocompleteTokenKey}:${autocompleteToken.query}`
    : "";
  const skillStatusVisible =
    autocompleteToken?.kind === "skill" &&
    (nativeActionsLoadingKey === nativeActionKey || Boolean(nativeActionsError));
  const autocompleteOpen =
    (autocompleteMatches.length > 0 || skillStatusVisible) &&
    dismissedTokenKey !== autocompleteTokenKey;
  const highlightedIndex =
    autocompleteMatches.length === 0
      ? 0
      : Math.min(
          autocompleteHighlight.key === autocompleteHighlightKey ? autocompleteHighlight.index : 0,
          autocompleteMatches.length - 1,
        );
  const setHighlightedIndex = (index: number) => {
    setAutocompleteHighlight({
      key: autocompleteHighlightKey,
      index: Math.max(0, Math.min(index, autocompleteMatches.length - 1)),
    });
  };

  /** Marks a manual draft edit as the new voice baseline so programmatic
   * insertions cooperate with an in-flight dictation session. */
  const resetVoiceBaseline = (nextPrompt: string, position: number) => {
    if (!voiceActive) return;
    voiceBaseRef.current = nextPrompt;
    voiceCommittedTranscriptRef.current = "";
    voiceLiveTranscriptRef.current = "";
    voiceAnchorRef.current = { start: position, end: position };
  };

  const addAttachments = async () => {
    const pick = bridge.pickContextAttachments;
    if (!pick) return;
    setAttachmentError("");
    try {
      const picked = await pick();
      if (!picked?.length) return;
      draftTouchedRef.current = true;
      setAttachments((current) => appendUniqueAttachments(current, picked));
    } catch (error) {
      setAttachmentError(
        error instanceof Error ? error.message : "Could not attach files from this computer.",
      );
    } finally {
      textareaRef.current?.focus();
    }
  };

  const acceptAutocomplete = (match: AutocompleteMatch) => {
    const token = autocompleteToken;
    if (!token) return;
    if (token.kind === "skill" && match.invocation === "interactiveOnly") return;
    draftTouchedRef.current = true;
    if (token.kind === "file" && match.entry === "file") {
      const attachment = projectAttachment(match.value, "file");
      const before = prompt.slice(0, token.start);
      let after = prompt.slice(caret);
      if ((!before || /\s$/.test(before)) && /^\s/.test(after)) after = after.slice(1);
      const next = before + after;
      const position = before.length;
      setAttachments((current) => appendUniqueAttachments(current, [attachment]));
      setPrompt(next);
      setCaret(position);
      resetVoiceBaseline(next, position);
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        textarea?.focus();
        textarea?.setSelectionRange(position, position);
      });
      return;
    }
    // Folder mentions insert without a trailing space so the token stays
    // active and the popup drills into the folder; a typed space finalizes it.
    const insert =
      token.kind === "file"
        ? match.entry === "folder"
          ? `@${match.value}/`
          : `@${match.value} `
        : `/${match.value} `;
    const next = prompt.slice(0, token.start) + insert + prompt.slice(caret);
    const position = token.start + insert.length;
    setPrompt(next);
    setCaret(position);
    resetVoiceBaseline(next, position);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      textarea?.focus();
      textarea?.setSelectionRange(position, position);
    });
  };

  // Applies host-driven insertions (right-click → add file as chat context).
  const lastInsertIdRef = useRef(0);
  useEffect(() => {
    if (!insertRequest || insertRequest.id === lastInsertIdRef.current) return;
    draftTouchedRef.current = true;
    lastInsertIdRef.current = insertRequest.id;
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? prompt.length;
    const end = textarea?.selectionEnd ?? start;
    const exactReference = /^@([^\s]+)\s*$/.exec(insertRequest.text)?.[1];
    const attachment = exactReference ? projectReference(exactReference, contextIndex) : null;
    if (attachment) {
      queueMicrotask(() => {
        setAttachments((current) => appendUniqueAttachments(current, [attachment]));
      });
      onInsertHandled?.(insertRequest.id);
      textarea?.focus();
      return;
    }
    const before = prompt.slice(0, start);
    const lead = before && !/\s$/.test(before) ? " " : "";
    const text = lead + insertRequest.text;
    const next = before + text + prompt.slice(end);
    const position = start + text.length;
    setPrompt(next);
    setCaret(position);
    resetVoiceBaseline(next, position);
    onInsertHandled?.(insertRequest.id);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(position, position);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- consumes the request exactly once per id
  }, [insertRequest]);

  // Applies host-driven context cards (a highlighted selection sent from the
  // file canvas). The card is removable like any picker attachment.
  const lastAttachmentIdRef = useRef(0);
  useEffect(() => {
    if (!attachmentRequest || attachmentRequest.id === lastAttachmentIdRef.current) return;
    draftTouchedRef.current = true;
    lastAttachmentIdRef.current = attachmentRequest.id;
    setAttachments((current) => appendUniqueAttachments(current, [attachmentRequest.attachment]));
    onAttachmentHandled?.(attachmentRequest.id);
    requestAnimationFrame(() => textareaRef.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- consumes the request exactly once per id
  }, [attachmentRequest]);

  const lastRestoreIdRef = useRef(0);
  useEffect(() => {
    if (!restoreRequest || restoreRequest.id === lastRestoreIdRef.current) return;
    lastRestoreIdRef.current = restoreRequest.id;
    const value = restoreRequest.value;
    const position = value.selectionEnd;
    draftTouchedRef.current = true;
    suppressDraftEmissionRef.current = true;
    setPrompt(value.prompt);
    setAttachments(value.attachments);
    const restoredRuntime = normalizeRuntime(runtimes, value.runtime);
    setRuntime(restoredRuntime);
    setModel(value.model);
    setEffort(value.effort);
    setPermission(value.permission);
    setDelegation(
      restoredRuntime === "antigravity" || restoredRuntime === "custom" ? "off" : value.delegation,
    );
    setCaret(position);
    resetVoiceBaseline(value.prompt, position);
    queueMicrotask(() => {
      suppressDraftEmissionRef.current = false;
    });
    onRestoreHandled?.(restoreRequest.id);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(value.selectionStart, value.selectionEnd);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- consumes the request exactly once per id
  }, [restoreRequest]);

  // Grow the textarea with its content (up to the CSS max-height) instead of
  // scrolling a fixed two-row box.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 170)}px`;
  }, [prompt]);

  useEffect(() => {
    const timeout = notices.reduce<number | undefined>((soonest, notice) => {
      if (dismissedNoticeIds.has(notice.id) || notice.expiresAt === undefined) return soonest;
      if (soonest === undefined || notice.expiresAt < soonest) return notice.expiresAt;
      return soonest;
    }, undefined);
    if (timeout === undefined) return;
    const delay = Math.max(0, timeout - Date.now());
    const timer = window.setTimeout(() => setNoticeClock(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [dismissedNoticeIds, notices]);

  const emitRoutingChange = (
    nextRuntime: RuntimeId,
    nextModel: string,
    nextEffort: string | undefined,
  ) => {
    onRoutingChange?.({
      runtime: nextRuntime,
      model: nextModel,
      effort: nextEffort,
    });
  };

  // Settings defaults load after the composer mounts on a cold start; keep
  // untouched pickers in sync so persisted defaults actually take effect.
  useEffect(() => {
    if (routingTouched.current) return;
    const nextRuntime = normalizeRuntime(runtimes, defaultRuntime);
    setRuntime(nextRuntime);
    setModel(defaultModel);
    setPermission(defaultPermission ?? "project-write");
    setEffort(defaultEffort);
  }, [defaultRuntime, defaultModel, defaultPermission, defaultEffort, runtimes]);

  useEffect(() => {
    let active = true;
    const getCredentialStatus = bridge.getVoiceTypingCredentialStatus;
    if (getCredentialStatus) {
      void getCredentialStatus()
        .then((status) => {
          if (active) setVoiceConfigured(status.configured);
        })
        .catch(() => {
          if (active) setVoiceConfigured(false);
        });
    }
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    const subscribeVoiceTyping = bridge.subscribeVoiceTyping;
    if (!subscribeVoiceTyping) {
      return () => {
        active = false;
      };
    }
    void subscribeVoiceTyping((event) => {
      if (!active || !voiceSessionActiveRef.current) return;
      if (event.kind === "error") {
        setVoiceError(event.text);
        return;
      }
      if (event.kind === "completed") {
        // A completed event contains the full current utterance, while delta
        // events contain fragments of that same utterance. Keep the committed
        // utterances separate so a new utterance cannot erase earlier words or
        // duplicate its own deltas.
        const completedText = event.text || voiceLiveTranscriptRef.current;
        voiceCommittedTranscriptRef.current = appendVoiceSegment(
          voiceCommittedTranscriptRef.current,
          completedText,
        );
        voiceLiveTranscriptRef.current = "";
      } else {
        voiceLiveTranscriptRef.current += event.text;
      }
      const transcript = appendVoiceSegment(
        voiceCommittedTranscriptRef.current,
        voiceLiveTranscriptRef.current,
      );
      setPrompt(insertVoiceText(voiceBaseRef.current, transcript, voiceAnchorRef.current));
    })
      .then((cleanup) => {
        if (active) unsubscribe = cleanup;
        else cleanup();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  // Device labels are only exposed once microphone permission is granted, so
  // re-enumerate when recording starts as well as on hardware changes.
  useEffect(() => {
    const mediaDevices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    if (!mediaDevices?.enumerateDevices) return;
    let active = true;
    const refresh = () => {
      void mediaDevices
        .enumerateDevices()
        .then((devices) => {
          if (active) setMicDevices(devices.filter((device) => device.kind === "audioinput"));
        })
        .catch(() => undefined);
    };
    refresh();
    mediaDevices.addEventListener?.("devicechange", refresh);
    return () => {
      active = false;
      mediaDevices.removeEventListener?.("devicechange", refresh);
    };
  }, [voiceRecording]);

  const releaseVoiceCapture = useCallback(async () => {
    const capture = voiceCaptureRef.current;
    voiceCaptureRef.current = null;
    if (capture) {
      capture.processor.onaudioprocess = null;
      capture.source.disconnect();
      capture.processor.disconnect();
      capture.sink.disconnect();
      capture.stream.getTracks().forEach((track) => track.stop());
      await capture.context.close().catch(() => undefined);
    }
  }, []);

  const stopVoiceTyping = useCallback(async () => {
    if (!voiceActive) return;
    // Clearing the session flag first also aborts a startup still in flight,
    // so a second click on the mic always shuts voice typing off.
    voiceSessionActiveRef.current = false;
    setVoicePhase("stopping");
    await releaseVoiceCapture();
    await voiceAppendQueueRef.current.catch(() => undefined);
    voiceAppendQueueRef.current = Promise.resolve();
    try {
      if (bridge.stopVoiceTyping) await bridge.stopVoiceTyping();
      setVoiceError("");
      setVoiceNotice("Voice text kept in the draft.");
      if (voiceNoticeTimerRef.current !== undefined) {
        window.clearTimeout(voiceNoticeTimerRef.current);
      }
      voiceNoticeTimerRef.current = window.setTimeout(() => {
        setVoiceNotice("");
        voiceNoticeTimerRef.current = undefined;
      }, 4500);
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : "Could not stop voice typing.");
    } finally {
      setVoicePhase("idle");
    }
  }, [releaseVoiceCapture, voiceActive]);

  useEffect(() => {
    if (!voiceRecording) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void stopVoiceTyping();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [stopVoiceTyping, voiceRecording]);

  const startVoiceTyping = async () => {
    if (voicePhase !== "idle") return;
    if (!voiceConfigured) {
      setVoiceError("Add your OpenAI API key in Settings → General to enable voice typing.");
      return;
    }
    if (typeof window === "undefined" || !window.AudioContext || !navigator.mediaDevices) {
      setVoiceError("This desktop environment does not provide microphone capture.");
      return;
    }
    if (!bridge.startVoiceTyping || !bridge.appendVoiceTypingPcm) {
      setVoiceError("Voice typing is unavailable in this app build.");
      return;
    }
    setVoicePhase("starting");
    setVoiceError("");
    setVoiceNotice("");
    voiceBaseRef.current = prompt;
    voiceCommittedTranscriptRef.current = "";
    voiceLiveTranscriptRef.current = "";
    const start = textareaRef.current?.selectionStart ?? prompt.length;
    const end = textareaRef.current?.selectionEnd ?? start;
    voiceAnchorRef.current = { start, end };
    voiceSessionActiveRef.current = true;
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          ...(micDeviceId !== "default" ? { deviceId: { exact: micDeviceId } } : {}),
        },
      });
      if (!voiceSessionActiveRef.current) {
        // The mic was clicked again while permission was pending; abort.
        stream.getTracks().forEach((track) => track.stop());
        setVoicePhase("idle");
        return;
      }
      context = new AudioContext({ sampleRate: 24000 });
      await context.resume();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const sink = context.createGain();
      sink.gain.value = 0;
      source.connect(processor);
      processor.connect(sink);
      sink.connect(context.destination);
      await bridge.startVoiceTyping();
      if (!voiceSessionActiveRef.current) {
        // Cancelled during backend startup; unwind instead of recording.
        stream.getTracks().forEach((track) => track.stop());
        await context.close().catch(() => undefined);
        if (bridge.stopVoiceTyping) await bridge.stopVoiceTyping().catch(() => undefined);
        setVoicePhase("idle");
        return;
      }
      let chunkCount = 0;
      let sawSignal = false;
      processor.onaudioprocess = (event) => {
        const samples = event.inputBuffer.getChannelData(0);
        chunkCount += 1;
        if (!sawSignal) {
          for (let index = 0; index < samples.length; index += 1) {
            if (Math.abs(samples[index]) > 0.001) {
              sawSignal = true;
              break;
            }
          }
        }
        const bytes = encodePcm16(samples, context?.sampleRate ?? 24000);
        voiceAppendQueueRef.current = voiceAppendQueueRef.current
          .catch(() => undefined)
          .then(() => bridge.appendVoiceTypingPcm!(bytes))
          .catch((error) => {
            setVoiceError(
              error instanceof Error ? error.message : "Could not send microphone audio.",
            );
          });
      };
      // Capture can fail silently: the audio graph never ticks, or the track
      // delivers only digital silence (wrong device, OS-level mic privacy
      // block). Surface both instead of leaving a mute session running.
      window.setTimeout(() => {
        if (!voiceSessionActiveRef.current) return;
        if (chunkCount === 0) {
          setVoiceError(
            "The microphone is not producing audio. Check Windows microphone privacy settings and the selected device.",
          );
        } else if (!sawSignal) {
          setVoiceError(
            "Only silence is coming from the microphone. Try a different device from the mic dropdown.",
          );
        }
      }, 3000);
      voiceCaptureRef.current = { context, stream, source, processor, sink };
      setVoicePhase("recording");
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      await context?.close().catch(() => undefined);
      if (bridge.stopVoiceTyping) await bridge.stopVoiceTyping().catch(() => undefined);
      voiceSessionActiveRef.current = false;
      setVoiceError(error instanceof Error ? error.message : "Could not start voice typing.");
      setVoicePhase("idle");
    } finally {
      // The phase is the source of truth for the button and status copy.
    }
  };

  useEffect(
    () => () => {
      const capture = voiceCaptureRef.current;
      voiceCaptureRef.current = null;
      if (capture) {
        capture.processor.onaudioprocess = null;
        capture.source.disconnect();
        capture.processor.disconnect();
        capture.sink.disconnect();
        capture.stream.getTracks().forEach((track) => track.stop());
        void capture.context.close().catch(() => undefined);
      }
      voiceSessionActiveRef.current = false;
      if (voiceNoticeTimerRef.current !== undefined) {
        window.clearTimeout(voiceNoticeTimerRef.current);
      }
      if (bridge.stopVoiceTyping) void bridge.stopVoiceTyping().catch(() => undefined);
    },
    [],
  );

  const loadProviderCatalog = useCallback(
    (targetRuntime: RuntimeId) => {
      if (providerCatalogs[targetRuntime] || providerCatalogLoads.current.has(targetRuntime))
        return;
      providerCatalogLoads.current.add(targetRuntime);
      void bridge
        .listModelCatalog?.(targetRuntime)
        .then((entries) => {
          setProviderCatalogs((current) => ({
            ...current,
            [targetRuntime]: (entries ?? []).filter((entry) => entry.id !== PROVIDER_DEFAULT_MODEL),
          }));
        })
        .catch(() => undefined)
        .finally(() => providerCatalogLoads.current.delete(targetRuntime));
    },
    [providerCatalogs],
  );

  useEffect(() => {
    loadProviderCatalog(runtime);
  }, [loadProviderCatalog, runtime]);

  // A saved model can belong to a different runtime (for example after an
  // imported settings file or a runtime change from an older build). Once the
  // provider catalog resolves, select its first advertised model so the
  // default route is a real, sendable route rather than a stale id.
  useEffect(() => {
    const resolvedCatalog = providerCatalogs[runtime];
    if (!resolvedCatalog?.length || resolvedCatalog.some((entry) => entry.id === model)) return;
    const nextEntry = resolvedCatalog[0];
    if (!nextEntry) return;
    const nextEffort = resolveModelEffort(nextEntry, preferredRuntimeEffort);
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setModel(nextEntry.id);
      setEffort(nextEffort);
      onRoutingChange?.({
        runtime,
        model: nextEntry.id,
        effort: nextEntry.efforts?.length ? nextEffort : undefined,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [model, onRoutingChange, preferredRuntimeEffort, providerCatalogs, runtime]);

  const submit = async () => {
    const trimmed = prompt.trim();
    if ((!trimmed && attachments.length === 0) || !activeModel || sending) return;
    const submittedDraft = trimmed;
    const submittedAttachments = attachments;
    // Picker attachments and committed @references share one plain-text
    // context block. Providers retain the same path context, while the
    // transcript can re-render the same compact cards after sending.
    // Selection cards additionally quote their highlighted lines so the
    // provider sees the exact snippet without re-reading the file.
    const selectionRange = (attachment: ComposerAttachment): string => {
      const selection = attachment.selection;
      if (!selection?.startLine) return "";
      return selection.endLine && selection.endLine !== selection.startLine
        ? ` (lines ${selection.startLine}-${selection.endLine})`
        : ` (line ${selection.startLine})`;
    };
    const selectionBlocks = attachments
      .filter((attachment) => attachment.selection?.text)
      .map((attachment) => {
        const text = attachment.selection?.text ?? "";
        const fence = text.includes("```") ? "````" : "```";
        return `Selected from ${attachment.path}${selectionRange(attachment)}:\n${fence}\n${text}\n${fence}`;
      });
    const attachmentBlock =
      attachments.length > 0
        ? [
            `Attached files:\n${attachments
              .map((attachment) => `- ${attachment.path}${selectionRange(attachment)}`)
              .join("\n")}`,
            ...selectionBlocks,
          ].join("\n\n")
        : "";
    const outgoing = trimmed
      ? attachmentBlock
        ? `${trimmed}\n\n${attachmentBlock}`
        : trimmed
      : attachmentBlock;
    const nativeAction = completedNativeAction(trimmed, nativeActions);
    const nativeActionId = nativeAction?.id;
    const draftRevision = onDraftSubmit?.(draftValue);
    setSending(true);
    // Clear immediately so the composer feels like a send action, not a
    // request that is waiting on provider/session startup. A rejected send
    // puts this exact draft back below.
    suppressDraftEmissionRef.current = true;
    setPrompt("");
    setAttachments([]);
    const restoreDraft = () => {
      setPrompt((current) => (current.trim() ? current : submittedDraft));
      setAttachments((current) => (current.length > 0 ? current : submittedAttachments));
    };
    try {
      const accepted = await onSend({
        prompt: outgoing,
        draftPrompt: submittedDraft,
        attachments: submittedAttachments.map(persistableComposerAttachment),
        runtime,
        model: activeModel,
        effort: effortOptions.length > 0 ? activeEffort : undefined,
        permission,
        delegation: effectiveDelegation,
        ...(nativeActionId ? { nativeActionId } : {}),
        ...(nativeAction
          ? { nativeAction: { name: nativeAction.name, kind: nativeAction.kind } }
          : {}),
        ...(draftRevision !== undefined ? { draftRevision } : {}),
      });
      suppressDraftEmissionRef.current = false;
      if (accepted === false) {
        restoreDraft();
      } else {
        if (composerTextMirrorRef.current) composerTextMirrorRef.current.scrollTop = 0;
      }
      textareaRef.current?.focus();
    } catch {
      suppressDraftEmissionRef.current = false;
      restoreDraft();
    } finally {
      setSending(false);
    }
  };

  const changePermission = (next: string) => {
    draftTouchedRef.current = true;
    routingTouched.current = true;
    setPermission(next as typeof permission);
    onPermissionChange?.(next as typeof permission);
  };

  const changeDelegation = (next: string) => {
    draftTouchedRef.current = true;
    setDelegation(next as typeof delegation);
  };

  const changeEffort = (next: string) => {
    draftTouchedRef.current = true;
    routingTouched.current = true;
    setEffort(next);
    emitRoutingChange(runtime, activeModel, next);
  };

  const permissionOptions = [
    { value: "read-only", label: "Read only" },
    { value: "project-write", label: "Project write" },
    { value: "ask", label: "Ask as needed" },
    { value: "full-access", label: "Full access" },
  ];
  const delegationOptions = [
    { value: "off", label: "No delegation" },
    { value: "manual", label: "Manual" },
    { value: "balanced", label: "Balanced delegation" },
    { value: "budget-first", label: "Budget first" },
  ];
  const microphoneOptions = [
    { value: "default", label: "Default mic" },
    ...micDevices
      .filter((device) => device.deviceId && device.deviceId !== "default")
      .map((device, index) => ({
        value: device.deviceId,
        label: device.label || `Microphone ${index + 1}`,
      })),
  ];
  const modeOptions =
    sessionModes?.availableModes.map((mode) => ({ value: mode.id, label: mode.name })) ?? [];
  const compactControlOptions =
    controlsSubmenu === "mode"
      ? modeOptions
      : controlsSubmenu === "permission"
        ? permissionOptions
        : delegationOptions;
  const compactControlValue =
    controlsSubmenu === "mode"
      ? sessionModes?.currentModeId
      : controlsSubmenu === "permission"
        ? permission
        : effectiveDelegation;
  const chooseCompactControl = (value: string) => {
    if (controlsSubmenu === "mode") onSessionModeChange?.(value);
    if (controlsSubmenu === "permission") changePermission(value);
    if (controlsSubmenu === "delegation") changeDelegation(value);
    setControlsSubmenu(null);
    setControlsMenuOpen(false);
    controlsMenuButtonRef.current?.focus();
  };

  return (
    <div className="composer-wrap">
      {visibleNotices.length > 0 ? (
        <div className="composer-notices" aria-label="Composer notices">
          {visibleNotices.map((notice) => (
            <aside
              className={`composer-notice composer-notice--${notice.variant}`}
              key={notice.id}
              role="alert"
            >
              <div className="composer-notice-heading">
                <strong>{notice.title}</strong>
                <button
                  className="composer-notice-dismiss"
                  type="button"
                  aria-label={`Dismiss ${notice.title}`}
                  title="Dismiss notice"
                  onClick={() =>
                    setDismissedNoticeIds((current) => new Set(current).add(notice.id))
                  }
                >
                  <X aria-hidden="true" />
                </button>
              </div>
              <p>{notice.message}</p>
              {notice.action ? (
                <button
                  className="composer-notice-action"
                  type="button"
                  onClick={notice.action.onSelect}
                >
                  {notice.action.label}
                </button>
              ) : null}
            </aside>
          ))}
        </div>
      ) : null}
      <div className="composer" data-busy={sending}>
        <AnimatePresence>
          {autocompleteOpen ? (
            <motion.div
              className="composer-autocomplete"
              role="listbox"
              aria-label={
                autocompleteToken?.kind === "file" ? "File suggestions" : "Skill suggestions"
              }
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.12, ease: "easeOut" }}
            >
              <p className="composer-autocomplete-hint">
                {autocompleteToken?.kind === "file"
                  ? "Project files & folders · ↑↓ to choose · Enter inserts, folders drill in · Esc to dismiss"
                  : "Provider native · ↑↓ to choose · Enter to insert · Esc to dismiss"}
              </p>
              {autocompleteMatches.length === 0 && skillStatusVisible ? (
                <p
                  className="composer-autocomplete-status"
                  role={nativeActionsError ? "alert" : "status"}
                >
                  {nativeActionsError || "Loading native skills…"}
                </p>
              ) : null}
              {autocompleteMatches.map((match, index) => (
                <button
                  key={match.actionId ?? `${match.value}:${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === highlightedIndex}
                  aria-disabled={match.invocation === "interactiveOnly"}
                  data-active={index === highlightedIndex}
                  data-disabled={match.invocation === "interactiveOnly" || undefined}
                  title={
                    match.invocation === "interactiveOnly"
                      ? "Open this provider's interactive terminal to use this action"
                      : undefined
                  }
                  // Keep focus in the textarea so accepting never blurs the draft.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  onClick={() => acceptAutocomplete(match)}
                >
                  {autocompleteToken?.kind === "file" ? (
                    match.entry === "folder" ? (
                      <Folder aria-hidden="true" />
                    ) : (
                      <FileIcon fileName={match.value} />
                    )
                  ) : null}
                  <span className="autocomplete-token">{match.label}</span>
                  {match.detail ? <small>{match.detail}</small> : null}
                </button>
              ))}
            </motion.div>
          ) : null}
        </AnimatePresence>
        <div className="composer-editor">
          {mirrorActive ? (
            <div
              ref={composerTextMirrorRef}
              className="composer-text-mirror"
              aria-hidden="true"
              data-native-skill={activeNativeSkill?.name}
            >
              {mirrorSegments.map((segment, index) =>
                segment.token ? (
                  <strong
                    key={`${segment.text}-${index}`}
                    className={
                      segment.token === "skill" ? "native-skill-token" : "context-mention-token"
                    }
                  >
                    {segment.text}
                  </strong>
                ) : (
                  segment.text
                ),
              )}
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            className={mirrorActive ? "composer-textarea--mirrored" : undefined}
            value={prompt}
            onScroll={(event) => {
              if (composerTextMirrorRef.current) {
                composerTextMirrorRef.current.scrollTop = event.currentTarget.scrollTop;
                composerTextMirrorRef.current.scrollLeft = event.currentTarget.scrollLeft;
              }
            }}
            onChange={(event) => {
              draftTouchedRef.current = true;
              const nextPrompt = event.target.value;
              const nextCaret = event.target.selectionStart;
              if (nextPrompt.startsWith("/") && !prompt.startsWith("/") && nativeActionsError) {
                setNativeActionRetry((current) => current + 1);
              }
              const detached = detachCommittedProjectReferences(nextPrompt, contextIndex);
              const detachedPrefix = detachCommittedProjectReferences(
                nextPrompt.slice(0, nextCaret),
                contextIndex,
              );
              const committedPrompt = detached.prompt;
              const committedCaret = detachedPrefix.prompt.length;
              if (detached.attachments.length > 0) {
                setAttachments((current) => appendUniqueAttachments(current, detached.attachments));
              }
              if (voiceActive) {
                // Treat a manual edit as the new draft baseline. This keeps
                // typed text and already-transcribed words intact instead of
                // rebuilding the textarea from the old pre-recording value.
                voiceBaseRef.current = committedPrompt;
                voiceCommittedTranscriptRef.current = "";
                voiceLiveTranscriptRef.current = "";
                voiceAnchorRef.current = {
                  start: committedCaret,
                  end: committedCaret,
                };
              }
              setPrompt(committedPrompt);
              setCaret(committedCaret);
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onKeyDown={(event) => {
              if (autocompleteOpen) {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDismissedTokenKey(autocompleteTokenKey);
                  return;
                }
                if (autocompleteMatches.length === 0) return;
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setHighlightedIndex(highlightedIndex + 1);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setHighlightedIndex(highlightedIndex - 1);
                  return;
                }
                if (
                  event.key === "Tab" ||
                  (event.key === "Enter" &&
                    !event.ctrlKey &&
                    !event.metaKey &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing)
                ) {
                  event.preventDefault();
                  acceptAutocomplete(autocompleteMatches[highlightedIndex]);
                  return;
                }
              }
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              // Ctrl/Cmd+Enter always sends; plain Enter follows the setting.
              if (event.ctrlKey || event.metaKey || (enterToSend && !event.shiftKey)) {
                event.preventDefault();
                void submit();
              }
            }}
            rows={2}
            placeholder="Ask, build, review… use / for skills and @ for context"
            aria-label={messageLabel}
            autoFocus
          />
        </div>
        {attachments.length > 0 || attachmentError ? (
          <div className="composer-attachments" aria-label="Attached context">
            {attachments.map((attachment) => (
              <div
                className={`composer-attachment${
                  attachment.dataUrl ? " composer-attachment--image" : ""
                }`}
                key={attachmentIdentity(attachment)}
                title={attachment.path}
              >
                {attachment.dataUrl ? (
                  <img src={attachment.dataUrl} alt={attachment.name} />
                ) : attachment.entry === "folder" ? (
                  <Folder className="file-type-icon" aria-hidden="true" />
                ) : (
                  <FileIcon fileName={attachment.name} />
                )}
                <span>{attachment.name}</span>
                <button
                  className="composer-attachment-remove"
                  type="button"
                  aria-label={`Remove ${attachment.name}`}
                  title="Remove attachment"
                  onClick={() => {
                    draftTouchedRef.current = true;
                    setAttachments((current) =>
                      current.filter(
                        (item) => attachmentIdentity(item) !== attachmentIdentity(attachment),
                      ),
                    );
                  }}
                >
                  <X aria-hidden="true" />
                </button>
              </div>
            ))}
            {attachmentError ? (
              <p className="composer-attachment-error" role="alert">
                {attachmentError}
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="composer-control-row">
          <div className="composer-controls-left">
            {bridge.pickContextAttachments ? (
              <button
                className="icon-button subtle composer-attach"
                type="button"
                onClick={() => void addAttachments()}
                aria-label="Attach files or images from your computer"
                title="Attach files or images as context"
              >
                <Plus aria-hidden="true" />
              </button>
            ) : null}
            <div className="composer-controls-optional">
              {sessionModes && sessionModes.availableModes.length > 1 ? (
                <Dropdown
                  className="compact-select mode-select"
                  aria-label="Agent mode"
                  leading={<Compass />}
                  value={sessionModes.currentModeId}
                  onChange={(next) => onSessionModeChange?.(next)}
                  options={modeOptions}
                  compact
                />
              ) : null}
              <Dropdown
                className="compact-select"
                aria-label="Permission"
                disabled={permissionDisabled}
                leading={<ShieldCheck />}
                value={permission}
                onChange={changePermission}
                options={permissionOptions}
                compact
              />
              <Dropdown
                className="compact-select"
                aria-label={
                  delegationAvailable ? "Delegation" : "Delegation unavailable for this runtime"
                }
                disabled={delegationControlDisabled}
                leading={<Users />}
                value={effectiveDelegation}
                onChange={changeDelegation}
                options={delegationOptions}
                compact
              />
            </div>
            <div className="composer-overflow-controls" ref={controlsMenuRef}>
              <button
                ref={controlsMenuButtonRef}
                className="dropdown-trigger composer-overflow-trigger"
                type="button"
                aria-label="More composer controls"
                title="Mode, permission, delegation"
                aria-haspopup="menu"
                aria-expanded={controlsMenuOpen}
                onClick={() => {
                  setControlsSubmenu(null);
                  setControlsMenuOpen((open) => !open);
                }}
              >
                <SlidersHorizontal aria-hidden="true" />
              </button>
              <AnimatePresence>
                {controlsMenuOpen ? (
                  <motion.div
                    className="composer-overflow-menu"
                    role="menu"
                    aria-label="Composer controls"
                    initial={{ opacity: 0, y: 5, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 4, scale: 0.98 }}
                    transition={{ duration: 0.14, ease: [0.2, 0, 0, 1] }}
                  >
                    {sessionModes && modeOptions.length > 1 ? (
                      <button
                        className="composer-overflow-row"
                        type="button"
                        role="menuitem"
                        aria-haspopup="menu"
                        aria-expanded={controlsSubmenu === "mode"}
                        onPointerEnter={() => setControlsSubmenu("mode")}
                        onFocus={() => setControlsSubmenu("mode")}
                        onClick={() => setControlsSubmenu("mode")}
                        onKeyDown={(event) => {
                          if (event.key === "ArrowRight") setControlsSubmenu("mode");
                        }}
                      >
                        <span>Mode</span>
                        <small>
                          {modeOptions.find((option) => option.value === sessionModes.currentModeId)
                            ?.label ?? sessionModes.currentModeId}
                        </small>
                      </button>
                    ) : null}
                    <button
                      className="composer-overflow-row"
                      type="button"
                      role="menuitem"
                      aria-haspopup="menu"
                      aria-expanded={controlsSubmenu === "permission"}
                      disabled={permissionDisabled}
                      onPointerEnter={() => setControlsSubmenu("permission")}
                      onFocus={() => setControlsSubmenu("permission")}
                      onClick={() => setControlsSubmenu("permission")}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowRight") setControlsSubmenu("permission");
                      }}
                    >
                      <span>Permission</span>
                      <small>
                        {permissionOptions.find((option) => option.value === permission)?.label ??
                          permission}
                      </small>
                    </button>
                    <button
                      className="composer-overflow-row"
                      type="button"
                      role="menuitem"
                      aria-haspopup="menu"
                      aria-expanded={controlsSubmenu === "delegation"}
                      disabled={delegationControlDisabled}
                      onPointerEnter={() => setControlsSubmenu("delegation")}
                      onFocus={() => setControlsSubmenu("delegation")}
                      onClick={() => setControlsSubmenu("delegation")}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowRight") setControlsSubmenu("delegation");
                      }}
                    >
                      <span>Delegation</span>
                      <small>
                        {delegationOptions.find((option) => option.value === effectiveDelegation)
                          ?.label ?? effectiveDelegation}
                      </small>
                    </button>
                    <AnimatePresence>
                      {controlsSubmenu ? (
                        <motion.div
                          className="composer-overflow-submenu"
                          role="menu"
                          aria-label={`${controlsSubmenu} options`}
                          initial={{ opacity: 0, x: -4, scale: 0.98 }}
                          animate={{ opacity: 1, x: 0, scale: 1 }}
                          exit={{ opacity: 0, x: -3, scale: 0.98 }}
                          transition={{ duration: 0.12, ease: [0.2, 0, 0, 1] }}
                        >
                          {compactControlOptions.map((option) => (
                            <button
                              type="button"
                              role="menuitemradio"
                              aria-checked={option.value === compactControlValue}
                              data-selected={option.value === compactControlValue}
                              key={option.value}
                              onClick={() => chooseCompactControl(option.value)}
                            >
                              {option.label}
                            </button>
                          ))}
                        </motion.div>
                      ) : null}
                    </AnimatePresence>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
          </div>
          <div className="composer-controls-right">
            {effortOptions.length > 0 ? (
              <Dropdown
                className="compact-select effort-select"
                aria-label="Reasoning effort"
                disabled={routingDisabled}
                leading={<Gauge />}
                value={activeEffort}
                onChange={changeEffort}
                options={effortOptions.map((option) => ({
                  value: option.id,
                  label: option.label,
                }))}
                compact
              />
            ) : null}
            <Dropdown
              className="model-select"
              aria-label="Model"
              disabled={routingDisabled}
              onOpen={() => loadProviderCatalog(runtime)}
              value={activeModel}
              onChange={(next) => {
                draftTouchedRef.current = true;
                routingTouched.current = true;
                setModel(next);
                // Each model carries its own effort levels; prefer the user's
                // global default when the new model supports it.
                const nextEntry = catalog.find((entry) => entry.id === next);
                const nextEfforts = nextEntry?.efforts ?? [];
                const nextEffort =
                  nextEfforts.length > 0
                    ? resolveModelEffort(nextEntry, preferredRuntimeEffort)
                    : preferredRuntimeEffort;
                setEffort(nextEffort);
                emitRoutingChange(runtime, next, nextEfforts.length > 0 ? nextEffort : undefined);
              }}
              options={modelOptions}
              compact
            />
            <Dropdown
              className="route-select"
              aria-label="Runtime"
              disabled={routingDisabled}
              value={runtime}
              onChange={(next) => {
                draftTouchedRef.current = true;
                routingTouched.current = true;
                const nextRuntime = next as RuntimeId;
                const nextRuntimeCatalog =
                  providerCatalogs[nextRuntime] ??
                  (runtimes.find((item) => item.id === nextRuntime)?.models ?? [])
                    .filter((id) => id !== PROVIDER_DEFAULT_MODEL)
                    .map((id) => ({ id, label: id }));
                const preferredRoute = runtimeDefaults?.[nextRuntime];
                const nextModel = nextRuntimeCatalog.some(
                  (entry) => entry.id === preferredRoute?.model,
                )
                  ? (preferredRoute?.model ?? PROVIDER_DEFAULT_MODEL)
                  : (nextRuntimeCatalog.find((entry) => entry.id !== PROVIDER_DEFAULT_MODEL)?.id ??
                    PROVIDER_DEFAULT_MODEL);
                const nextEntry = nextRuntimeCatalog.find((entry) => entry.id === nextModel);
                const nextEfforts = nextEntry?.efforts ?? [];
                const nextEffort =
                  nextEfforts.length > 0
                    ? resolveModelEffort(nextEntry, preferredRoute?.effort)
                    : preferredRoute?.effort;
                setRuntime(nextRuntime);
                setModel(nextModel);
                setEffort(nextEffort);
                if (nextRuntime === "antigravity" || nextRuntime === "custom") {
                  setDelegation("off");
                }
                loadProviderCatalog(nextRuntime);
                if (nextModel) {
                  emitRoutingChange(
                    nextRuntime,
                    nextModel,
                    nextEfforts.length > 0 ? nextEffort : undefined,
                  );
                }
              }}
              options={runtimes.map((item) => ({
                value: item.id,
                label:
                  item.status === "not_installed"
                    ? item.id === "cursor"
                      ? "Cursor (ACP unavailable)"
                      : `${item.name} (not installed)`
                    : item.name,
                icon: <ProviderIcon provider={item.id} label={item.name} />,
                disabled: item.status === "not_installed",
              }))}
              compact
            />
            <button
              className={`icon-button composer-mic${voiceRecording ? " is-recording" : ""}`}
              type="button"
              onClick={() => void (voiceActive ? stopVoiceTyping() : startVoiceTyping())}
              aria-label={voiceActive ? "Stop voice typing" : "Start voice typing"}
              aria-pressed={voiceRecording}
              aria-keyshortcuts={voiceRecording ? "Escape" : undefined}
              disabled={
                voicePhase === "stopping" || voiceConfigured === null || voiceConfigured === false
              }
              title={
                voicePhase === "starting"
                  ? "Cancel voice typing startup"
                  : voicePhase === "stopping"
                    ? "Finishing voice text in the draft"
                    : voiceRecording
                      ? "Stop listening and keep the words in the draft"
                      : voiceConfigured
                        ? "Start realtime voice typing"
                        : voiceConfigured === null
                          ? "Checking voice typing setup"
                          : "Add an OpenAI API key in Settings → General"
              }
            >
              {voiceActive ? <Square aria-hidden="true" /> : <Mic aria-hidden="true" />}
            </button>
            <Dropdown
              className="mic-select"
              aria-label="Microphone"
              value={
                micDevices.some((device) => device.deviceId === micDeviceId)
                  ? micDeviceId
                  : "default"
              }
              onChange={setMicDeviceId}
              options={microphoneOptions}
              compact
            />
            <div className="composer-send-stack">
              {/* With a draft in progress a full-size stop overlays above the
                  send position, so sending queued follow-ups is never blocked
                  by an in-flight turn. */}
              <AnimatePresence initial={false}>
                {running && onStop && draftPresent ? (
                  <motion.button
                    key="stacked-stop"
                    className="send-button send-button--stop send-button--stop-stacked"
                    type="button"
                    onClick={onStop}
                    disabled={stopping}
                    aria-label={stopping ? "Stopping turn" : "Stop turn"}
                    title={stopping ? "Stopping…" : "Stop the current turn"}
                    initial={{ opacity: 0, y: 6, scale: 0.94 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 6, scale: 0.94 }}
                    transition={
                      motionDisabled ? { duration: 0 } : { duration: 0.14, ease: [0.2, 0, 0, 1] }
                    }
                    whileTap={motionDisabled ? undefined : { scale: 0.94 }}
                  >
                    <Square />
                  </motion.button>
                ) : null}
              </AnimatePresence>
              {running && onStop && !draftPresent ? (
                <motion.button
                  className="send-button send-button--stop"
                  type="button"
                  onClick={onStop}
                  disabled={stopping}
                  aria-label={stopping ? "Stopping turn" : "Stop turn"}
                  title={stopping ? "Stopping…" : "Stop the current turn"}
                  whileTap={motionDisabled ? undefined : { scale: 0.94 }}
                >
                  <Square />
                </motion.button>
              ) : (
                <motion.button
                  className="send-button"
                  type="button"
                  onClick={() => void submit()}
                  disabled={(!prompt.trim() && attachments.length === 0) || !activeModel || sending}
                  aria-label={sending ? "Sending" : sendLabel}
                  whileTap={motionDisabled ? undefined : { scale: 0.94 }}
                >
                  <ArrowUp />
                </motion.button>
              )}
            </div>
          </div>
        </div>
      </div>
      <p className="composer-footnote">Agents can make mistakes; review changes</p>
      {voiceActive || voiceNotice || voiceError ? (
        // Absolutely positioned so transient status lines never change the
        // composer's height or push it up while typing.
        <div className="composer-status-overlay" aria-label="Composer status">
          {voiceActive ? (
            <p
              className={`composer-voice-status composer-voice-status--${voicePhase}`}
              role="status"
              aria-live="polite"
            >
              {voicePhase === "starting"
                ? "Starting voice typing…"
                : voicePhase === "stopping"
                  ? "Finishing your words… they will stay in the draft."
                  : "Listening… click the mic again or press Escape when you’re done."}
            </p>
          ) : null}
          {voiceNotice ? (
            <p
              className="composer-voice-status composer-voice-status--saved"
              role="status"
              aria-live="polite"
            >
              {voiceNotice}
            </p>
          ) : null}
          {voiceError ? (
            <p className="composer-voice-status" role="status">
              {voiceError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
