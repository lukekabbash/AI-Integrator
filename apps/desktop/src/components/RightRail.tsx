import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { AnimatePresence, m as motion, useReducedMotion } from "motion/react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  AtSign,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Copy,
  FileText,
  FolderOpen,
  FolderSearch,
  GitBranch,
  GitCommitHorizontal,
  GitCompare,
  Minus,
  Pencil,
  Plus,
  Radio,
  RefreshCw,
  SquareArrowOutUpRight,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import { AnimatedFolderIcon } from "./AnimatedFolderIcon";
import { FileIcon } from "./FileIcon";
import { SelectionActionPopover, type SelectionPayload } from "./SelectionActionPopover";
import { selectionEndpointElement } from "./conversationFormatting";
import type {
  ChildAgent,
  DelegationView,
  DiffFile,
  GitSnapshot,
  ProjectFileContent,
  ProjectFileEntry,
  ProjectFileOpener,
  UsageSnapshot,
} from "../bridge";
import { ResizeHandle } from "./ResizeHandle";
import { Tooltip } from "./Tooltip";

type RailTab = "git" | "agents" | "files" | "usage";

/** Selection payload from the file preview, with the file it came from. */
export interface FileSelectionPayload extends SelectionPayload {
  path: string;
}

const INITIAL_FILE_TREE_ENTRIES = 300;
const FILE_TREE_CHUNK = 300;
const INITIAL_FILE_PREVIEW_LINES = 400;
const FILE_PREVIEW_CHUNK = 400;
const INITIAL_GIT_FILE_ROWS = 200;
const GIT_FILE_CHUNK = 200;

interface RightRailProps {
  git: GitSnapshot;
  children: ChildAgent[];
  /** Live delegated subagents from the native broker; overrides `children`. */
  delegations?: DelegationView[];
  onApproveDelegation?: (delegationId: string) => Promise<void>;
  onDenyDelegation?: (delegationId: string) => Promise<void>;
  onNudgeDelegation?: (delegationId: string, message: string) => Promise<void>;
  onStopDelegation?: (delegationId: string) => Promise<void>;
  selectedDelegationId?: string;
  onSelectDelegation?: (delegationId: string) => void;
  usage: UsageSnapshot;
  activeFile?: DiffFile;
  /** Clears in-rail open file tabs when the selected project changes. */
  projectId?: string;
  projectFiles?: ProjectFileEntry[];
  projectFilesState?: "loading" | "ready" | "unavailable";
  /** Starts the bounded project scan only when the Files surface is opened. */
  onRequestProjectFiles?: () => void;
  /** A transcript action requesting a file be opened in the Files tab. */
  openProjectFileRequest?: { path: string; id: number } | null;
  onSelectFile: (file: DiffFile) => void;
  onOpenProjectFile?: (file: ProjectFileEntry) => Promise<ProjectFileContent>;
  /** Renames a project file in place; the caller refreshes the file list. */
  onRenameProjectFile?: (file: ProjectFileEntry, newName: string) => Promise<void>;
  /** Inserts the file as an @context mention into the main chat composer. */
  onMentionProjectFile?: (file: ProjectFileEntry) => void;
  /** Inserts a folder as an @context mention into the main chat composer. */
  onMentionProjectFolder?: (path: string) => void;
  /** Selection-to-chat from the file preview: quoted lines land in the composer. */
  onAddFileSelection?: (payload: FileSelectionPayload) => void;
  /** Native-detected, allowlisted external targets for Git file actions. */
  fileOpeners?: ProjectFileOpener[];
  onOpenGitFileExternal?: (file: DiffFile, openerId: string) => Promise<void>;
  onRevealGitFile?: (file: DiffFile) => Promise<void>;
  onOpenProjectFileExternal?: (path: string, openerId: string) => Promise<void>;
  onRevealProjectFile?: (path: string) => Promise<void>;
  onStageFile: (file: DiffFile, staged: boolean) => Promise<void>;
  onStageFiles?: (paths: string[], staged: boolean) => Promise<void>;
  onCommit: (message: string) => Promise<void>;
  onGenerateCommitMessage?: () => Promise<string>;
  onPush: () => Promise<void>;
  onReviewChanges?: () => void;
  onRefreshGit?: () => Promise<void>;
  onResize?: (delta: number) => void;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The Git action could not be completed.";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function handleMenuNavigation(event: KeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const menu = event.currentTarget;
  const items = Array.from(menu.querySelectorAll<HTMLElement>("[role='menuitem']")).filter(
    (item) => item.closest("[role='menu']") === menu && !item.hasAttribute("disabled"),
  );
  if (!items.length) return;
  event.preventDefault();
  const current = items.indexOf(document.activeElement as HTMLElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? (current + 1 + items.length) % items.length
          : (current - 1 + items.length) % items.length;
  items[next]?.focus();
}

function useDismissableMenu(
  open: boolean,
  menuRef: React.RefObject<HTMLElement | null>,
  dismiss: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) dismiss();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    const onBlur = () => dismiss();
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
    };
  }, [dismiss, menuRef, open]);
}

function GitPanel({
  git,
  activeFile,
  onSelectFile,
  onStageFile,
  onStageFiles,
  onCommit,
  onGenerateCommitMessage,
  onPush,
  onReviewChanges,
  onRefreshGit,
  fileOpeners = [],
  onOpenGitFileExternal,
  onRevealGitFile,
}: Pick<
  RightRailProps,
  | "git"
  | "activeFile"
  | "onSelectFile"
  | "onStageFile"
  | "onStageFiles"
  | "onCommit"
  | "onGenerateCommitMessage"
  | "onPush"
  | "onReviewChanges"
  | "onRefreshGit"
  | "fileOpeners"
  | "onOpenGitFileExternal"
  | "onRevealGitFile"
>) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<
    "commit" | "commit-push" | "generate" | "push" | "stage" | "refresh" | null
  >(null);
  const reduceMotion = useReducedMotion();
  const [stagingPath, setStagingPath] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [stagedLimit, setStagedLimit] = useState(INITIAL_GIT_FILE_ROWS);
  const [unstagedLimit, setUnstagedLimit] = useState(INITIAL_GIT_FILE_ROWS);
  const [commitMenuOpen, setCommitMenuOpen] = useState(false);
  const [fileContextMenu, setFileContextMenu] = useState<{
    file: DiffFile;
    x: number;
    y: number;
    keyboard: boolean;
    submenuOpen: boolean;
    source: HTMLElement | null;
  } | null>(null);
  const [paneRatios, setPaneRatios] = useState({ staged: 0.24, graph: 0.38 });
  const commitMenuRef = useRef<HTMLDivElement>(null);
  const commitMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const fileContextMenuRef = useRef<HTMLDivElement>(null);
  const openInTriggerRef = useRef<HTMLButtonElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const dismissCommitMenu = useCallback(() => setCommitMenuOpen(false), []);
  const dismissFileContextMenu = useCallback(() => {
    setFileContextMenu((current) => {
      if (current?.keyboard) current.source?.focus();
      return null;
    });
  }, []);
  useDismissableMenu(commitMenuOpen, commitMenuRef, dismissCommitMenu);
  useDismissableMenu(Boolean(fileContextMenu), fileContextMenuRef, dismissFileContextMenu);
  useEffect(() => {
    if (!commitMenuOpen) return;
    const timer = window.setTimeout(
      () =>
        commitMenuRef.current
          ?.querySelector<HTMLElement>("[role='menuitem']:not(:disabled)")
          ?.focus(),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [commitMenuOpen]);
  useEffect(() => {
    if (!fileContextMenu?.keyboard) return;
    const timer = window.setTimeout(
      () =>
        fileContextMenuRef.current
          ?.querySelector<HTMLElement>("[role='menuitem']:not(:disabled)")
          ?.focus(),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [fileContextMenu?.keyboard]);
  const { staged, unstaged, lineStatsLoaded, additions, deletions } = useMemo(() => {
    const staged: DiffFile[] = [];
    const unstaged: DiffFile[] = [];
    let lineStatsLoaded = true;
    let additions = 0;
    let deletions = 0;
    for (const file of git.files) {
      (file.staged ? staged : unstaged).push(file);
      if (file.statsLoaded === false) lineStatsLoaded = false;
      additions += file.additions;
      deletions += file.deletions;
    }
    return { staged, unstaged, lineStatsLoaded, additions, deletions };
  }, [git.files]);
  const supportedFileOpeners = fileOpeners;

  const runStage = async (file: DiffFile, nextStaged: boolean) => {
    setStagingPath(file.path);
    setActionError(null);
    try {
      await onStageFile(file, nextStaged);
    } catch (error) {
      setActionError(getErrorMessage(error));
    } finally {
      setStagingPath(null);
    }
  };

  const runStageMany = async (files: DiffFile[], nextStaged: boolean) => {
    if (!files.length || busy !== null) return;
    setBusy("stage");
    setActionError(null);
    try {
      if (onStageFiles)
        await onStageFiles(
          files.map((file) => file.path),
          nextStaged,
        );
      else await Promise.all(files.map((file) => onStageFile(file, nextStaged)));
    } catch (error) {
      setActionError(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const runRefresh = async () => {
    if (!onRefreshGit || busy !== null) return;
    setBusy("refresh");
    setActionError(null);
    try {
      await onRefreshGit();
    } catch (error) {
      setActionError(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const runCommit = async () => {
    if (!message.trim() || staged.length === 0 || busy !== null) return;
    setCommitMenuOpen(false);
    setBusy("commit");
    setActionError(null);
    try {
      await onCommit(message.trim());
      setMessage("");
    } catch (error) {
      setActionError(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const runGenerateCommitMessage = async () => {
    if (!onGenerateCommitMessage || staged.length === 0 || busy !== null) return;
    const draftAtStart = message;
    setBusy("generate");
    setActionError(null);
    try {
      const generated = (await onGenerateCommitMessage()).trim();
      if (!generated) throw new Error("The provider returned an empty commit message.");
      setMessage((current) => (current === draftAtStart ? generated : current));
    } catch (error) {
      setActionError(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const runCommitAndPush = async () => {
    if (!message.trim() || staged.length === 0 || busy !== null) return;
    setBusy("commit-push");
    setActionError(null);
    setCommitMenuOpen(false);
    let committed = false;
    try {
      await onCommit(message.trim());
      committed = true;
      setMessage("");
      await onPush();
    } catch (error) {
      setActionError(
        committed
          ? `Committed locally. Push failed: ${getErrorMessage(error)}`
          : getErrorMessage(error),
      );
    } finally {
      setBusy(null);
    }
  };

  const runPush = async () => {
    if (busy !== null || git.ahead === 0) return;
    setCommitMenuOpen(false);
    setBusy("push");
    setActionError(null);
    try {
      await onPush();
    } catch (error) {
      setActionError(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const runExternalFileAction = async (action: () => Promise<void>) => {
    setFileContextMenu(null);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(getErrorMessage(error));
    }
  };

  const resizePane = (pane: "staged" | "graph", delta: number) => {
    const height = workspaceRef.current?.getBoundingClientRect().height || 1;
    setPaneRatios((current) => {
      const minimumMiddle = 0.18;
      if (pane === "staged") {
        return {
          ...current,
          staged: clamp(current.staged + delta / height, 0.14, 1 - current.graph - minimumMiddle),
        };
      }
      return {
        ...current,
        graph: clamp(
          current.graph - delta / height,
          0.3,
          Math.min(0.45, 1 - current.staged - minimumMiddle),
        ),
      };
    });
  };

  const openFileContextMenu = (
    file: DiffFile,
    x: number,
    y: number,
    source: HTMLElement | null,
    keyboard = false,
  ) => {
    setFileContextMenu({
      file,
      x: Math.min(x, Math.max(4, window.innerWidth - 224)),
      y: Math.min(y, Math.max(4, window.innerHeight - 240)),
      keyboard,
      submenuOpen: false,
      source,
    });
  };

  const fileRow = (file: DiffFile, isStaged: boolean) => (
    <div
      className="git-file-row"
      data-active={activeFile?.path === file.path}
      key={file.path}
      onContextMenu={(event) => {
        event.preventDefault();
        openFileContextMenu(
          file,
          event.clientX,
          event.clientY,
          event.currentTarget.querySelector<HTMLButtonElement>(".git-file-name"),
        );
      }}
    >
      <span className="git-file-glyph">
        <FileIcon fileName={file.path} />
        <button
          className="git-stage-button"
          type="button"
          onClick={() => void runStage(file, !isStaged)}
          disabled={stagingPath !== null || busy !== null}
          aria-busy={stagingPath === file.path}
          aria-label={`${isStaged ? "Unstage" : "Stage"} ${file.path}`}
        >
          {isStaged ? <Minus /> : <Plus />}
        </button>
      </span>
      <button
        className="git-file-name"
        type="button"
        onClick={() => onSelectFile(file)}
        onKeyDown={(event) => {
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            openFileContextMenu(file, bounds.right - 12, bounds.bottom, event.currentTarget, true);
          }
        }}
        title={file.path}
        aria-pressed={activeFile?.path === file.path}
      >
        <span>{file.path.split("/").at(-1)}</span>
        <small>{file.path.split("/").slice(0, -1).join("/")}</small>
      </button>
      <span className="file-change-count">
        {file.statsLoaded === false ? (
          <small aria-label="Line counts load when this diff is opened">…</small>
        ) : (
          <>
            <i>+{file.additions}</i>
            <b>−{file.deletions}</b>
          </>
        )}
      </span>
      <span className="file-state">{file.status.at(0)?.toUpperCase()}</span>
    </div>
  );

  return (
    <div className="rail-panel git-panel">
      <div className="branch-header">
        <div className="branch-button" aria-label={`Current branch ${git.branch}`}>
          <GitBranch />
          <span>
            <strong>{git.branch || "No branch"}</strong>
            <small title={git.worktree}>{git.worktree || "Repository not loaded"}</small>
          </span>
        </div>
        <Tooltip
          label={`${git.ahead} ahead · ${git.behind} behind${git.upstream ? ` · ${git.upstream}` : ""}`}
        >
          <span
            className="sync-pill"
            data-dirty={git.ahead > 0 || git.behind > 0}
            aria-label={`${git.ahead} commits ahead, ${git.behind} behind ${git.upstream || "upstream"}`}
          >
            <ArrowUp aria-hidden="true" />
            {git.ahead}
            <ArrowDown aria-hidden="true" />
            {git.behind}
          </span>
        </Tooltip>
        <Tooltip label="Refresh Git status">
          <button
            className="icon-button subtle git-refresh-button"
            type="button"
            onClick={() => void runRefresh()}
            disabled={!onRefreshGit || busy !== null}
            aria-label="Refresh Git status"
            aria-busy={busy === "refresh"}
          >
            <RefreshCw className={busy === "refresh" ? "spin-slow" : undefined} />
          </button>
        </Tooltip>
      </div>
      <div className="git-overview-actions">
        <button
          className="secondary-button"
          type="button"
          onClick={onReviewChanges}
          disabled={!git.files.length || !onReviewChanges}
        >
          <GitCompare /> Review changes
        </button>
        <span
          className="git-line-summary"
          aria-label={
            lineStatsLoaded
              ? `${additions} lines added, ${deletions} lines removed`
              : "Line counts load as diffs are opened"
          }
        >
          {lineStatsLoaded ? (
            <>
              <i>+{additions}</i>
              <b>−{deletions}</b>
            </>
          ) : (
            <small>Counts on demand</small>
          )}
        </span>
      </div>

      <div className="commit-card">
        <label className="sr-only" htmlFor="git-commit-message">
          Commit message
        </label>
        <textarea
          id="git-commit-message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
              event.preventDefault();
              void runCommit();
            }
          }}
          rows={2}
          placeholder="Commit message"
        />
        <Tooltip
          label={
            busy === "generate"
              ? "Writing commit message…"
              : staged.length === 0
                ? "Stage changes first"
                : "Generate commit message"
          }
          placement="top"
        >
          <button
            className="sparkle-button"
            type="button"
            aria-label="Generate commit message"
            aria-busy={busy === "generate"}
            disabled={!onGenerateCommitMessage || staged.length === 0 || busy !== null}
            onClick={() => void runGenerateCommitMessage()}
          >
            <motion.span
              aria-hidden="true"
              animate={
                busy === "generate" && !reduceMotion
                  ? { rotate: [0, 18, -12, 0], scale: [1, 1.08, 1] }
                  : { rotate: 0, scale: 1 }
              }
              transition={
                busy === "generate" && !reduceMotion
                  ? { duration: 1.1, ease: "easeInOut", repeat: Number.POSITIVE_INFINITY }
                  : { duration: 0.16 }
              }
            >
              <Sparkles />
            </motion.span>
          </button>
        </Tooltip>
        <div className="commit-split" ref={commitMenuRef}>
        <button
          className="primary-button commit-button"
          type="button"
          onClick={() => void runCommit()}
          disabled={!message.trim() || staged.length === 0 || busy !== null}
        >
          <GitCommitHorizontal />
          {busy === "commit"
            ? "Committing…"
            : busy === "commit-push"
              ? "Commit & push…"
              : `Commit${staged.length ? ` ${staged.length}` : ""}`}
        </button>
        <button
          ref={commitMenuTriggerRef}
          className="primary-button commit-menu-trigger"
          type="button"
          aria-label="More commit actions"
          aria-haspopup="menu"
          aria-expanded={commitMenuOpen}
          onClick={() => setCommitMenuOpen((current) => !current)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setCommitMenuOpen(true);
            }
          }}
          disabled={busy !== null}
        >
          <ChevronDown />
        </button>
        {commitMenuOpen ? (
          <div
            className="compact-action-menu commit-action-menu"
            role="menu"
            aria-label="Commit actions"
            onKeyDown={handleMenuNavigation}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => void runCommitAndPush()}
              disabled={!message.trim() || staged.length === 0}
            >
              <GitCommitHorizontal />
              <span>
                <strong>Commit &amp; push</strong>
                <small>Commit locally, then push to {git.upstream || "upstream"}</small>
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => void runPush()}
              disabled={git.ahead === 0}
            >
              <SquareArrowOutUpRight />
              <span>
                <strong>Push{git.ahead ? ` ${git.ahead}` : ""}</strong>
                <small>
                  {git.ahead
                    ? `${git.ahead} local commit${git.ahead === 1 ? "" : "s"}`
                    : "Nothing to push"}
                </small>
              </span>
            </button>
          </div>
        ) : null}
        </div>
      </div>
      {actionError ? (
        <p className="git-action-error" role="alert">
          {actionError}
        </p>
      ) : null}

      <div
        className="git-workspace"
        ref={workspaceRef}
        style={
          {
            "--git-staged-ratio": `${paneRatios.staged * 100}%`,
            "--git-graph-ratio": `${paneRatios.graph * 100}%`,
          } as CSSProperties
        }
      >
        <section className="git-section git-section--staged" aria-label="Staged changes">
          <div className="git-section-title">
            <span>Staged changes</span>
            <small>{staged.length}</small>
            {staged.length ? (
              <button
                type="button"
                onClick={() => void runStageMany(staged, false)}
                disabled={busy !== null}
              >
                Unstage all
              </button>
            ) : null}
          </div>
          <div className="git-section-body">
            {staged.length ? (
              <>
                {staged.slice(0, stagedLimit).map((file) => fileRow(file, true))}
                <ProgressiveSurfaceControls
                  shown={Math.min(stagedLimit, staged.length)}
                  total={staged.length}
                  noun="files"
                  chunk={GIT_FILE_CHUNK}
                  onShowMore={() => setStagedLimit((current) => current + GIT_FILE_CHUNK)}
                  onShowAll={() => setStagedLimit(staged.length)}
                />
              </>
            ) : (
              <p className="empty-compact">Stage a file to prepare the next commit.</p>
            )}
          </div>
        </section>
        <ResizeHandle
          axis="vertical"
          label="Resize staged changes"
          valueNow={Math.round(paneRatios.staged * 100)}
          valueMin={14}
          valueMax={64}
          onResize={(delta) => resizePane("staged", delta)}
        />
        <section className="git-section git-section--changes" aria-label="Unstaged changes">
          <div className="git-section-title">
            <span>Changes</span>
            <small>{unstaged.length}</small>
            {unstaged.length ? (
              <button
                type="button"
                onClick={() => void runStageMany(unstaged, true)}
                disabled={busy !== null}
              >
                Stage all
              </button>
            ) : null}
          </div>
          <div className="git-section-body">
            {unstaged.length ? (
              <>
                {unstaged.slice(0, unstagedLimit).map((file) => fileRow(file, false))}
                <ProgressiveSurfaceControls
                  shown={Math.min(unstagedLimit, unstaged.length)}
                  total={unstaged.length}
                  noun="files"
                  chunk={GIT_FILE_CHUNK}
                  onShowMore={() => setUnstagedLimit((current) => current + GIT_FILE_CHUNK)}
                  onShowAll={() => setUnstagedLimit(unstaged.length)}
                />
              </>
            ) : (
              <p className="empty-compact">No unstaged changes.</p>
            )}
          </div>
        </section>
        <ResizeHandle
          axis="vertical"
          label="Resize Git graph"
          valueNow={Math.round(paneRatios.graph * 100)}
          valueMin={30}
          valueMax={45}
          onResize={(delta) => resizePane("graph", delta)}
        />
        <section className="git-history" aria-label="Commit graph">
          <div className="git-section-title">
            <span>
              <Activity /> Graph
            </span>
            <small>{git.branch}</small>
          </div>
          <div className="git-section-body git-history-body">
            {git.commits.length ? (
              git.commits.map((commit, index) => (
                <div
                  className="commit-row"
                  key={`${commit.id}-${index}`}
                  data-current={commit.current}
                >
                  <span className="commit-node" />
                  <span>
                    <strong>{commit.subject}</strong>
                    <small>
                      {commit.id} · {commit.relativeTime}
                    </small>
                  </span>
                </div>
              ))
            ) : (
              <p className="empty-compact">Commit history is not available for this task.</p>
            )}
          </div>
        </section>
      </div>

      {fileContextMenu ? (
        <div
          ref={fileContextMenuRef}
          className="compact-action-menu file-context-menu git-file-context-menu"
          role="menu"
          aria-label={`Actions for ${fileContextMenu.file.path}`}
          style={{ left: fileContextMenu.x, top: fileContextMenu.y }}
          onKeyDown={handleMenuNavigation}
        >
          <div className="file-context-menu-path" title={fileContextMenu.file.path}>
            <FileIcon fileName={fileContextMenu.file.path} />
            <span>{fileContextMenu.file.path}</span>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void runStage(fileContextMenu.file, !fileContextMenu.file.staged);
              setFileContextMenu(null);
            }}
          >
            {fileContextMenu.file.staged ? <Minus /> : <Plus />}
            {fileContextMenu.file.staged ? "Unstage file" : "Stage file"}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onSelectFile(fileContextMenu.file);
              setFileContextMenu(null);
            }}
          >
            <GitCompare /> Open diff
          </button>
          {onOpenGitFileExternal && supportedFileOpeners.length ? (
            <div
              className="file-context-submenu-shell"
              onPointerLeave={() =>
                setFileContextMenu((current) =>
                  current ? { ...current, submenuOpen: false } : current,
                )
              }
            >
              <button
                ref={openInTriggerRef}
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={fileContextMenu.submenuOpen}
                onPointerEnter={() =>
                  setFileContextMenu((current) =>
                    current ? { ...current, submenuOpen: true } : current,
                  )
                }
                onFocus={() =>
                  setFileContextMenu((current) =>
                    current ? { ...current, submenuOpen: true } : current,
                  )
                }
                onClick={() =>
                  setFileContextMenu((current) =>
                    current ? { ...current, submenuOpen: !current.submenuOpen } : current,
                  )
                }
                onKeyDown={(event) => {
                  if (event.key !== "ArrowRight") return;
                  event.preventDefault();
                  setFileContextMenu((current) =>
                    current ? { ...current, submenuOpen: true } : current,
                  );
                  window.setTimeout(
                    () =>
                      fileContextMenuRef.current
                        ?.querySelector<HTMLElement>(".file-context-submenu [role='menuitem']")
                        ?.focus(),
                    0,
                  );
                }}
              >
                <SquareArrowOutUpRight /> Open in <ChevronRight className="menu-trailing-icon" />
              </button>
              {fileContextMenu.submenuOpen ? (
                <div
                  className="file-context-submenu"
                  role="menu"
                  aria-label="Open file in"
                  onKeyDown={(event) => {
                    if (["ArrowDown", "ArrowUp", "Home", "End", "ArrowLeft"].includes(event.key)) {
                      event.stopPropagation();
                    }
                    if (event.key === "ArrowLeft") {
                      event.preventDefault();
                      setFileContextMenu((current) =>
                        current ? { ...current, submenuOpen: false } : current,
                      );
                      openInTriggerRef.current?.focus();
                      return;
                    }
                    handleMenuNavigation(event);
                  }}
                >
                  {supportedFileOpeners.map((opener) => (
                    <button
                      type="button"
                      role="menuitem"
                      key={opener.id}
                      title={opener.description}
                      onClick={() =>
                        void runExternalFileAction(() =>
                          onOpenGitFileExternal(fileContextMenu.file, opener.id),
                        )
                      }
                    >
                      <SquareArrowOutUpRight /> {opener.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {onRevealGitFile ? (
            <button
              type="button"
              role="menuitem"
              onClick={() =>
                void runExternalFileAction(() => onRevealGitFile(fileContextMenu.file))
              }
            >
              <FolderSearch /> Reveal in File Explorer
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void navigator.clipboard.writeText(fileContextMenu.file.path).catch(() => undefined);
              setFileContextMenu(null);
            }}
          >
            <Copy /> Copy relative path
          </button>
        </div>
      ) : null}
    </div>
  );
}

function delegationDotStatus(status: DelegationView["status"]): string {
  switch (status) {
    case "pending-approval":
      return "waiting";
    case "denied":
    case "stopped":
      return "failed";
    default:
      return status;
  }
}

function delegationStatusLabel(status: DelegationView["status"]): string {
  return status
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function delegationLineage(
  delegations: DelegationView[],
): Array<{ delegation: DelegationView; depth: number }> {
  const delegationByChildTask = new Map(
    delegations.flatMap((delegation) =>
      delegation.childTaskId ? [[delegation.childTaskId, delegation] as const] : [],
    ),
  );
  const childrenByParent = new Map<string, DelegationView[]>();
  const roots: DelegationView[] = [];
  for (const delegation of delegations) {
    const parent = delegationByChildTask.get(delegation.parentTaskId);
    if (!parent) {
      roots.push(delegation);
      continue;
    }
    const children = childrenByParent.get(parent.id) ?? [];
    children.push(delegation);
    childrenByParent.set(parent.id, children);
  }
  const byCreatedAt = (a: DelegationView, b: DelegationView) =>
    Date.parse(a.createdAt) - Date.parse(b.createdAt);
  const ordered: Array<{ delegation: DelegationView; depth: number }> = [];
  const visited = new Set<string>();
  const visit = (delegation: DelegationView, depth: number) => {
    if (visited.has(delegation.id)) return;
    visited.add(delegation.id);
    ordered.push({ delegation, depth });
    for (const child of (childrenByParent.get(delegation.id) ?? []).sort(byCreatedAt)) {
      visit(child, depth + 1);
    }
  };
  for (const root of roots.sort(byCreatedAt)) visit(root, 0);
  for (const delegation of [...delegations].sort(byCreatedAt)) visit(delegation, 0);
  return ordered;
}

function AgentPanel({
  agents,
  delegations,
  onApprove,
  onDeny,
  onNudge,
  onStop,
  selectedDelegationId,
  onSelectDelegation,
}: {
  agents: ChildAgent[];
  delegations?: DelegationView[];
  onApprove?: (delegationId: string) => Promise<void>;
  onDeny?: (delegationId: string) => Promise<void>;
  onNudge?: (delegationId: string, message: string) => Promise<void>;
  onStop?: (delegationId: string) => Promise<void>;
  selectedDelegationId?: string;
  onSelectDelegation: (delegationId: string) => void;
}) {
  if (delegations && delegations.length > 0) {
    const selectedDelegation = delegations.find(
      (delegation) => delegation.id === selectedDelegationId,
    );
    const activeCount = delegations.filter((delegation) =>
      ["starting", "running", "waiting", "pending-approval"].includes(delegation.status),
    ).length;
    return (
      <div className="rail-panel agent-panel">
        <div className="subagent-lineage-pane">
          <header className="rail-panel-header">
            <span>
              <Users /> Subagents
            </span>
            <small>
              {delegations.length} total
              {activeCount ? ` · ${activeCount} active` : ""}
            </small>
          </header>
          <p className="rail-description">
            Subagents delegated by this task's orchestrator. Messages never interrupt a running turn
            — nudges are delivered when a subagent is idle.
          </p>
          <div className="delegation-tree" role="tree" aria-label="Subagent lineage">
            {delegationLineage(delegations).map(({ delegation, depth }, index) => (
              <DelegationRow
                key={delegation.id}
                delegation={delegation}
                depth={depth}
                selected={delegation.id === selectedDelegation?.id}
                focusable={
                  delegation.id === selectedDelegation?.id || (!selectedDelegation && index === 0)
                }
                onApprove={onApprove}
                onDeny={onDeny}
                onNudge={onNudge}
                onStop={onStop}
                onOpen={() => onSelectDelegation(delegation.id)}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }
  const roots = agents.filter((agent) => !agent.parentId);
  const childMap = new Map(
    agents.map((agent) => [
      agent.id,
      agents.filter((candidate) => candidate.parentId === agent.id),
    ]),
  );
  return (
    <div className="rail-panel agent-panel">
      <header className="rail-panel-header">
        <span>
          <Users /> Subagents
        </span>
      </header>
      <p className="rail-description">
        Subagents delegated by this task appear here. Enable delegation in the composer to let the
        orchestrator spin them up.
      </p>
      {roots.length ? (
        roots.map((root) => (
          <div className="agent-tree" key={root.id}>
            <AgentRow agent={root} root />
            <div className="agent-children">
              {(childMap.get(root.id) ?? []).map((agent) => (
                <AgentRow agent={agent} key={agent.id} />
              ))}
            </div>
          </div>
        ))
      ) : (
        <p className="empty-compact">No subagents have been delegated by this task.</p>
      )}
    </div>
  );
}

function DelegationRow({
  delegation,
  depth,
  selected,
  focusable,
  onApprove,
  onDeny,
  onNudge,
  onStop,
  onOpen,
}: {
  delegation: DelegationView;
  depth: number;
  selected: boolean;
  focusable: boolean;
  onApprove?: (delegationId: string) => Promise<void>;
  onDeny?: (delegationId: string) => Promise<void>;
  onNudge?: (delegationId: string, message: string) => Promise<void>;
  onStop?: (delegationId: string) => Promise<void>;
  onOpen: () => void;
}) {
  const [nudge, setNudge] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const active = ["starting", "running", "waiting"].includes(delegation.status);
  const canMessage = Boolean(
    delegation.childTaskId &&
    !["pending-approval", "denied", "starting"].includes(delegation.status),
  );
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The action could not be completed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="agent-row delegation-row"
      data-status={delegation.status}
      data-selected={selected}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected}
      tabIndex={focusable ? 0 : -1}
      style={{ "--delegation-depth": depth } as CSSProperties}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        const items = Array.from(
          event.currentTarget.parentElement?.querySelectorAll<HTMLElement>("[role='treeitem']") ??
            [],
        );
        const currentIndex = items.indexOf(event.currentTarget);
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (delegation.childTaskId) onOpen();
        } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const nextIndex =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : Math.max(
                    0,
                    Math.min(items.length - 1, currentIndex + (event.key === "ArrowDown" ? 1 : -1)),
                  );
          items[nextIndex]?.focus();
        }
      }}
    >
      <span className={`agent-avatar agent-avatar--${delegation.runtime}`}>
        {delegation.profileLabel.slice(0, 1)}
      </span>
      <span className="agent-copy">
        <strong>
          {delegation.title}
          <i>{delegation.profileLabel}</i>
        </strong>
        <span>
          {delegationStatusLabel(delegation.status)}
          {delegation.unreadFromChild > 0 ? ` · ${delegation.unreadFromChild} new message(s)` : ""}
        </span>
        <small>{[delegation.model, delegation.runtime].filter(Boolean).join(" · ")}</small>
        {delegation.pendingQuestions.map((question, index) => (
          <small className="delegation-question" key={index}>
            ❓ {question}
          </small>
        ))}
        {delegation.result ? (
          <small className="delegation-result">{delegation.result}</small>
        ) : null}
        <span className="delegation-actions">
          {delegation.status === "pending-approval" && onApprove ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => onApprove(delegation.id))}
            >
              Approve
            </button>
          ) : null}
          {delegation.status === "pending-approval" && onDeny ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => onDeny(delegation.id))}
            >
              Deny
            </button>
          ) : null}
          {active && onStop && !selected ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => onStop(delegation.id))}
            >
              Stop
            </button>
          ) : null}
          {delegation.childTaskId ? (
            <button type="button" onClick={onOpen}>
              {selected ? "Viewing transcript" : "View transcript"}
            </button>
          ) : null}
        </span>
        {canMessage && onNudge && !selected ? (
          <span className="delegation-nudge">
            <input
              value={nudge}
              placeholder="Nudge this subagent…"
              aria-label={`Message ${delegation.title}`}
              onChange={(event) => setNudge(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && nudge.trim()) {
                  const message = nudge.trim();
                  setNudge("");
                  void act(() => onNudge(delegation.id, message));
                }
              }}
            />
          </span>
        ) : null}
        {actionError ? <small className="delegation-error">{actionError}</small> : null}
      </span>
      <span className={`status-dot status-dot--${delegationDotStatus(delegation.status)}`}>
        <span className="sr-only">{delegation.status}</span>
      </span>
    </div>
  );
}

function AgentRow({ agent, root = false }: { agent: ChildAgent; root?: boolean }) {
  return (
    <div className="agent-row" data-root={root}>
      <span className={`agent-avatar agent-avatar--${agent.runtime}`}>
        {agent.name.slice(0, 1)}
      </span>
      <span className="agent-copy">
        <strong>
          {agent.name}
          <i>{agent.role}</i>
        </strong>
        <span>{agent.activity}</span>
        <small>{[agent.model, agent.elapsed, agent.worktree].filter(Boolean).join(" · ")}</small>
      </span>
      <span className={`status-dot status-dot--${agent.status}`}>
        <span className="sr-only">{agent.status}</span>
      </span>
    </div>
  );
}

interface FileContextMenuState {
  x: number;
  y: number;
  file: ProjectFileEntry;
  source: HTMLElement | null;
  keyboard: boolean;
}

function ProgressiveSurfaceControls({
  shown,
  total,
  noun,
  chunk,
  onShowMore,
  onShowAll,
}: {
  shown: number;
  total: number;
  noun: string;
  chunk: number;
  onShowMore: () => void;
  onShowAll: () => void;
}) {
  if (shown >= total) return null;
  return (
    <div className="progressive-surface-controls">
      <span role="status" aria-live="polite">
        Showing {shown.toLocaleString()} of {total.toLocaleString()} {noun}
      </span>
      <button className="secondary-button" type="button" onClick={onShowMore}>
        Show next {Math.min(chunk, total - shown).toLocaleString()} {noun}
      </button>
      <button className="secondary-button" type="button" onClick={onShowAll}>
        Show all {total.toLocaleString()} {noun}
      </button>
    </div>
  );
}

function FilePreview({
  file,
  onAddSelection,
}: {
  file: ProjectFileContent;
  onAddSelection?: (payload: FileSelectionPayload) => void;
}) {
  const lines = useMemo(() => file.content.split("\n"), [file.content]);
  const [lineLimit, setLineLimit] = useState(INITIAL_FILE_PREVIEW_LINES);
  const visibleLines = lines.slice(0, lineLimit);
  const linesRef = useRef<HTMLOListElement>(null);
  const resolveSelection = useCallback((range: Range) => {
    const container = linesRef.current;
    if (!container) return null;
    const startRow = selectionEndpointElement(range.startContainer, "li[data-line]", container);
    const endRow = selectionEndpointElement(range.endContainer, "li[data-line]", container);
    const startLine = startRow ? Number(startRow.dataset.line) : undefined;
    const endLine = endRow ? Number(endRow.dataset.line) : undefined;
    // List markers are CSS counters, so the raw selection text is clean code.
    return { text: range.toString(), startLine, endLine };
  }, []);
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.14, ease: "easeOut" }}
    >
      {onAddSelection ? (
        <SelectionActionPopover
          containerRef={linesRef}
          resolve={resolveSelection}
          label={`Selection actions for ${file.path}`}
          onAction={(payload) => onAddSelection({ ...payload, path: file.path })}
        />
      ) : null}
      <ol className="file-reader-lines" aria-label={`Contents of ${file.path}`} ref={linesRef}>
        {visibleLines.map((line, index) => (
          <li key={`${file.path}-${index}`} data-line={index + 1}>
            <code>
              {highlightFileLine(line).map((token, tokenIndex) => (
                <span
                  className={`syntax-${token.kind}`}
                  key={`${file.path}-${index}-${tokenIndex}`}
                >
                  {token.text}
                </span>
              ))}
            </code>
          </li>
        ))}
      </ol>
      <ProgressiveSurfaceControls
        shown={visibleLines.length}
        total={lines.length}
        noun="lines"
        chunk={FILE_PREVIEW_CHUNK}
        onShowMore={() => setLineLimit((current) => current + FILE_PREVIEW_CHUNK)}
        onShowAll={() => setLineLimit(lines.length)}
      />
    </motion.div>
  );
}

/** Transcript tool events may carry absolute or "./"-prefixed paths while the
 * project tree is root-relative; resolve by exact match first, then by the
 * longest tree path the requested path ends with. */
function resolveRequestedFile(
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

function FilePanel({
  projectFiles = [],
  projectFilesState = "unavailable",
  openProjectFileRequest,
  fileOpeners = [],
  onOpenProjectFile,
  onRenameProjectFile,
  onMentionProjectFile,
  onMentionProjectFolder,
  onAddFileSelection,
  onOpenProjectFileExternal,
  onRevealProjectFile,
}: Pick<
  RightRailProps,
  | "projectFiles"
  | "projectFilesState"
  | "openProjectFileRequest"
  | "fileOpeners"
  | "onOpenProjectFile"
  | "onRenameProjectFile"
  | "onMentionProjectFile"
  | "onMentionProjectFolder"
  | "onAddFileSelection"
  | "onOpenProjectFileExternal"
  | "onRevealProjectFile"
>) {
  const [filter, setFilter] = useState("");
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const [openTabs, setOpenTabs] = useState<ProjectFileContent[]>([]);
  const [activePath, setActivePath] = useState<string>("");
  const [openingPath, setOpeningPath] = useState<string>("");
  const [readError, setReadError] = useState("");
  const [readerRatio, setReaderRatio] = useState(0.5);
  const [renamingPath, setRenamingPath] = useState("");
  const [renameError, setRenameError] = useState("");
  const [fileActionError, setFileActionError] = useState("");
  const [contextMenu, setContextMenu] = useState<FileContextMenuState | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const folderMenuRef = useRef<HTMLDivElement>(null);
  const [treeWindow, setTreeWindow] = useState({
    key: "",
    limit: INITIAL_FILE_TREE_ENTRIES,
  });
  const handledOpenRequestRef = useRef<number | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const visibleProjectFiles = useMemo(
    () =>
      normalizedFilter
        ? projectFiles.filter((file) => file.path.toLocaleLowerCase().includes(normalizedFilter))
        : projectFiles,
    [normalizedFilter, projectFiles],
  );
  const treeLimit =
    treeWindow.key === normalizedFilter ? treeWindow.limit : INITIAL_FILE_TREE_ENTRIES;
  const treeProjectFiles = useMemo(
    () => visibleProjectFiles.slice(0, treeLimit),
    [treeLimit, visibleProjectFiles],
  );
  const projectTree = useMemo(() => buildProjectTree(treeProjectFiles), [treeProjectFiles]);
  const activeFile = openTabs.find((file) => file.path === activePath) ?? openTabs[0];
  const readerOpen = Boolean(activeFile || openingPath || readError);
  const supportedFileOpeners = useMemo(
    () => fileOpeners.filter((opener) => opener.id === "cursor" || opener.id === "vscode"),
    [fileOpeners],
  );

  const toggleFolder = (path: string) => {
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const openProjectFile = useCallback(
    async (file: ProjectFileEntry) => {
      const existing = openTabs.find((tab) => tab.path === file.path);
      if (existing) {
        setActivePath(existing.path);
        setReadError("");
        return;
      }
      if (!onOpenProjectFile) {
        setReadError("Project file reading is unavailable in this build.");
        return;
      }
      setOpeningPath(file.path);
      setReadError("");
      try {
        const content = await onOpenProjectFile(file);
        setOpenTabs((current) =>
          [content, ...current.filter((tab) => tab.path !== content.path)].slice(0, 8),
        );
        setActivePath(content.path);
      } catch (error) {
        setReadError(
          error instanceof Error
            ? error.message
            : typeof error === "object" &&
                error &&
                "message" in error &&
                typeof error.message === "string"
              ? error.message
              : "Could not open that project file.",
        );
      } finally {
        setOpeningPath("");
      }
    },
    [onOpenProjectFile, openTabs],
  );

  useEffect(() => {
    if (!openProjectFileRequest) return;
    if (handledOpenRequestRef.current === openProjectFileRequest.id) return;
    const file = resolveRequestedFile(projectFiles, openProjectFileRequest.path);
    if (!file) {
      // Retry while the tree is still loading; once it is ready an unresolved
      // path gets surfaced in the reader instead of failing silently.
      if (projectFilesState !== "ready") return;
      handledOpenRequestRef.current = openProjectFileRequest.id;
      setReadError(`Could not find ${openProjectFileRequest.path} in the project files.`);
      return;
    }
    // Mark the request handled inside the timer so a StrictMode remount that
    // clears the pending timeout does not swallow the open.
    const timer = window.setTimeout(() => {
      handledOpenRequestRef.current = openProjectFileRequest.id;
      void openProjectFile(file);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [openProjectFileRequest, projectFiles, projectFilesState, openProjectFile]);

  const closeTab = (path: string) => {
    setOpenTabs((current) => {
      const next = current.filter((tab) => tab.path !== path);
      if (activePath === path) setActivePath(next[0]?.path ?? "");
      return next;
    });
  };

  // The context menu closes on any outside press, Escape, or window blur so it
  // never lingers over unrelated UI.
  useEffect(() => {
    if (!contextMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!contextMenuRef.current?.contains(event.target as Node)) setContextMenu(null);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        contextMenu.source?.focus();
        setContextMenu(null);
      }
    };
    const onBlur = () => setContextMenu(null);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!folderMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!folderMenuRef.current?.contains(event.target as Node)) setFolderMenu(null);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setFolderMenu(null);
    };
    const onBlur = () => setFolderMenu(null);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
    };
  }, [folderMenu]);

  useEffect(() => {
    if (!contextMenu?.keyboard) return;
    const frame = window.requestAnimationFrame(() => {
      contextMenuRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [contextMenu]);

  const openContextMenu = (
    file: ProjectFileEntry,
    x: number,
    y: number,
    source: HTMLElement | null = null,
    keyboard = false,
  ) => {
    setFolderMenu(null);
    setContextMenu({
      file,
      // Clamped so the menu never opens off-screen near the window edges.
      x: Math.min(x, Math.max(4, window.innerWidth - 224)),
      y: Math.min(y, Math.max(4, window.innerHeight - 288)),
      source,
      keyboard,
    });
  };

  const openFolderMenu = (path: string, x: number, y: number) => {
    setContextMenu(null);
    setFolderMenu({
      path,
      x: Math.min(x, Math.max(4, window.innerWidth - 224)),
      y: Math.min(y, Math.max(4, window.innerHeight - 144)),
    });
  };

  const startRename = (file: ProjectFileEntry) => {
    if (!onRenameProjectFile) return;
    setRenameError("");
    setRenamingPath(file.path);
  };

  const commitRename = async (file: ProjectFileEntry, rawName: string) => {
    setRenamingPath("");
    const newName = rawName.trim();
    const currentName = file.path.split("/").at(-1) ?? "";
    if (!newName || newName === currentName || !onRenameProjectFile) return;
    setRenameError("");
    try {
      await onRenameProjectFile(file, newName);
      const parent = file.path.split("/").slice(0, -1).join("/");
      const nextPath = parent ? `${parent}/${newName}` : newName;
      // Keep any open reader tab pointing at the renamed file.
      setOpenTabs((current) =>
        current.map((tab) => (tab.path === file.path ? { ...tab, path: nextPath } : tab)),
      );
      setActivePath((current) => (current === file.path ? nextPath : current));
    } catch (error) {
      setRenameError(
        error instanceof Error ? error.message : "Could not rename that project file.",
      );
    }
  };

  const copyFilePath = async (file: ProjectFileEntry) => {
    try {
      await navigator.clipboard.writeText(file.path);
    } catch {
      // Clipboard access can be denied; the menu simply closes.
    }
  };

  const openFileExternally = async (file: ProjectFileEntry, openerId: string) => {
    if (!onOpenProjectFileExternal) return;
    setFileActionError("");
    setContextMenu(null);
    try {
      await onOpenProjectFileExternal(file.path, openerId);
    } catch (error) {
      setFileActionError(error instanceof Error ? error.message : "Could not open that file.");
    }
  };

  const revealFile = async (file: ProjectFileEntry) => {
    if (!onRevealProjectFile) return;
    setFileActionError("");
    setContextMenu(null);
    try {
      await onRevealProjectFile(file.path);
    } catch (error) {
      setFileActionError(
        error instanceof Error ? error.message : "Could not reveal that file in File Explorer.",
      );
    }
  };

  return (
    <div className="rail-panel file-panel">
      <header className="rail-panel-header">
        <span>
          <FileText /> Files
        </span>
        <small>
          {projectFilesState === "ready"
            ? `${projectFiles.length} files`
            : projectFilesState === "loading"
              ? "Loading…"
              : "Unavailable"}
        </small>
      </header>
      <div
        className="file-panel-split"
        data-reader-open={readerOpen}
        ref={splitRef}
        style={{ "--file-reader-ratio": `${readerRatio * 100}%` } as CSSProperties}
      >
        <div className="file-tree-pane">
          <label className="rail-filter">
            <span className="sr-only">Filter files</span>
            <input
              placeholder="Filter by name"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
          {renameError ? (
            <p className="empty-compact tree-rename-error" role="alert">
              {renameError}
            </p>
          ) : null}
          {fileActionError ? (
            <p className="empty-compact tree-rename-error" role="alert">
              {fileActionError}
            </p>
          ) : null}
          <div className="file-tree" aria-label="Project files">
            {projectFilesState === "loading" ? (
              <p className="empty-compact">Reading trusted project files…</p>
            ) : null}
            {projectFilesState === "ready" && visibleProjectFiles.length ? (
              <ProjectTree
                node={projectTree}
                collapsedFolders={collapsedFolders}
                forceExpanded={Boolean(normalizedFilter)}
                onToggleFolder={toggleFolder}
                onOpenFile={(file) => void openProjectFile(file)}
                activePath={activePath}
                openingPath={openingPath}
                renamingPath={renamingPath}
                onStartRename={onRenameProjectFile ? startRename : undefined}
                onCommitRename={(file, name) => void commitRename(file, name)}
                onCancelRename={() => setRenamingPath("")}
                onContextMenu={openContextMenu}
                onFolderContextMenu={onMentionProjectFolder ? openFolderMenu : undefined}
              />
            ) : null}
            {projectFilesState === "ready" ? (
              <ProgressiveSurfaceControls
                shown={treeProjectFiles.length}
                total={visibleProjectFiles.length}
                noun="files"
                chunk={FILE_TREE_CHUNK}
                onShowMore={() =>
                  setTreeWindow({
                    key: normalizedFilter,
                    limit: treeLimit + FILE_TREE_CHUNK,
                  })
                }
                onShowAll={() =>
                  setTreeWindow({
                    key: normalizedFilter,
                    limit: visibleProjectFiles.length,
                  })
                }
              />
            ) : null}
            {projectFilesState === "ready" && visibleProjectFiles.length === 0 ? (
              <p className="empty-compact">
                {normalizedFilter
                  ? "No project files match this filter."
                  : "No project files found."}
              </p>
            ) : null}
            {projectFilesState === "unavailable" ? (
              <p className="empty-compact">Project browsing is unavailable for this project.</p>
            ) : null}
          </div>
        </div>
        {readerOpen ? (
          <ResizeHandle
            axis="vertical"
            label="Resize file preview"
            onResize={(delta) => {
              const height = splitRef.current?.getBoundingClientRect().height ?? 1;
              setReaderRatio((current) => Math.max(0.24, Math.min(0.82, current - delta / height)));
            }}
          />
        ) : null}
        <AnimatePresence initial={false}>
          {readerOpen ? (
            <motion.div
              key="file-reader"
              className="file-reader-pane"
              aria-label="Open project files"
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 18 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
            >
              {openTabs.length ? (
                <div className="file-reader-tabs" role="tablist" aria-label="Open files">
                  <AnimatePresence initial={false}>
                    {openTabs.map((tab) => (
                      <motion.div
                        layout
                        className="file-reader-tab"
                        data-active={tab.path === (activeFile?.path ?? "")}
                        key={tab.path}
                        initial={{ opacity: 0, y: 8, maxWidth: 0 }}
                        animate={{ opacity: 1, y: 0, maxWidth: 140 }}
                        exit={{ opacity: 0, y: 4, maxWidth: 0 }}
                        transition={{ duration: 0.16, ease: "easeOut" }}
                      >
                        <button
                          type="button"
                          role="tab"
                          aria-selected={tab.path === (activeFile?.path ?? "")}
                          title={tab.path}
                          onClick={() => setActivePath(tab.path)}
                        >
                          <FileIcon fileName={tab.path} />
                          <span>{tab.path.split("/").at(-1)}</span>
                        </button>
                        <button
                          className="file-reader-tab-close"
                          type="button"
                          aria-label={`Close ${tab.path}`}
                          onClick={() => closeTab(tab.path)}
                          onAuxClick={(event) => {
                            if (event.button === 1) {
                              event.preventDefault();
                              closeTab(tab.path);
                            }
                          }}
                        >
                          <X />
                        </button>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              ) : null}
              <div className="file-reader-body">
                {readError ? (
                  <p className="empty-compact" role="alert">
                    {readError}
                  </p>
                ) : null}
                {openingPath && !activeFile ? (
                  <p className="empty-compact" role="status">
                    Opening {openingPath.split("/").at(-1)}…
                  </p>
                ) : null}
                {activeFile ? (
                  activeFile.imageDataUrl ? (
                    <div className="file-reader-image">
                      <img
                        src={activeFile.imageDataUrl}
                        alt={activeFile.path.split("/").at(-1) ?? activeFile.path}
                      />
                    </div>
                  ) : activeFile.isBinary ? (
                    <p className="empty-compact">
                      This binary file cannot be safely previewed as text.
                    </p>
                  ) : (
                    <FilePreview
                      key={activeFile.path}
                      file={activeFile}
                      onAddSelection={onAddFileSelection}
                    />
                  )
                ) : null}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
        {!readerOpen ? (
          <p className="empty-compact file-reader-placeholder">
            Select a file from the project tree to preview it.
          </p>
        ) : null}
      </div>
      {contextMenu ? (
        <div
          ref={contextMenuRef}
          className="compact-action-menu file-context-menu"
          role="menu"
          aria-label={`Actions for ${contextMenu.file.path}`}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onKeyDown={handleMenuNavigation}
        >
          <div className="file-context-menu-path" title={contextMenu.file.path}>
            <FileIcon fileName={contextMenu.file.path} />
            <span>{contextMenu.file.path}</span>
          </div>
          {onMentionProjectFile ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onMentionProjectFile(contextMenu.file);
                setContextMenu(null);
              }}
            >
              <AtSign /> Add to chat as context
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void openProjectFile(contextMenu.file);
              setContextMenu(null);
            }}
          >
            <FolderOpen /> Open preview
          </button>
          {supportedFileOpeners.length || onRevealProjectFile ? (
            <div className="compact-action-menu-separator" role="separator" />
          ) : null}
          {onOpenProjectFileExternal
            ? supportedFileOpeners.map((opener) => (
                <button
                  type="button"
                  role="menuitem"
                  key={opener.id}
                  onClick={() => void openFileExternally(contextMenu.file, opener.id)}
                >
                  <SquareArrowOutUpRight /> Open in {opener.label}
                </button>
              ))
            : null}
          {onRevealProjectFile ? (
            <button type="button" role="menuitem" onClick={() => void revealFile(contextMenu.file)}>
              <FolderSearch /> Reveal in File Explorer
            </button>
          ) : null}
          {onRenameProjectFile || onMentionProjectFile ? (
            <div className="compact-action-menu-separator" role="separator" />
          ) : null}
          {onRenameProjectFile ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                startRename(contextMenu.file);
                setContextMenu(null);
              }}
            >
              <Pencil /> Rename
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void copyFilePath(contextMenu.file);
              setContextMenu(null);
            }}
          >
            <Copy /> Copy relative path
          </button>
        </div>
      ) : null}
      {folderMenu ? (
        <div
          ref={folderMenuRef}
          className="compact-action-menu file-context-menu"
          role="menu"
          aria-label={`Actions for folder ${folderMenu.path}`}
          style={{ left: folderMenu.x, top: folderMenu.y }}
          onKeyDown={handleMenuNavigation}
        >
          <div className="file-context-menu-path" title={folderMenu.path}>
            <AnimatedFolderIcon open={false} className="tree-folder-icon" />
            <span>{folderMenu.path}/</span>
          </div>
          {onMentionProjectFolder ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onMentionProjectFolder(folderMenu.path);
                setFolderMenu(null);
              }}
            >
              <AtSign /> Add to chat as context
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void navigator.clipboard?.writeText(folderMenu.path).catch(() => undefined);
              setFolderMenu(null);
            }}
          >
            <Copy /> Copy relative path
          </button>
        </div>
      ) : null}
    </div>
  );
}

interface FileSyntaxToken {
  text: string;
  kind: "keyword" | "string" | "type" | "comment" | "function" | "plain";
}

const FILE_KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "else",
  "export",
  "extends",
  "fn",
  "for",
  "from",
  "function",
  "if",
  "impl",
  "import",
  "in",
  "interface",
  "let",
  "match",
  "mod",
  "mut",
  "new",
  "pub",
  "return",
  "self",
  "static",
  "struct",
  "switch",
  "throw",
  "try",
  "type",
  "use",
  "var",
  "while",
]);

function highlightFileLine(line: string): FileSyntaxToken[] {
  if (!line) return [{ text: " ", kind: "plain" }];
  const tokens: FileSyntaxToken[] = [];
  const pattern =
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/.*|#.*|\/\*.*?\*\/|\b[A-Za-z_$][\w$]*\b)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line))) {
    if (match.index > cursor) tokens.push({ text: line.slice(cursor, match.index), kind: "plain" });
    const text = match[0];
    const after = line.slice(match.index + text.length);
    const kind =
      text.startsWith("//") || text.startsWith("#") || text.startsWith("/*")
        ? "comment"
        : /^["'`]/.test(text)
          ? "string"
          : FILE_KEYWORDS.has(text)
            ? "keyword"
            : /^[A-Z]/.test(text)
              ? "type"
              : /^\s*\(/.test(after)
                ? "function"
                : "plain";
    tokens.push({ text, kind });
    cursor = match.index + text.length;
  }
  if (cursor < line.length) tokens.push({ text: line.slice(cursor), kind: "plain" });
  return tokens.length ? tokens : [{ text: line, kind: "plain" }];
}

interface ProjectTreeNode {
  folders: Map<string, ProjectTreeNode>;
  files: ProjectFileEntry[];
}

function buildProjectTree(files: ProjectFileEntry[]): ProjectTreeNode {
  const root: ProjectTreeNode = { folders: new Map(), files: [] };
  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean);
    const filename = segments.pop();
    if (!filename) continue;
    let current = root;
    for (const segment of segments) {
      const next = current.folders.get(segment) ?? {
        folders: new Map(),
        files: [],
      };
      current.folders.set(segment, next);
      current = next;
    }
    current.files.push(file);
  }
  return root;
}

interface ProjectTreeCallbacks {
  onOpenFile: (file: ProjectFileEntry) => void;
  /** Present only when the host can rename files (native builds). */
  onStartRename?: (file: ProjectFileEntry) => void;
  onCommitRename: (file: ProjectFileEntry, newName: string) => void;
  onCancelRename: () => void;
  onContextMenu: (
    file: ProjectFileEntry,
    x: number,
    y: number,
    source?: HTMLElement | null,
    keyboard?: boolean,
  ) => void;
  /** Present only when the host can mention folders as chat context. */
  onFolderContextMenu?: (path: string, x: number, y: number) => void;
}

function TreeRenameInput({
  file,
  depth,
  onCommit,
  onCancel,
}: {
  file: ProjectFileEntry;
  depth: number;
  onCommit: (file: ProjectFileEntry, newName: string) => void;
  onCancel: () => void;
}) {
  const currentName = file.path.split("/").at(-1) ?? "";
  const [name, setName] = useState(currentName);
  const inputRef = useRef<HTMLInputElement>(null);
  // Preselect the stem so typing replaces the name but keeps the extension.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    const stemEnd = currentName.lastIndexOf(".");
    input.setSelectionRange(0, stemEnd > 0 ? stemEnd : currentName.length);
  }, [currentName]);
  return (
    <div className="tree-rename" style={{ "--tree-depth": depth } as CSSProperties}>
      <FileIcon fileName={name || currentName} />
      <input
        ref={inputRef}
        value={name}
        aria-label={`Rename ${file.path}`}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onCommit(file, name);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => onCommit(file, name)}
      />
    </div>
  );
}

function ProjectTree({
  node,
  collapsedFolders,
  forceExpanded,
  onToggleFolder,
  onOpenFile,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onContextMenu,
  onFolderContextMenu,
  activePath,
  openingPath,
  renamingPath,
  path = "",
  depth = 0,
}: ProjectTreeCallbacks & {
  node: ProjectTreeNode;
  collapsedFolders: Set<string>;
  forceExpanded: boolean;
  onToggleFolder: (path: string) => void;
  activePath?: string;
  openingPath?: string;
  renamingPath?: string;
  path?: string;
  depth?: number;
}) {
  return (
    <>
      {[...node.folders.entries()].map(([name, child]) => {
        const folderPath = path ? `${path}/${name}` : name;
        const expansionKey = `project:${folderPath}`;
        const expanded = forceExpanded || !collapsedFolders.has(expansionKey);
        return (
          <div key={folderPath}>
            <button
              className="tree-folder"
              type="button"
              data-tree-depth={depth}
              style={{ "--tree-depth": depth } as CSSProperties}
              aria-expanded={expanded}
              aria-label={`${expanded ? "Collapse" : "Expand"} folder ${folderPath}`}
              onClick={() => onToggleFolder(expansionKey)}
              onContextMenu={(event) => {
                if (!onFolderContextMenu) return;
                event.preventDefault();
                onFolderContextMenu(folderPath, event.clientX, event.clientY);
              }}
            >
              <ChevronRight className="tree-chevron" />
              <AnimatedFolderIcon open={expanded} className="tree-folder-icon" />
              <span>{name}</span>
            </button>
            <AnimatePresence initial={false}>
              {expanded ? (
                <motion.div
                  key="children"
                  className="tree-children"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.18, ease: "easeInOut" }}
                >
                  <ProjectTree
                    node={child}
                    collapsedFolders={collapsedFolders}
                    forceExpanded={forceExpanded}
                    onToggleFolder={onToggleFolder}
                    onOpenFile={onOpenFile}
                    onStartRename={onStartRename}
                    onCommitRename={onCommitRename}
                    onCancelRename={onCancelRename}
                    onContextMenu={onContextMenu}
                    onFolderContextMenu={onFolderContextMenu}
                    activePath={activePath}
                    openingPath={openingPath}
                    renamingPath={renamingPath}
                    path={folderPath}
                    depth={depth + 1}
                  />
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        );
      })}
      {node.files.map((file) =>
        renamingPath === file.path ? (
          <TreeRenameInput
            key={`project-${file.path}`}
            file={file}
            depth={depth}
            onCommit={onCommitRename}
            onCancel={onCancelRename}
          />
        ) : (
          <motion.button
            type="button"
            key={`project-${file.path}`}
            data-tree-depth={depth}
            style={{ "--tree-depth": depth } as CSSProperties}
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.14, ease: "easeOut" }}
            onClick={() => onOpenFile(file)}
            onDoubleClick={() => onStartRename?.(file)}
            onContextMenu={(event) => {
              event.preventDefault();
              onContextMenu(file, event.clientX, event.clientY, event.currentTarget);
            }}
            onKeyDown={(event) => {
              if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                event.preventDefault();
                const bounds = event.currentTarget.getBoundingClientRect();
                onContextMenu(file, bounds.right - 12, bounds.bottom, event.currentTarget, true);
              }
            }}
            title={`Open ${file.path}`}
            aria-current={activePath === file.path ? "page" : undefined}
            aria-busy={openingPath === file.path}
            data-active={activePath === file.path}
          >
            <FileIcon fileName={file.path} />
            <span>{file.path.split("/").at(-1)}</span>
            <small>{formatFileSize(file.size)}</small>
          </motion.button>
        ),
      )}
    </>
  );
}

function formatFileSize(size: number): string {
  if (size < 1_000) return `${size} B`;
  if (size < 1_000_000) return `${Math.round(size / 1_000)} KB`;
  return `${(size / 1_000_000).toFixed(1)} MB`;
}

function UsagePanel({ usage }: { usage: UsageSnapshot }) {
  const hasVendorPlan = usage.subscriptionPercent !== undefined;
  return (
    <div className="rail-panel usage-panel">
      <header className="rail-panel-header">
        <span>
          <CircleDollarSign /> Usage evidence
        </span>
      </header>
      <div className="usage-hero">
        <div
          className="usage-ring"
          style={
            {
              "--usage": `${usage.subscriptionPercent ?? 0}%`,
            } as React.CSSProperties
          }
        >
          <strong>
            {usage.subscriptionPercent === undefined ? "—" : `${usage.subscriptionPercent}%`}
          </strong>
          <span>plan window</span>
        </div>
        <div>
          <strong>
            {hasVendorPlan
              ? `Resets ${usage.resetAt ?? "when reported"}`
              : "Vendor plan unavailable"}
          </strong>
          <span>
            {hasVendorPlan
              ? "Subscription and API usage stay separate."
              : "Local turn evidence is tracked separately; no plan percentage is inferred."}
          </span>
        </div>
      </div>
      <div className="usage-metrics">
        {usage.metrics.map((metric) => (
          <div key={metric.label}>
            <span>
              {metric.label}
              <small data-provenance={metric.provenance}>
                {metric.provenance.replace("_", " ")}
              </small>
            </span>
            <strong>{metric.value}</strong>
            <p>{metric.detail}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function RightRail(props: RightRailProps) {
  const [tab, setTab] = useState<RailTab>("git");
  const { onRequestProjectFiles } = props;
  const handledTabRequestRef = useRef<number | null>(null);
  useEffect(() => {
    const request = props.openProjectFileRequest;
    if (!request || handledTabRequestRef.current === request.id) return;
    // Mark the request handled inside the timer so a StrictMode remount that
    // clears the pending timeout does not swallow the tab switch.
    const timer = window.setTimeout(() => {
      handledTabRequestRef.current = request.id;
      setTab("files");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [props.openProjectFileRequest]);
  useEffect(() => {
    if (tab === "files") onRequestProjectFiles?.();
  }, [onRequestProjectFiles, tab]);
  const tabs: Array<{
    id: RailTab;
    label: string;
    icon: typeof GitBranch;
    count?: number;
  }> = [
    { id: "git", label: "Git", icon: GitBranch, count: props.git.files.length },
    {
      id: "agents",
      label: "Agents",
      icon: Users,
      count: props.delegations?.length
        ? props.delegations.filter((delegation) =>
            ["starting", "running", "waiting", "pending-approval"].includes(delegation.status),
          ).length
        : props.children.filter((agent) => agent.status === "running").length,
    },
    { id: "files", label: "Files", icon: FileText },
    { id: "usage", label: "Usage", icon: Radio },
  ];

  const moveTabFocus = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    const nextTab = tabs[nextIndex];
    setTab(nextTab.id);
    document.getElementById(`task-tools-tab-${nextTab.id}`)?.focus();
  };

  return (
    <aside
      className="right-rail"
      aria-label="Task tools"
      data-conversation-open={Boolean(props.selectedDelegationId)}
    >
      {props.onResize ? (
        <ResizeHandle
          axis="horizontal"
          label="Resize task tools sidebar"
          onResize={(delta) => props.onResize?.(delta)}
        />
      ) : null}
      <div className="rail-tabs" role="tablist" aria-label="Task tools">
        {tabs.map((item, index) => (
          <button
            key={item.id}
            id={`task-tools-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={`task-tools-panel-${item.id}`}
            tabIndex={tab === item.id ? 0 : -1}
            data-active={tab === item.id}
            onClick={() => setTab(item.id)}
            onKeyDown={(event) => moveTabFocus(event, index)}
          >
            <item.icon />
            <span>{item.label}</span>
            {item.count !== undefined ? <small>{item.count}</small> : null}
          </button>
        ))}
      </div>
      <div id={`task-tools-panel-${tab}`} role="tabpanel" aria-labelledby={`task-tools-tab-${tab}`}>
        {tab === "git" ? <GitPanel {...props} /> : null}
        {tab === "agents" ? (
          <AgentPanel
            agents={props.children}
            delegations={props.delegations}
            onApprove={props.onApproveDelegation}
            onDeny={props.onDenyDelegation}
            onNudge={props.onNudgeDelegation}
            onStop={props.onStopDelegation}
            selectedDelegationId={props.selectedDelegationId}
            onSelectDelegation={props.onSelectDelegation ?? (() => undefined)}
          />
        ) : null}
        {tab === "files" ? (
          // Keyed by project so open tabs, filter, and folder state reset
          // naturally when the selected project changes.
          <FilePanel
            key={props.projectId ?? "no-project"}
            projectFiles={props.projectFiles}
            projectFilesState={props.projectFilesState}
            openProjectFileRequest={props.openProjectFileRequest}
            onOpenProjectFile={props.onOpenProjectFile}
            onRenameProjectFile={props.onRenameProjectFile}
            onMentionProjectFile={props.onMentionProjectFile}
            onMentionProjectFolder={props.onMentionProjectFolder}
            onAddFileSelection={props.onAddFileSelection}
            fileOpeners={props.fileOpeners}
            onOpenProjectFileExternal={props.onOpenProjectFileExternal}
            onRevealProjectFile={props.onRevealProjectFile}
          />
        ) : null}
        {tab === "usage" ? <UsagePanel usage={props.usage} /> : null}
      </div>
    </aside>
  );
}
