import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, m as motion } from "motion/react";
import {
  ArrowUp,
  Compass,
  Folder,
  Gauge,
  Mic,
  MessageCircle,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Users,
  X,
  MousePointerClick,
} from "lucide-react";
import { isAnnotationAttachment } from "../browserAnnotation";
import { FileIcon } from "./FileIcon";
import {
  bridge,
  persistableComposerAttachment,
  PROVIDER_DEFAULT_MODEL,
  resolveModelEffort,
  type ComposerDraftAttachment,
  type ComposerDraftValue,
  type ChatContextReference,
  type ModeProjection,
  type ModelCatalogEntry,
  type NativeActionReference,
  type NativeProviderAction,
  type RuntimeConnection,
  type RuntimeId,
  type TaskSummary,
} from "../bridge";
import type { ComposerNotice } from "../composerNotices";
import { prettyModelLabel, resolveModelLabel } from "../modelLabel";
import type { RuntimeRouteDefaults } from "../routingDefaults";
import { Dropdown, ProviderIcon } from "./Dropdown";
import { Tooltip } from "./Tooltip";
import {
  activeAutocompleteToken,
  appendUniqueAttachments,
  attachmentIdentity,
  buildContextIndex,
  clipboardImageFiles,
  codexGoalAction,
  completedNativeAction,
  CONTEXT_MATCH_LIMIT,
  detachCommittedProjectReferences,
  draftSegments,
  leadingNativeActionName,
  matchChats,
  matchContext,
  matchSkills,
  normalizeRuntime,
  projectAttachment,
  projectReference,
  type AutocompleteMatch,
  type ComposerAttachment,
} from "./composerModel";
import { encodePcm16, formatVoiceElapsed, pcmChunksToBase64 } from "./composerAudio";
import { readNativeActionCache, writeNativeActionCache } from "./nativeActionCache";
import { insertVoiceText } from "./voiceTyping";

// eslint-disable-next-line react-refresh/only-export-components
export { draftSegments } from "./composerModel";

interface ComposerProps {
  /** General Chat removes coding authority controls while retaining provider routing. */
  chatMode?: boolean;
  /** Existing Chat task that owns app-managed uploads. */
  taskId?: string;
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
    contextReferences?: ChatContextReference[];
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
  /** General Chats available as durable @ context in either Chat or code mode. */
  contextChats?: TaskSummary[];
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
  /** Keeps the draft editable while temporarily preventing provider dispatch. */
  sendDisabled?: boolean;
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
  analyser: AnalyserNode;
  sink: GainNode;
}

type VoicePhase = "idle" | "starting" | "recording" | "transcribing";

/** Recordings buffer locally and upload once at stop, so cap the clip at the
 * point where the WAV would approach OpenAI's 25 MB transcription limit. */
const VOICE_MAX_SECONDS = 300;
const VOICE_TIMER_WARN_SECONDS = 270;
const VOICE_METER_BARS = 12;
const EMPTY_NATIVE_ACTIONS: NativeProviderAction[] = [];

export function Composer({
  chatMode = false,
  taskId,
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
  contextChats = [],
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
  sendDisabled = false,
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
    initialDraft?.runtime === "antigravity" || initialDraft?.runtime === "custom"
      ? (defaultDelegation ?? "off")
      : (initialDraft?.delegation ?? defaultDelegation ?? "off"),
  );
  const [sending, setSending] = useState(false);
  const submittingRef = useRef(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(
    () => initialDraft?.attachments ?? [],
  );
  const [contextReferences, setContextReferences] = useState<ChatContextReference[]>(
    () => initialDraft?.contextReferences ?? [],
  );
  const [attachmentError, setAttachmentError] = useState("");
  const providerCatalogLoads = useRef(new Set<RuntimeId>());
  const [nativeActionsByKey, setNativeActionsByKey] = useState<
    Record<string, NativeProviderAction[]>
  >(() => readNativeActionCache());
  const [nativeActionsError, setNativeActionsError] = useState("");
  const [nativeActionsLoadingKey, setNativeActionsLoadingKey] = useState("");
  const [nativeActionRetry, setNativeActionRetry] = useState(0);
  const nativeActionLoads = useRef(new Map<string, Promise<NativeProviderAction[]>>());
  const authoritativeNativeActions = useRef(new Map<string, NativeProviderAction[]>());
  const nativeActionRefreshes = useRef(new Set<string>());
  const composerTextMirrorRef = useRef<HTMLDivElement>(null);
  const [voiceConfigured, setVoiceConfigured] = useState<boolean | null>(null);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>("idle");
  const [voiceError, setVoiceError] = useState("");
  const [voiceNotice, setVoiceNotice] = useState("");
  const [voiceElapsed, setVoiceElapsed] = useState(0);
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
  const voicePcmChunksRef = useRef<Int16Array[]>([]);
  /** Bumped on start/cancel/unmount so a stale async result cannot land. */
  const voiceGenerationRef = useRef(0);
  const voiceSessionActiveRef = useRef(false);
  const voiceStartedAtRef = useRef(0);
  const voiceNoticeTimerRef = useRef<number | undefined>(undefined);
  const voiceBarRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const [dismissedNoticeIds, setDismissedNoticeIds] = useState<Set<string>>(new Set());
  const [noticeClock, setNoticeClock] = useState(() => Date.now());
  /** Once the user picks any routing value, settings defaults stop syncing. */
  const routingTouched = useRef(Boolean(initialDraft));
  const draftEmissionReadyRef = useRef(false);
  const draftTouchedRef = useRef(false);
  const suppressDraftEmissionRef = useRef(false);
  const onDraftChangeRef = useRef(onDraftChange);
  const selectedRuntime = runtimes.find((item) => item.id === runtime) ?? runtimes[0];
  const antigravityPromptUnsupported = runtime === "antigravity";
  // Antigravity's print-mode process has no control channel for approval
  // prompts. Keep stale settings/drafts safe when a user routes a composer to
  // Antigravity after choosing Ask as needed on another provider.
  const effectivePermission = chatMode
    ? "read-only"
    : antigravityPromptUnsupported && permission === "ask"
      ? "project-write"
      : permission;
  const cachedCatalog = useSyncExternalStore(
    bridge.subscribeModelCatalogs,
    () => bridge.getCachedModelCatalog(runtime),
    () => undefined,
  );
  const catalogLoaded = cachedCatalog !== undefined;
  const runtimeCatalog: ModelCatalogEntry[] =
    selectedRuntime?.models
      .filter((id) => id !== PROVIDER_DEFAULT_MODEL)
      .map((id) => ({ id, label: resolveModelLabel(id) })) ?? [];
  const catalog = (cachedCatalog ?? runtimeCatalog).filter(
    (entry) => entry.id !== PROVIDER_DEFAULT_MODEL,
  );
  const activeEntry = catalog.find((entry) => entry.id === model) ?? catalog[0];
  const activeModel = activeEntry?.id ?? (model || PROVIDER_DEFAULT_MODEL);
  const modelOptions =
    catalog.length > 0
      ? catalog.map((entry) => ({
          value: entry.id,
          label: entry.label || resolveModelLabel(entry.id),
        }))
      : [
          {
            value: activeModel,
            label: catalogLoaded ? prettyModelLabel(activeModel) || activeModel : "Checking model…",
            disabled: true,
          },
        ];
  const effortOptions = activeEntry?.efforts ?? [];
  const activeEffort = resolveModelEffort(activeEntry, effort);
  const preferredRuntimeEffort = runtimeDefaults?.[runtime]?.effort ?? defaultEffort;
  const delegationAvailable = runtime !== "antigravity" && runtime !== "custom";
  const delegationControlDisabled = delegationDisabled || !delegationAvailable;
  const effectiveDelegation = chatMode ? "off" : delegationAvailable ? delegation : "off";
  const draftValue = useMemo<ComposerDraftValue>(
    () => ({
      prompt,
      attachments: attachments.map(persistableComposerAttachment),
      contextReferences,
      runtime,
      model: activeModel,
      effort,
      permission: effectivePermission,
      delegation: effectiveDelegation,
      selectionStart: caret,
      selectionEnd: caret,
    }),
    [
      activeModel,
      attachments,
      caret,
      contextReferences,
      effectiveDelegation,
      effectivePermission,
      effort,
      prompt,
      runtime,
    ],
  );
  const visibleNotices = notices.filter(
    (notice) =>
      !dismissedNoticeIds.has(notice.id) &&
      (notice.expiresAt === undefined || notice.expiresAt > noticeClock),
  );
  const voiceRecording = voicePhase === "recording";
  const voiceTranscribing = voicePhase === "transcribing";
  const voiceActive = voicePhase !== "idle";
  const motionDisabled =
    typeof document !== "undefined" &&
    (document.documentElement.dataset.motion === "none" ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  const draftPresent =
    Boolean(prompt.trim()) || attachments.length > 0 || contextReferences.length > 0;

  useEffect(() => {
    onDraftChangeRef.current = onDraftChange;
  }, [onDraftChange]);

  useEffect(() => {
    if (!draftEmissionReadyRef.current) {
      draftEmissionReadyRef.current = true;
      if (!draftTouchedRef.current) return;
    }
    if (suppressDraftEmissionRef.current) {
      if (
        !draftValue.prompt &&
        draftValue.attachments.length === 0 &&
        !draftValue.contextReferences?.length
      )
        return;
      suppressDraftEmissionRef.current = false;
    }
    if (
      !draftTouchedRef.current &&
      !draftValue.prompt &&
      draftValue.attachments.length === 0 &&
      !draftValue.contextReferences?.length
    ) {
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

  const autocompleteToken = useMemo(() => activeAutocompleteToken(prompt, caret), [caret, prompt]);
  const contextIndex = useMemo(() => buildContextIndex(contextFiles), [contextFiles]);
  const wantsContextFiles = autocompleteToken?.kind === "file";
  useEffect(() => {
    if (wantsContextFiles) onRequestContextFiles?.();
  }, [onRequestContextFiles, wantsContextFiles]);
  const nativeActionKey = workingDirectory ? `${runtime}\u0000${workingDirectory}` : "";
  const nativeActionKeyRef = useRef(nativeActionKey);
  useEffect(() => {
    nativeActionKeyRef.current = nativeActionKey;
  }, [nativeActionKey]);
  const nativeActions = nativeActionsByKey[nativeActionKey] ?? EMPTY_NATIVE_ACTIONS;
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
  const loadNativeActions = useCallback(
    (
      key: string,
      targetRuntime: RuntimeId,
      repository: string,
    ): Promise<NativeProviderAction[]> => {
      const existing = nativeActionLoads.current.get(key);
      if (existing) return existing;
      if (nativeActionKeyRef.current === key) {
        setNativeActionsLoadingKey(key);
        setNativeActionsError("");
      }
      const request = bridge
        .listNativeProviderActions(targetRuntime, repository)
        .then((actions) => {
          authoritativeNativeActions.current.set(key, actions);
          setNativeActionsByKey((current) => {
            const next = { ...current, [key]: actions };
            writeNativeActionCache(next);
            return next;
          });
          return actions;
        })
        .catch((error) => {
          if (nativeActionKeyRef.current === key) {
            setNativeActionsError(
              error instanceof Error ? error.message : "Could not load provider skills",
            );
          }
          throw error;
        })
        .finally(() => {
          if (nativeActionLoads.current.get(key) === request) {
            nativeActionLoads.current.delete(key);
          }
          setNativeActionsLoadingKey((current) => (current === key ? "" : current));
        });
      nativeActionLoads.current.set(key, request);
      return request;
    },
    [],
  );
  useEffect(() => {
    if (!workingDirectory || !nativeActionKey) return;
    // Cached actions render immediately; the authoritative list still
    // refreshes once per key (or again on explicit retry) in the background.
    const refreshKey = `${nativeActionKey}#${nativeActionRetry}`;
    if (nativeActionRefreshes.current.has(refreshKey)) return;
    nativeActionRefreshes.current.add(refreshKey);
    void loadNativeActions(nativeActionKey, runtime, workingDirectory).catch(() => undefined);
  }, [loadNativeActions, nativeActionKey, nativeActionRetry, runtime, workingDirectory]);
  const autocompleteMatches = useMemo(
    () =>
      !autocompleteToken
        ? []
        : autocompleteToken.kind === "file"
          ? [
              ...matchChats(contextChats, autocompleteToken.query),
              ...matchContext(contextIndex, autocompleteToken.query),
            ].slice(0, CONTEXT_MATCH_LIMIT)
          : chatMode
            ? []
            : matchSkills(nativeActions, autocompleteToken.query),
    [autocompleteToken, chatMode, contextChats, contextIndex, nativeActions],
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

  const addAttachments = async () => {
    const pick = bridge.pickContextAttachments;
    if (!pick) return;
    setAttachmentError("");
    try {
      const picked = chatMode ? await pick(taskId) : await pick();
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

  const attachClipboardImages = async (files: File[]) => {
    const save = bridge.savePastedImageAttachment;
    if (!save || files.length === 0) return;
    setAttachmentError("");
    try {
      const saved = await Promise.all(
        files.map((file) =>
          chatMode
            ? save(file, file.name || undefined, taskId)
            : save(file, file.name || undefined),
        ),
      );
      draftTouchedRef.current = true;
      setAttachments((current) => appendUniqueAttachments(current, saved));
    } catch (error) {
      setAttachmentError(
        error instanceof Error ? error.message : "Could not attach the clipboard image.",
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
    if (token.kind === "file" && match.chatTaskId) {
      const before = prompt.slice(0, token.start);
      let after = prompt.slice(caret);
      if ((!before || /\s$/.test(before)) && /^\s/.test(after)) after = after.slice(1);
      const next = before + after;
      const position = before.length;
      setContextReferences((current) =>
        current.some((reference) => reference.sourceTaskId === match.chatTaskId)
          ? current
          : [
              ...current,
              {
                id: crypto.randomUUID(),
                sourceTaskId: match.chatTaskId!,
                sourceTitle: match.value,
              },
            ],
      );
      setPrompt(next);
      setCaret(position);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(position, position);
      });
      return;
    }
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
    setContextReferences(value.contextReferences ?? []);
    const restoredRuntime = normalizeRuntime(runtimes, value.runtime);
    setRuntime(restoredRuntime);
    setModel(value.model);
    setEffort(value.effort);
    setPermission(value.permission);
    setDelegation(
      restoredRuntime === "antigravity" || restoredRuntime === "custom" ? "off" : value.delegation,
    );
    setCaret(position);
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
    setPermission(
      nextRuntime === "antigravity" && defaultPermission === "ask"
        ? "project-write"
        : (defaultPermission ?? "project-write"),
    );
    setDelegation(defaultDelegation ?? "off");
    setEffort(defaultEffort);
  }, [defaultRuntime, defaultModel, defaultPermission, defaultDelegation, defaultEffort, runtimes]);

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
      capture.analyser.disconnect();
      capture.processor.disconnect();
      capture.sink.disconnect();
      capture.stream.getTracks().forEach((track) => track.stop());
      await capture.context.close().catch(() => undefined);
    }
  }, []);

  const showVoiceNotice = useCallback((text: string) => {
    setVoiceNotice(text);
    if (voiceNoticeTimerRef.current !== undefined) {
      window.clearTimeout(voiceNoticeTimerRef.current);
    }
    voiceNoticeTimerRef.current = window.setTimeout(() => {
      setVoiceNotice("");
      voiceNoticeTimerRef.current = undefined;
    }, 4500);
  }, []);

  /** Discards the session: buffered audio is dropped, and bumping the
   * generation invalidates a startup or transcription still in flight. */
  const cancelVoiceRecording = useCallback(
    async (notice: string) => {
      voiceGenerationRef.current += 1;
      voiceSessionActiveRef.current = false;
      voicePcmChunksRef.current = [];
      await releaseVoiceCapture();
      setVoiceError("");
      setVoicePhase("idle");
      if (notice) showVoiceNotice(notice);
    },
    [releaseVoiceCapture, showVoiceNotice],
  );

  /** Stops capture and sends the buffered clip for one-shot transcription. */
  const finishVoiceRecording = useCallback(async () => {
    if (!voiceSessionActiveRef.current) return;
    voiceSessionActiveRef.current = false;
    const generation = voiceGenerationRef.current;
    const chunks = voicePcmChunksRef.current;
    voicePcmChunksRef.current = [];
    await releaseVoiceCapture();
    const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (totalSamples < 24000 / 4) {
      setVoicePhase("idle");
      showVoiceNotice("The recording was too short to transcribe.");
      return;
    }
    setVoicePhase("transcribing");
    setVoiceError("");
    try {
      const transcribe = bridge.transcribeVoiceClip;
      if (!transcribe) throw new Error("Voice typing is unavailable in this app build.");
      const text = await transcribe(pcmChunksToBase64(chunks), 24000);
      if (voiceGenerationRef.current !== generation) return;
      setVoicePhase("idle");
      if (!text) {
        showVoiceNotice("No speech was detected in the recording.");
        return;
      }
      // Insert at the caret as it stands now, so typing or sending during
      // the recording never resurrects older draft text.
      const textarea = textareaRef.current;
      const current = textarea?.value ?? prompt;
      const start = Math.min(textarea?.selectionStart ?? current.length, current.length);
      const end = Math.min(Math.max(textarea?.selectionEnd ?? start, start), current.length);
      const next = insertVoiceText(current, text, { start, end });
      const position = start + (next.length - current.length) + (end - start);
      draftTouchedRef.current = true;
      setPrompt(next);
      setCaret(position);
      showVoiceNotice("Voice text added to the draft.");
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        node?.focus();
        node?.setSelectionRange(position, position);
      });
    } catch (error) {
      if (voiceGenerationRef.current !== generation) return;
      setVoicePhase("idle");
      setVoiceError(error instanceof Error ? error.message : "Could not transcribe the recording.");
    }
  }, [prompt, releaseVoiceCapture, showVoiceNotice]);

  useEffect(() => {
    if (!voiceActive) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void cancelVoiceRecording(
        voiceTranscribing ? "Transcription discarded." : "Recording discarded.",
      );
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [cancelVoiceRecording, voiceActive, voiceTranscribing]);

  // The elapsed clock doubles as the length limiter: recordings buffer
  // locally, so the clip must stop before the upload outgrows the API cap.
  useEffect(() => {
    if (!voiceRecording) return;
    const interval = window.setInterval(() => {
      const elapsed = Math.floor((performance.now() - voiceStartedAtRef.current) / 1000);
      setVoiceElapsed(elapsed);
      if (elapsed >= VOICE_MAX_SECONDS) void finishVoiceRecording();
    }, 500);
    return () => window.clearInterval(interval);
  }, [finishVoiceRecording, voiceRecording]);

  // Levels write straight to the bar elements from an animation frame; state
  // updates here would re-render the whole composer at display refresh rate.
  useEffect(() => {
    if (!voiceRecording) return;
    const analyser = voiceCaptureRef.current?.analyser;
    if (!analyser) return;
    const bars = voiceBarRefs.current;
    const bins = new Uint8Array(analyser.frequencyBinCount);
    let raf = 0;
    const tick = () => {
      analyser.getByteFrequencyData(bins);
      const band = Math.floor(bins.length / VOICE_METER_BARS) || 1;
      for (let bar = 0; bar < VOICE_METER_BARS; bar += 1) {
        const node = bars[bar];
        if (!node) continue;
        let sum = 0;
        const start = bar * band;
        const end = Math.min(bins.length, start + band);
        for (let index = start; index < end; index += 1) sum += bins[index];
        const level = sum / Math.max(1, end - start) / 255;
        node.style.transform = `scaleY(${Math.max(0.18, Math.min(1, level * 1.6)).toFixed(3)})`;
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(raf);
      for (const node of bars) {
        if (node) node.style.transform = "";
      }
    };
  }, [voiceRecording]);

  const startVoiceRecording = async () => {
    if (voicePhase !== "idle") return;
    if (!voiceConfigured) {
      setVoiceError("Add your OpenAI API key in Settings → General to enable voice typing.");
      return;
    }
    if (typeof window === "undefined" || !window.AudioContext || !navigator.mediaDevices) {
      setVoiceError("This desktop environment does not provide microphone capture.");
      return;
    }
    if (!bridge.transcribeVoiceClip) {
      setVoiceError("Voice typing is unavailable in this app build.");
      return;
    }
    const generation = ++voiceGenerationRef.current;
    setVoicePhase("starting");
    setVoiceError("");
    setVoiceNotice("");
    setVoiceElapsed(0);
    voicePcmChunksRef.current = [];
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
      if (voiceGenerationRef.current !== generation) {
        // Cancelled while the permission prompt was pending; the cancel path
        // already reset the phase.
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      context = new AudioContext({ sampleRate: 24000 });
      await context.resume();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      const processor = context.createScriptProcessor(4096, 1, 1);
      const sink = context.createGain();
      sink.gain.value = 0;
      source.connect(analyser);
      source.connect(processor);
      processor.connect(sink);
      sink.connect(context.destination);
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
        voicePcmChunksRef.current.push(encodePcm16(samples, context?.sampleRate ?? 24000));
      };
      // Capture can fail silently: the audio graph never ticks, or the track
      // delivers only digital silence (wrong device, OS-level mic privacy
      // block). Surface both instead of leaving a mute session running.
      window.setTimeout(() => {
        if (!voiceSessionActiveRef.current || voiceGenerationRef.current !== generation) return;
        if (chunkCount === 0) {
          setVoiceError(
            "The microphone is not producing audio. Check the OS microphone privacy settings and the selected device.",
          );
        } else if (!sawSignal) {
          setVoiceError(
            "Only silence is coming from the microphone. Try a different device from the mic dropdown.",
          );
        }
      }, 3000);
      voiceCaptureRef.current = { context, stream, source, processor, analyser, sink };
      voiceStartedAtRef.current = performance.now();
      setVoicePhase("recording");
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      await context?.close().catch(() => undefined);
      if (voiceGenerationRef.current === generation) {
        voiceSessionActiveRef.current = false;
        setVoiceError(error instanceof Error ? error.message : "Could not start voice recording.");
        setVoicePhase("idle");
      }
    }
  };

  useEffect(
    () => () => {
      voiceGenerationRef.current += 1;
      voiceSessionActiveRef.current = false;
      voicePcmChunksRef.current = [];
      const capture = voiceCaptureRef.current;
      voiceCaptureRef.current = null;
      if (capture) {
        capture.processor.onaudioprocess = null;
        capture.source.disconnect();
        capture.analyser.disconnect();
        capture.processor.disconnect();
        capture.sink.disconnect();
        capture.stream.getTracks().forEach((track) => track.stop());
        void capture.context.close().catch(() => undefined);
      }
      if (voiceNoticeTimerRef.current !== undefined) {
        window.clearTimeout(voiceNoticeTimerRef.current);
      }
    },
    [],
  );

  const loadProviderCatalog = useCallback((targetRuntime: RuntimeId) => {
    if (
      bridge.getCachedModelCatalog(targetRuntime) !== undefined ||
      providerCatalogLoads.current.has(targetRuntime)
    ) {
      return;
    }
    providerCatalogLoads.current.add(targetRuntime);
    void bridge
      .listModelCatalog(targetRuntime)
      .catch(() => undefined)
      .finally(() => providerCatalogLoads.current.delete(targetRuntime));
  }, []);

  useEffect(() => {
    loadProviderCatalog(runtime);
  }, [cachedCatalog, loadProviderCatalog, runtime]);

  // A saved model can belong to a different runtime (for example after an
  // imported settings file or a runtime change from an older build). Once the
  // provider catalog resolves, select its first advertised model so the
  // default route is a real, sendable route rather than a stale id.
  useEffect(() => {
    const resolvedCatalog = cachedCatalog;
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
  }, [cachedCatalog, model, onRoutingChange, preferredRuntimeEffort, runtime]);

  const submit = async () => {
    const trimmed = prompt.trim();
    if (
      (!trimmed && attachments.length === 0 && contextReferences.length === 0) ||
      !activeModel ||
      sendDisabled ||
      sending ||
      submittingRef.current
    ) {
      return;
    }
    submittingRef.current = true;
    setSending(true);
    const submittedDraft = trimmed;
    const submittedAttachments = attachments;
    const submittedContextReferences = contextReferences;
    let draftCleared = false;
    const restoreDraft = () => {
      setPrompt((current) => (current.trim() ? current : submittedDraft));
      setAttachments((current) => (current.length > 0 ? current : submittedAttachments));
      setContextReferences((current) =>
        current.length > 0 ? current : submittedContextReferences,
      );
    };
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
    const chatReferenceBlock = submittedContextReferences.length
      ? `Referenced chats:\n${submittedContextReferences
          .map((reference) => `- @${reference.sourceTitle}`)
          .join("\n")}`
      : "";
    const outgoing = [trimmed, attachmentBlock, chatReferenceBlock].filter(Boolean).join("\n\n");
    try {
      const cachedNativeAction = completedNativeAction(trimmed, nativeActions);
      const builtInAction = codexGoalAction(trimmed, runtime);
      let currentActions = authoritativeNativeActions.current.get(nativeActionKey);
      if (
        leadingNativeActionName(trimmed) &&
        nativeActionKey &&
        workingDirectory &&
        !currentActions &&
        !builtInAction
      ) {
        currentActions = await loadNativeActions(nativeActionKey, runtime, workingDirectory);
      }
      const nativeAction =
        builtInAction ?? completedNativeAction(trimmed, currentActions ?? nativeActions);
      if (
        cachedNativeAction &&
        (!nativeAction || (cachedNativeAction.id !== nativeAction.id && !builtInAction))
      ) {
        setNativeActionsError(
          "This provider action changed; choose it again from the refreshed slash menu",
        );
        textareaRef.current?.focus();
        return;
      }
      const nativeActionId = nativeAction?.id;
      const draftRevision = onDraftSubmit?.(draftValue);
      // Clear only after any cached native action has been checked against
      // the current native catalog. A rejected refresh leaves the draft in
      // place instead of sending a slash command as ordinary prose.
      suppressDraftEmissionRef.current = true;
      setPrompt("");
      setAttachments([]);
      setContextReferences([]);
      draftCleared = true;
      const accepted = await onSend({
        prompt: outgoing,
        draftPrompt: submittedDraft,
        attachments: submittedAttachments.map(persistableComposerAttachment),
        ...(submittedContextReferences.length > 0
          ? { contextReferences: submittedContextReferences }
          : {}),
        runtime,
        model: activeModel,
        effort: effortOptions.length > 0 ? activeEffort : undefined,
        permission: effectivePermission,
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
      if (draftCleared) restoreDraft();
    } finally {
      submittingRef.current = false;
      setSending(false);
    }
  };

  const changePermission = (next: string) => {
    if (runtime === "antigravity" && next === "ask") return;
    draftTouchedRef.current = true;
    routingTouched.current = true;
    setPermission(next as typeof permission);
    onPermissionChange?.(next as typeof permission);
  };

  const changeDelegation = (next: string) => {
    draftTouchedRef.current = true;
    routingTouched.current = true;
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
    {
      value: "ask",
      label: "Ask as needed",
      disabled: antigravityPromptUnsupported,
    },
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
        ? effectivePermission
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
                <Tooltip label="Dismiss notice" placement="top">
                  <button
                    className="composer-notice-dismiss"
                    type="button"
                    aria-label={`Dismiss ${notice.title}`}
                    onClick={() =>
                      setDismissedNoticeIds((current) => new Set(current).add(notice.id))
                    }
                  >
                    <X aria-hidden="true" />
                  </button>
                </Tooltip>
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
        {voiceActive ? (
          <div className="composer-voice-hud" role="status" aria-live="polite">
            {voiceRecording ? (
              <>
                <span className="composer-voice-hint">Stop to transcribe · Esc to cancel</span>
                <span
                  className={`composer-voice-timer${
                    voiceElapsed >= VOICE_TIMER_WARN_SECONDS ? " composer-voice-timer--warn" : ""
                  }`}
                >
                  {formatVoiceElapsed(voiceElapsed)}
                </span>
                <span className="composer-voice-bars" aria-hidden="true">
                  {Array.from({ length: VOICE_METER_BARS }, (_, index) => (
                    <span
                      key={index}
                      className="composer-voice-bar"
                      ref={(node) => {
                        voiceBarRefs.current[index] = node;
                      }}
                    />
                  ))}
                </span>
              </>
            ) : (
              <span className="composer-voice-hint">
                {voicePhase === "starting" ? "Starting the microphone…" : "Transcribing…"}
              </span>
            )}
          </div>
        ) : null}
        <AnimatePresence>
          {autocompleteOpen ? (
            <motion.div
              className="composer-autocomplete"
              role="listbox"
              aria-label={
                autocompleteToken?.kind === "file" ? "Context suggestions" : "Skill suggestions"
              }
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.12, ease: "easeOut" }}
            >
              <p className="composer-autocomplete-hint">
                {autocompleteToken?.kind === "file"
                  ? chatMode
                    ? "Chats · ↑↓ to choose · Enter adds context · Esc to dismiss"
                    : "Chats, files & folders · ↑↓ to choose · Enter adds context · Esc to dismiss"
                  : "Provider native · ↑↓ to choose · Enter to insert · Esc to dismiss"}
              </p>
              {skillStatusVisible ? (
                <p
                  className="composer-autocomplete-status"
                  role={nativeActionsError ? "alert" : "status"}
                >
                  {nativeActionsError || "Loading native skills…"}
                </p>
              ) : null}
              {autocompleteMatches.map((match, index) => (
                <Tooltip
                  key={match.actionId ?? `${match.value}:${index}`}
                  label="Open this provider's interactive terminal to use this action"
                  disabled={match.invocation !== "interactiveOnly"}
                  placement="top"
                >
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === highlightedIndex}
                    aria-disabled={match.invocation === "interactiveOnly"}
                    data-active={index === highlightedIndex}
                    data-disabled={match.invocation === "interactiveOnly" || undefined}
                    // Keep focus in the textarea so accepting never blurs the draft.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onClick={() => acceptAutocomplete(match)}
                  >
                    {autocompleteToken?.kind === "file" ? (
                      match.chatTaskId ? (
                        <MessageCircle aria-hidden="true" />
                      ) : match.entry === "folder" ? (
                        <Folder aria-hidden="true" />
                      ) : (
                        <FileIcon fileName={match.value} />
                      )
                    ) : null}
                    <span className="autocomplete-token">{match.label}</span>
                    {match.detail ? <small>{match.detail}</small> : null}
                  </button>
                </Tooltip>
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
              setPrompt(committedPrompt);
              setCaret(committedCaret);
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onPaste={(event) => {
              const images = clipboardImageFiles(event.clipboardData);
              if (images.length === 0) return;
              event.preventDefault();
              void attachClipboardImages(images);
            }}
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
            placeholder={
              chatMode
                ? "Message… use @ for chat context"
                : "Ask, build, review… use / for skills and @ for context"
            }
            aria-label={messageLabel}
            autoFocus
          />
        </div>
        {attachments.length > 0 || contextReferences.length > 0 || attachmentError ? (
          <div className="composer-attachments" aria-label="Attached context">
            {contextReferences.map((reference) => (
              <div className="composer-attachment composer-chat-reference" key={reference.id}>
                <MessageCircle className="file-type-icon" aria-hidden="true" />
                <span>{reference.sourceTitle}</span>
                <Tooltip label="Remove chat context" placement="top">
                  <button
                    className="composer-attachment-remove"
                    type="button"
                    aria-label={`Remove ${reference.sourceTitle}`}
                    onClick={() => {
                      draftTouchedRef.current = true;
                      setContextReferences((current) =>
                        current.filter((item) => item.id !== reference.id),
                      );
                    }}
                  >
                    <X aria-hidden="true" />
                  </button>
                </Tooltip>
              </div>
            ))}
            {attachments.map((attachment) => (
              <div
                className={`composer-attachment${
                  attachment.dataUrl ? " composer-attachment--image" : ""
                }${isAnnotationAttachment(attachment.name) ? " composer-attachment--annotation" : ""}`}
                key={attachmentIdentity(attachment)}
              >
                {isAnnotationAttachment(attachment.name) ? (
                  <MousePointerClick className="file-type-icon" aria-hidden="true" />
                ) : null}
                {attachment.dataUrl ? (
                  <img src={attachment.dataUrl} alt={attachment.name} />
                ) : attachment.entry === "folder" ? (
                  <Folder className="file-type-icon" aria-hidden="true" />
                ) : (
                  <FileIcon fileName={attachment.name} />
                )}
                <Tooltip label={attachment.path} placement="top">
                  <span>{attachment.name}</span>
                </Tooltip>
                <Tooltip label="Remove attachment" placement="top">
                  <button
                    className="composer-attachment-remove"
                    type="button"
                    aria-label={`Remove ${attachment.name}`}
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
                </Tooltip>
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
              <Tooltip label="Attach files or images as context" placement="top">
                <button
                  className="icon-button subtle composer-attach"
                  type="button"
                  onClick={() => void addAttachments()}
                  aria-label="Attach files or images from your computer"
                >
                  <Plus aria-hidden="true" />
                </button>
              </Tooltip>
            ) : null}
            {!chatMode ? (
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
                  value={effectivePermission}
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
            ) : null}
            {!chatMode ? (
              <div className="composer-overflow-controls" ref={controlsMenuRef}>
                <Tooltip label="Mode, permission, delegation" placement="top">
                  <button
                    ref={controlsMenuButtonRef}
                    className="dropdown-trigger composer-overflow-trigger"
                    type="button"
                    aria-label="More composer controls"
                    aria-haspopup="menu"
                    aria-expanded={controlsMenuOpen}
                    onClick={() => {
                      setControlsSubmenu(null);
                      setControlsMenuOpen((open) => !open);
                    }}
                  >
                    <SlidersHorizontal aria-hidden="true" />
                  </button>
                </Tooltip>
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
                            {modeOptions.find(
                              (option) => option.value === sessionModes.currentModeId,
                            )?.label ?? sessionModes.currentModeId}
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
                                disabled={
                                  controlsSubmenu === "permission" &&
                                  option.value === "ask" &&
                                  antigravityPromptUnsupported
                                }
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
            ) : null}
          </div>
          <div className="composer-controls-right">
            {effortOptions.length > 0 ? (
              <Dropdown
                className="compact-select effort-select"
                aria-label={runtime === "kimi" ? "Thinking" : "Reasoning effort"}
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
                const nextRuntimeCatalog: ModelCatalogEntry[] =
                  bridge.getCachedModelCatalog(nextRuntime) ??
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
            <Tooltip
              label={
                voicePhase === "starting"
                  ? "Cancel voice recording startup"
                  : voiceTranscribing
                    ? "Transcribing the recording"
                    : voiceRecording
                      ? "Stop recording and transcribe into the draft"
                      : voiceConfigured
                        ? "Record a voice clip and transcribe it into the draft"
                        : voiceConfigured === null
                          ? "Checking voice typing setup"
                          : "Add an OpenAI API key in Settings → General"
              }
              placement="top"
            >
              <button
                className={`icon-button composer-mic${voiceRecording ? " is-recording" : ""}${
                  voiceTranscribing ? " is-transcribing" : ""
                }`}
                type="button"
                onClick={() =>
                  void (voiceRecording
                    ? finishVoiceRecording()
                    : voicePhase === "starting"
                      ? cancelVoiceRecording("Recording discarded.")
                      : startVoiceRecording())
                }
                aria-label={
                  voiceRecording
                    ? "Stop recording and transcribe"
                    : voicePhase === "starting"
                      ? "Cancel voice recording startup"
                      : "Start voice typing"
                }
                aria-pressed={voiceRecording}
                aria-keyshortcuts={voiceActive ? "Escape" : undefined}
                disabled={
                  voiceTranscribing || voiceConfigured === null || voiceConfigured === false
                }
              >
                {voiceRecording || voicePhase === "starting" ? (
                  <Square aria-hidden="true" />
                ) : (
                  <Mic aria-hidden="true" />
                )}
              </button>
            </Tooltip>
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
                    aria-label={stopping ? "Stopping…" : "Stop the current turn"}
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
                <Tooltip label={stopping ? "Stopping…" : "Stop the current turn"} placement="top">
                  <motion.button
                    className="send-button send-button--stop"
                    type="button"
                    onClick={onStop}
                    disabled={stopping}
                    aria-label={stopping ? "Stopping turn" : "Stop turn"}
                    whileTap={motionDisabled ? undefined : { scale: 0.94 }}
                  >
                    <Square />
                  </motion.button>
                </Tooltip>
              ) : (
                <motion.button
                  className="send-button"
                  type="button"
                  onClick={() => void submit()}
                  disabled={
                    (!prompt.trim() &&
                      attachments.length === 0 &&
                      contextReferences.length === 0) ||
                    !activeModel ||
                    sendDisabled ||
                    sending
                  }
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
      <p className="composer-footnote">
        {chatMode
          ? "AI can make mistakes; check important information"
          : "Agents can make mistakes; review changes"}
      </p>
      {voiceNotice || voiceError ? (
        // Absolutely positioned so transient status lines never change the
        // composer's height or push it up while typing.
        <div className="composer-status-overlay" aria-label="Composer status">
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
