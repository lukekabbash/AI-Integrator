import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
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
  CloudUpload,
  Download,
  FileText,
  FolderOpen,
  FolderSearch,
  GitBranch,
  GitCommitHorizontal,
  GitCompare,
  Link,
  Minus,
  Pencil,
  Plus,
  Radio,
  RefreshCw,
  SquareArrowOutUpRight,
  Sparkles,
  Users,
} from "lucide-react";
import { AnimatedFolderIcon } from "./AnimatedFolderIcon";
import { AgentGlyph } from "./AgentGlyph";
import { ProviderIcon } from "./Dropdown";
import { FileIcon } from "./FileIcon";
import { ProgressiveSurfaceControls } from "./FileView";
import {
  diffFileKey,
  type ChildAgent,
  type DelegationView,
  type DiffFile,
  type GitCommit,
  type GitSnapshot,
  type ProjectFileEntry,
  type ProjectFileOpener,
  type RuntimeId,
  type SubscriptionQuota,
  type SubscriptionWindow,
  type UsageSnapshot,
} from "../bridge";
import { ResizeHandle } from "./ResizeHandle";
import { SlidingTabIndicator } from "./SlidingTabIndicator";
import { Tooltip } from "./Tooltip";
import { TravelingSelection } from "./TravelingSelection";

export type { FileSelectionPayload } from "./FileView";

const loadGitRemoteDialog = () => import("./GitRemoteDialog");
const GitRemoteDialog = lazy(() =>
  loadGitRemoteDialog().then((module) => ({ default: module.GitRemoteDialog })),
);

type RailTab = "git" | "agents" | "files" | "usage";

const INITIAL_FILE_TREE_ENTRIES = 300;
const FILE_TREE_CHUNK = 300;
const INITIAL_GIT_FILE_ROWS = 200;
const GIT_FILE_CHUNK = 200;

const GRAPH_LANE_WIDTH = 9;
const GRAPH_ROW_HEIGHT = 35;
const GRAPH_MAX_LANES = 6;
/** One vivid hue per lane, Cursor-style, so a side branch reads as a single
 * colored thread. Lane 0 follows the app accent; the rest are fixed hues
 * chosen to stay legible on both light and dark themes. */
const GRAPH_LANE_COLORS = [
  "var(--color-accent)",
  "#d0679d",
  "#5aa7e0",
  "#c9a227",
  "#9a7ecc",
  "#5fb08a",
];

interface CommitGraphEdge {
  from: number;
  to: number;
  /** Edge bends into (or out of) this row's node instead of passing through. */
  node: boolean;
}

interface CommitGraphRow {
  lane: number;
  incoming: CommitGraphEdge[];
  outgoing: CommitGraphEdge[];
  laneCount: number;
}

/**
 * Assign a lane to every commit the way VS Code's commit graph does: each
 * lane tracks the hash it expects next, merges join lanes into the commit's
 * node, and extra parents fork new lanes below it. Parents that fall outside
 * the truncated log keep their lane running off the bottom edge.
 */
function buildCommitGraph(commits: GitCommit[]): CommitGraphRow[] {
  const lanes: Array<string | null> = [];
  return commits.map((commit) => {
    const expecting = lanes.flatMap((hash, index) => (hash === commit.id ? [index] : []));
    let lane = expecting.length ? expecting[0] : lanes.indexOf(null);
    if (lane === -1) lane = lanes.length;
    const incoming: CommitGraphEdge[] = [];
    lanes.forEach((hash, index) => {
      if (hash === null) return;
      if (hash === commit.id) incoming.push({ from: index, to: lane, node: true });
      else incoming.push({ from: index, to: index, node: false });
    });
    for (const index of expecting) lanes[index] = null;
    const parents = commit.parents ?? [];
    const outgoing: CommitGraphEdge[] = [];
    if (parents.length) {
      lanes[lane] = parents[0];
      outgoing.push({ from: lane, to: lane, node: true });
      for (const parent of parents.slice(1)) {
        let parentLane = lanes.indexOf(parent);
        if (parentLane === -1) {
          parentLane = lanes.indexOf(null);
          if (parentLane === -1) parentLane = lanes.length;
          lanes[parentLane] = parent;
        }
        outgoing.push({ from: lane, to: parentLane, node: true });
      }
    } else {
      lanes[lane] = null;
    }
    lanes.forEach((hash, index) => {
      if (hash === null || index === lane) return;
      if (outgoing.some((edge) => edge.node && edge.to === index)) return;
      outgoing.push({ from: index, to: index, node: false });
    });
    while (lanes.length && lanes.at(-1) === null) lanes.pop();
    const laneCount = [...incoming, ...outgoing].reduce(
      (max, edge) => Math.max(max, edge.from + 1, edge.to + 1),
      lane + 1,
    );
    return { lane, incoming, outgoing, laneCount: Math.min(laneCount, GRAPH_MAX_LANES) };
  });
}

function graphLaneX(lane: number): number {
  return 4.5 + lane * GRAPH_LANE_WIDTH;
}

function graphEdgePath(edge: CommitGraphEdge, half: "top" | "bottom"): string {
  const from = graphLaneX(edge.from);
  const to = graphLaneX(edge.to);
  const mid = GRAPH_ROW_HEIGHT / 2;
  if (half === "top") {
    if (!edge.node || edge.from === edge.to) return `M ${from} 0 L ${from} ${mid}`;
    return `M ${from} 0 C ${from} ${mid - 4}, ${to} ${mid - 12}, ${to} ${mid}`;
  }
  if (!edge.node || edge.from === edge.to) return `M ${from} ${mid} L ${from} ${GRAPH_ROW_HEIGHT}`;
  return `M ${from} ${mid} C ${to} ${mid + 12}, ${to} ${mid + 4}, ${to} ${GRAPH_ROW_HEIGHT}`;
}

function CommitGraphCell({
  row,
  current,
  unpushed,
  merge,
  tooltip,
}: {
  row: CommitGraphRow;
  current: boolean;
  unpushed: boolean;
  merge: boolean;
  tooltip: string;
}) {
  const width = row.laneCount * GRAPH_LANE_WIDTH;
  const laneColor = GRAPH_LANE_COLORS[row.lane % GRAPH_LANE_COLORS.length];
  const edges = [
    ...row.incoming.map((edge) => ({ edge, half: "top" as const })),
    ...row.outgoing.map((edge) => ({ edge, half: "bottom" as const })),
  ].filter(({ edge }) => edge.from < GRAPH_MAX_LANES && edge.to < GRAPH_MAX_LANES);
  return (
    <svg
      className="commit-graph-cell"
      width={width}
      height={GRAPH_ROW_HEIGHT}
      viewBox={`0 0 ${width} ${GRAPH_ROW_HEIGHT}`}
      role="img"
      aria-label={tooltip}
    >
      <title>{tooltip}</title>
      {edges.map(({ edge, half }, index) => (
        <path
          key={`${half}-${index}`}
          d={graphEdgePath(edge, half)}
          fill="none"
          stroke={GRAPH_LANE_COLORS[Math.max(edge.from, edge.to) % GRAPH_LANE_COLORS.length]}
          strokeWidth="1.5"
        />
      ))}
      {current ? (
        <circle
          cx={graphLaneX(row.lane)}
          cy={GRAPH_ROW_HEIGHT / 2}
          r={5.6}
          fill="none"
          stroke={laneColor}
          strokeWidth="1"
          opacity="0.45"
        />
      ) : null}
      <circle
        className="commit-graph-node"
        cx={graphLaneX(row.lane)}
        cy={GRAPH_ROW_HEIGHT / 2}
        r={3.4}
        fill={unpushed ? "var(--color-rail)" : laneColor}
        stroke={laneColor}
        strokeWidth="1.6"
      />
      {merge ? (
        <circle
          cx={graphLaneX(row.lane)}
          cy={GRAPH_ROW_HEIGHT / 2}
          r={1.3}
          fill={unpushed ? laneColor : "var(--color-rail)"}
        />
      ) : null}
    </svg>
  );
}

interface CommitRefChip {
  label: string;
  kind: "local" | "remote" | "tag" | "more";
  title?: string;
}

/**
 * Collapse raw `%D` decorations into at most two low-noise chips: drop
 * `<remote>/HEAD` pointers, drop the current branch (the Graph header and
 * tip node already say where it is — including its remote twin when it sits
 * on the same commit), fold any other local branch with its remote-tracking
 * twin into one chip, and fold anything past two into a `+n` chip whose
 * tooltip lists the rest.
 */
function collapseCommitRefs(refs: string[], upstream: string, branch: string): CommitRefChip[] {
  const remote = upstream.includes("/") ? `${upstream.split("/")[0]}/` : "origin/";
  const names = refs.filter((name) => !name.endsWith("/HEAD"));
  const consumed = new Set<string>();
  if (names.includes(branch)) {
    consumed.add(branch);
    consumed.add(`${remote}${branch}`);
    consumed.add(`origin/${branch}`);
  }
  const chips: CommitRefChip[] = [];
  for (const name of names) {
    if (consumed.has(name)) continue;
    if (name.startsWith("tag: ")) {
      chips.push({ label: name.slice(5), kind: "tag" });
      continue;
    }
    if (name.startsWith(remote) || name.startsWith("origin/")) {
      chips.push({ label: name, kind: "remote" });
      continue;
    }
    const twin = names.find(
      (candidate) => candidate === `${remote}${name}` || candidate === `origin/${name}`,
    );
    if (twin) consumed.add(twin);
    chips.push({ label: name, kind: "local", title: twin ? `${name} · also at ${twin}` : name });
  }
  if (chips.length > 2) {
    const extra = chips.splice(2);
    chips.push({
      label: `+${extra.length}`,
      kind: "more",
      title: extra.map((chip) => chip.label).join(", "),
    });
  }
  return chips;
}

interface RightRailProps {
  git: GitSnapshot;
  /** True while the selected folder is being checked for an existing repository. */
  gitLoading?: boolean;
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
  /** Active runtime and its provider-reported plan windows, when exposed. */
  runtime?: RuntimeId;
  subscription?: SubscriptionQuota;
  activeFile?: DiffFile;
  /** Clears in-rail open file tabs when the selected project changes. */
  projectId?: string;
  projectFiles?: ProjectFileEntry[];
  projectFilesState?: "loading" | "ready" | "unavailable";
  /** Starts the bounded project scan only when the Files surface is opened. */
  onRequestProjectFiles?: () => void;
  onSelectFile: (file: DiffFile) => void;
  /** Opens a project file as a first-class titlebar tab in the primary canvas. */
  onOpenFile?: (file: ProjectFileEntry) => void;
  /** The canvas file tab currently shown, highlighted in the tree. */
  activeFilePath?: string;
  /** A file mid-open toward the canvas, marked busy in the tree. */
  openingFilePath?: string;
  /** Renames a project file in place; the caller refreshes the file list. */
  onRenameProjectFile?: (file: ProjectFileEntry, newName: string) => Promise<void>;
  /** Inserts the file as an @context mention into the main chat composer. */
  onMentionProjectFile?: (file: ProjectFileEntry) => void;
  /** Inserts a folder as an @context mention into the main chat composer. */
  onMentionProjectFolder?: (path: string) => void;
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
  onInitializeGit?: () => Promise<void>;
  onAddRemote?: (name: string, url: string) => Promise<void>;
  onUpdateRemote?: (name: string, url: string) => Promise<void>;
  onRemoveRemote?: (name: string) => Promise<void>;
  onFetch?: (remote?: string) => Promise<void>;
  onPull?: (mode: "fastForwardOnly" | "rebase") => Promise<void>;
  onPublishBranch?: (remote: string) => Promise<void>;
  onPublishGithub?: (input: {
    nameWithOwner: string;
    visibility: "private" | "public" | "internal";
    remote: string;
  }) => Promise<void>;
  /** Append the next page of older commits to the graph. */
  onLoadMoreGitHistory?: () => Promise<void>;
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
  gitLoading,
  activeFile,
  onSelectFile,
  onStageFile,
  onStageFiles,
  onCommit,
  onGenerateCommitMessage,
  onPush,
  onRefreshGit,
  onInitializeGit,
  onAddRemote,
  onUpdateRemote,
  onRemoveRemote,
  onFetch,
  onPull,
  onPublishBranch,
  onPublishGithub,
  onLoadMoreGitHistory,
  fileOpeners = [],
  onOpenGitFileExternal,
  onRevealGitFile,
}: Pick<
  RightRailProps,
  | "git"
  | "gitLoading"
  | "activeFile"
  | "onSelectFile"
  | "onStageFile"
  | "onStageFiles"
  | "onCommit"
  | "onGenerateCommitMessage"
  | "onPush"
  | "onRefreshGit"
  | "onInitializeGit"
  | "onAddRemote"
  | "onUpdateRemote"
  | "onRemoveRemote"
  | "onFetch"
  | "onPull"
  | "onPublishBranch"
  | "onPublishGithub"
  | "onLoadMoreGitHistory"
  | "fileOpeners"
  | "onOpenGitFileExternal"
  | "onRevealGitFile"
>) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<
    "commit" | "commit-push" | "generate" | "push" | "stage" | "refresh" | "remote" | null
  >(null);
  const reduceMotion = useReducedMotion();
  const [stagingPath, setStagingPath] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [stagedLimit, setStagedLimit] = useState(INITIAL_GIT_FILE_ROWS);
  const [unstagedLimit, setUnstagedLimit] = useState(INITIAL_GIT_FILE_ROWS);
  const [commitMenuOpen, setCommitMenuOpen] = useState(false);
  const [remoteDialog, setRemoteDialog] = useState<
    "manage" | "connect" | "github" | "branch" | null
  >(null);
  // Warm the lazy dialog chunk shortly after the panel mounts so the first
  // open animates immediately instead of stalling on the import.
  useEffect(() => {
    const warm = window.setTimeout(() => void loadGitRemoteDialog(), 500);
    return () => window.clearTimeout(warm);
  }, []);
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
  const graphRows = useMemo(() => buildCommitGraph(git.commits), [git.commits]);
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

  const runRemoteAction = async (action: () => Promise<void>, close = false) => {
    if (busy !== null) return;
    setBusy("remote");
    setActionError(null);
    try {
      await action();
      if (close) setRemoteDialog(null);
    } catch (error) {
      setActionError(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const runLoadMoreHistory = async () => {
    if (!onLoadMoreGitHistory || loadingHistory) return;
    setLoadingHistory(true);
    setActionError(null);
    try {
      await onLoadMoreGitHistory();
    } catch (error) {
      setActionError(getErrorMessage(error));
    } finally {
      setLoadingHistory(false);
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

  const fileRow = (file: DiffFile, isStaged: boolean) => {
    const key = diffFileKey(file);
    return (
      <div
        className="git-file-row"
        data-active={activeFile ? diffFileKey(activeFile) === diffFileKey(file) : false}
        data-traveling-selection={key}
        key={key}
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
              openFileContextMenu(
                file,
                bounds.right - 12,
                bounds.bottom,
                event.currentTarget,
                true,
              );
            }
          }}
          title={file.path}
          aria-pressed={activeFile ? diffFileKey(activeFile) === diffFileKey(file) : false}
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
  };

  if (gitLoading) {
    return (
      <div
        className="rail-panel git-panel git-panel--skeleton"
        role="status"
        aria-live="polite"
        aria-label="Checking repository"
      >
        <span className="sr-only">Checking repository…</span>
        <i className="git-skeleton-block git-skeleton-composer" aria-hidden="true" />
        <i className="git-skeleton-block git-skeleton-commit" aria-hidden="true" />
        <div className="git-skeleton-meta" aria-hidden="true">
          <i className="git-skeleton-block git-skeleton-sync" />
          <i className="git-skeleton-block git-skeleton-stat" />
          <i className="git-skeleton-block git-skeleton-refresh" />
        </div>
        <div className="git-skeleton-section" aria-hidden="true">
          <div className="git-skeleton-section-head">
            <i className="git-skeleton-block git-skeleton-label" />
            <i className="git-skeleton-block git-skeleton-action" />
          </div>
          {[72, 58, 66].map((width) => (
            <div className="git-skeleton-file" key={width}>
              <i className="git-skeleton-block git-skeleton-file-icon" />
              <i
                className="git-skeleton-block git-skeleton-file-name"
                style={{ width: `${width}%` }}
              />
              <i className="git-skeleton-block git-skeleton-file-stat" />
            </div>
          ))}
        </div>
        <div className="git-skeleton-graph" aria-hidden="true">
          <div className="git-skeleton-section-head">
            <i className="git-skeleton-block git-skeleton-label git-skeleton-label--graph" />
            <i className="git-skeleton-block git-skeleton-action" />
          </div>
          {[78, 64, 70, 56].map((width) => (
            <div className="git-skeleton-commit-row" key={width}>
              <i className="git-skeleton-node" />
              <span>
                <i
                  className="git-skeleton-block git-skeleton-commit-subject"
                  style={{ width: `${width}%` }}
                />
                <i className="git-skeleton-block git-skeleton-commit-meta" />
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (git.kind === "notRepository") {
    return (
      <div className="rail-panel git-panel git-panel--empty">
        <div className="git-setup-state">
          <span className="git-setup-icon" aria-hidden="true">
            <GitBranch />
          </span>
          <h3>Set up Git for this folder</h3>
          <p>Track changes, create commits, and connect a remote when you’re ready.</p>
          <button
            type="button"
            className="primary-button"
            disabled={!onInitializeGit || busy !== null}
            aria-busy={busy === "remote"}
            onClick={() => {
              if (onInitializeGit) void runRemoteAction(onInitializeGit);
            }}
          >
            <GitBranch /> {busy === "remote" ? "Setting up…" : "Set up Git"}
          </button>
          <small>Your existing files won’t be changed.</small>
        </div>
        {actionError ? (
          <p className="git-action-error" role="alert">
            {actionError}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rail-panel git-panel">
      {git.remotes.length === 0 ? (
        <div className="git-local-only">
          <span>
            <strong>Local only</strong>
            <small>Add a remote when you want to share this repository.</small>
          </span>
          <button
            type="button"
            onClick={() => setRemoteDialog("github")}
            disabled={!onPublishGithub || busy !== null}
          >
            Publish to GitHub
          </button>
          <button
            type="button"
            onClick={() => setRemoteDialog("connect")}
            disabled={!onAddRemote || busy !== null}
          >
            Connect remote
          </button>
        </div>
      ) : null}
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
      </div>
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
          aria-label="More Git actions"
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
          <motion.span
            className="commit-menu-chevron"
            aria-hidden="true"
            animate={{ rotate: commitMenuOpen ? 180 : 0 }}
            transition={
              reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 480, damping: 30 }
            }
          >
            <ChevronDown />
          </motion.span>
        </button>
        <AnimatePresence>
          {commitMenuOpen ? (
            <motion.div
              className="compact-action-menu commit-action-menu"
              role="menu"
              aria-label="Git actions"
              onKeyDown={handleMenuNavigation}
              style={{ transformOrigin: "top right" }}
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={
                reduceMotion
                  ? { opacity: 0, transition: { duration: 0.08 } }
                  : {
                      opacity: 0,
                      y: -6,
                      scale: 0.97,
                      transition: { duration: 0.12, ease: "easeIn" },
                    }
              }
              transition={
                reduceMotion
                  ? { duration: 0.08 }
                  : { type: "spring", stiffness: 560, damping: 34, mass: 0.7 }
              }
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => void runCommitAndPush()}
                disabled={!git.upstream || !message.trim() || !staged.length}
              >
                <GitCommitHorizontal />
                <span>
                  <strong>Commit &amp; push</strong>
                  <small>
                    {!git.upstream
                      ? git.remotes.length
                        ? "Publish this branch first to enable pushing"
                        : "Connect a remote first to enable pushing"
                      : !staged.length
                        ? "Stage changes to commit"
                        : !message.trim()
                          ? "Write a commit message first"
                          : `Commit locally, then push to ${git.upstream}`}
                  </small>
                </span>
              </button>
              {git.upstream && git.ahead > 0 ? (
                <button type="button" role="menuitem" onClick={() => void runPush()}>
                  <SquareArrowOutUpRight />
                  <span>
                    <strong>Push {git.ahead}</strong>
                    <small>
                      {git.ahead} local commit{git.ahead === 1 ? "" : "s"}
                    </small>
                  </span>
                </button>
              ) : null}
              {git.remotes.length || git.upstream ? (
                <span className="compact-action-menu-separator" role="separator" />
              ) : null}
              {git.remotes.length ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setCommitMenuOpen(false);
                    void runRemoteAction(() => onFetch?.() ?? Promise.resolve());
                  }}
                >
                  <Download />
                  <span>
                    <strong>Fetch</strong>
                    <small>Update remote branches</small>
                  </span>
                </button>
              ) : null}
              {git.upstream ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setCommitMenuOpen(false);
                    void runRemoteAction(() => onPull?.("fastForwardOnly") ?? Promise.resolve());
                  }}
                >
                  <ArrowDown />
                  <span>
                    <strong>Pull</strong>
                    <small>Fast-forward only</small>
                  </span>
                </button>
              ) : null}
              {!git.upstream && git.remotes.length ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setCommitMenuOpen(false);
                    setRemoteDialog("branch");
                  }}
                >
                  <CloudUpload />
                  <span>
                    <strong>Publish branch</strong>
                    <small>Set an upstream remote</small>
                  </span>
                </button>
              ) : null}
              <span className="compact-action-menu-separator" role="separator" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setCommitMenuOpen(false);
                  setRemoteDialog("manage");
                }}
              >
                <Link />
                <span>
                  <strong>Manage remotes</strong>
                  <small>Add, edit, remove, or fetch</small>
                </span>
              </button>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
      <div className="git-commit-meta">
        <Tooltip
          label={`${git.ahead} ahead · ${git.behind} behind${git.upstream ? ` · ${git.upstream}` : ""}`}
        >
          <span
            className="git-sync-summary"
            data-dirty={git.ahead > 0 || git.behind > 0}
            aria-label={`${git.ahead} commits ahead, ${git.behind} behind ${git.upstream || "upstream"}`}
          >
            {git.ahead} ahead <span aria-hidden="true">·</span> {git.behind} behind
          </span>
        </Tooltip>
        <div className="git-commit-meta-actions">
          <span
            className="git-line-summary"
            aria-label={
              lineStatsLoaded
                ? `${additions} lines added, ${deletions} lines removed in the working tree`
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
      </div>
      {actionError ? (
        <p className="git-action-error" role="alert">
          {actionError}
        </p>
      ) : null}
      {remoteDialog ? (
        <Suspense fallback={null}>
          <GitRemoteDialog
            mode={remoteDialog}
            git={git}
            onClose={() => setRemoteDialog(null)}
            onError={(message) => setActionError(message || null)}
            onAdd={onAddRemote}
            onUpdate={onUpdateRemote}
            onRemove={onRemoveRemote}
            onFetch={onFetch}
            onPublishBranch={onPublishBranch}
            onPublishGithub={onPublishGithub}
          />
        </Suspense>
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
            {staged.length ? (
              <button
                type="button"
                onClick={() => void runStageMany(staged, false)}
                disabled={busy !== null}
              >
                Unstage all
              </button>
            ) : null}
            <small>{staged.length}</small>
          </div>
          <div className="git-section-body">
            <TravelingSelection
              activeKey={activeFile ? diffFileKey(activeFile) : ""}
              className="git-file-active"
              layoutKey={`${stagedLimit}:${staged.map(diffFileKey).join("|")}`}
            />
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
            {unstaged.length ? (
              <button
                type="button"
                onClick={() => void runStageMany(unstaged, true)}
                disabled={busy !== null}
              >
                Stage all
              </button>
            ) : null}
            <small>{unstaged.length}</small>
          </div>
          <div className="git-section-body">
            <TravelingSelection
              activeKey={activeFile ? diffFileKey(activeFile) : ""}
              className="git-file-active"
              layoutKey={`${unstagedLimit}:${unstaged.map(diffFileKey).join("|")}`}
            />
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
              git.commits.map((commit, index) => {
                const merge = (commit.parents?.length ?? 0) > 1;
                const unpushed = commit.unpushed === true;
                return (
                  <div
                    className="commit-row"
                    key={`${commit.id}-${index}`}
                    data-current={commit.current}
                    data-unpushed={unpushed || undefined}
                  >
                    <CommitGraphCell
                      row={graphRows[index]}
                      current={commit.current === true}
                      unpushed={unpushed}
                      merge={merge}
                      tooltip={`${commit.id}${merge ? " · merge" : ""} · ${
                        unpushed
                          ? `not on ${git.upstream || "remote"}`
                          : `on ${git.upstream || "remote"}`
                      }`}
                    />
                    <span className="commit-text">
                      <span className="commit-subject">
                        <strong>{commit.subject}</strong>
                        {commit.refs?.length ? (
                          <span className="commit-refs">
                            {collapseCommitRefs(commit.refs, git.upstream, git.branch).map(
                              (chip) => (
                                <em key={chip.label} data-kind={chip.kind} title={chip.title}>
                                  {chip.label}
                                </em>
                              ),
                            )}
                          </span>
                        ) : null}
                      </span>
                      <small>
                        {commit.id} · {commit.relativeTime}
                        {unpushed ? <i className="commit-local-flag"> · local</i> : null}
                      </small>
                    </span>
                  </div>
                );
              })
            ) : (
              <p className="empty-compact">Commit history is not available for this task.</p>
            )}
            {git.commits.length && git.historyHasMore && onLoadMoreGitHistory ? (
              <button
                className="git-history-more"
                type="button"
                onClick={() => void runLoadMoreHistory()}
                disabled={loadingHistory}
              >
                {loadingHistory ? "Loading older commits…" : "Show older commits"}
              </button>
            ) : null}
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

function delegationStatusLabel(status: DelegationView["status"]): string {
  switch (status) {
    case "pending-approval":
      return "Approval needed";
    case "running":
      return "Working";
    case "completed":
      return "Complete";
    default:
      return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

interface AgentVisualIdentity {
  variant: number;
  shade: number;
}

function agentVisualIdentities(
  agents: Array<{ id: string; runtime: string }>,
): Map<string, AgentVisualIdentity> {
  const collisions = new Map<string, number>();
  return new Map(
    agents.map((agent, index) => {
      const variant = index % 10;
      const collisionKey = `${agent.runtime}:${variant}`;
      const shade = collisions.get(collisionKey) ?? 0;
      collisions.set(collisionKey, shade + 1);
      return [agent.id, { variant, shade }] as const;
    }),
  );
}

function providerLabel(runtime: string): string {
  switch (runtime) {
    case "codex":
      return "Codex";
    case "claude":
      return "Claude";
    case "cursor":
      return "Cursor";
    case "grok":
      return "Grok";
    case "antigravity":
      return "Antigravity";
    default:
      return runtime.charAt(0).toUpperCase() + runtime.slice(1);
  }
}

function AgentRoute({
  runtime,
  model,
  elapsed,
}: {
  runtime: string;
  model?: string | null;
  elapsed?: string;
}) {
  const label = providerLabel(runtime);
  return (
    <small className="agent-route">
      <ProviderIcon provider={runtime} label={label} />
      <span>{label}</span>
      {model ? (
        <>
          <span aria-hidden="true">·</span>
          <span>{model}</span>
        </>
      ) : null}
      {elapsed ? (
        <>
          <span aria-hidden="true">·</span>
          <span>{elapsed}</span>
        </>
      ) : null}
    </small>
  );
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

function childAgentLineage(agents: ChildAgent[]): Array<{ agent: ChildAgent; depth: number }> {
  const childrenByParent = new Map<string, ChildAgent[]>();
  const roots: ChildAgent[] = [];
  for (const agent of agents) {
    if (!agent.parentId || !agents.some((candidate) => candidate.id === agent.parentId)) {
      roots.push(agent);
      continue;
    }
    const children = childrenByParent.get(agent.parentId) ?? [];
    children.push(agent);
    childrenByParent.set(agent.parentId, children);
  }
  const ordered: Array<{ agent: ChildAgent; depth: number }> = [];
  const visited = new Set<string>();
  const visit = (agent: ChildAgent, depth: number) => {
    if (visited.has(agent.id)) return;
    visited.add(agent.id);
    ordered.push({ agent, depth });
    for (const child of childrenByParent.get(agent.id) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  for (const agent of agents) visit(agent, 0);
  return ordered;
}

function DelegationNudge({
  delegation,
  onNudge,
}: {
  delegation: DelegationView;
  onNudge: (delegationId: string, message: string) => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nudge = message.trim();
    if (!nudge || sending) return;
    setSending(true);
    setError("");
    try {
      await onNudge(delegation.id, nudge);
      setMessage("");
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : "Could not nudge this subagent.",
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <form className="agent-nudge" aria-label={`Nudge ${delegation.title}`} onSubmit={submit}>
      <input
        type="text"
        value={message}
        maxLength={32_768}
        placeholder="Nudge this subagent…"
        aria-label={`Nudge ${delegation.title}`}
        disabled={sending}
        onChange={(event) => setMessage(event.target.value)}
      />
      <button
        type="submit"
        aria-label={`Send nudge to ${delegation.title}`}
        disabled={sending || !message.trim()}
      >
        <ArrowUp aria-hidden="true" />
      </button>
      {error ? (
        <small role="alert" title={error}>
          {error}
        </small>
      ) : null}
    </form>
  );
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
    const identities = agentVisualIdentities(
      [...delegations].sort(
        (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id),
      ),
    );
    return (
      <div className="rail-panel agent-panel agent-panel--delegations">
        <div className="subagent-lineage-pane">
          <div className="delegation-tree" role="tree" aria-label="Subagent lineage">
            <AnimatePresence initial={false}>
              {delegationLineage(delegations).map(({ delegation, depth }, index) => (
                <DelegationRow
                  key={delegation.id}
                  delegation={delegation}
                  depth={depth}
                  identity={identities.get(delegation.id) ?? { variant: index % 10, shade: 0 }}
                  selected={delegation.id === selectedDelegation?.id}
                  focusable={
                    delegation.id === selectedDelegation?.id || (!selectedDelegation && index === 0)
                  }
                  onApprove={onApprove}
                  onDeny={onDeny}
                  onStop={onStop}
                  onOpen={() => onSelectDelegation(delegation.id)}
                />
              ))}
            </AnimatePresence>
          </div>
        </div>
        {selectedDelegation &&
        selectedDelegation.childTaskId &&
        !["pending-approval", "denied", "starting"].includes(selectedDelegation.status) &&
        onNudge ? (
          <DelegationNudge
            key={selectedDelegation.id}
            delegation={selectedDelegation}
            onNudge={onNudge}
          />
        ) : null}
      </div>
    );
  }
  const identities = agentVisualIdentities(agents);
  return (
    <div className="rail-panel agent-panel">
      {agents.length ? (
        <div className="agent-tree" role="tree" aria-label="Agent lineage">
          {childAgentLineage(agents).map(({ agent, depth }, index) => (
            <AgentRow
              agent={agent}
              depth={depth}
              identity={identities.get(agent.id) ?? { variant: index % 10, shade: 0 }}
              key={agent.id}
            />
          ))}
        </div>
      ) : (
        <div className="agent-empty">
          <Users aria-hidden="true" />
          <strong>No subagents yet</strong>
          <span>Enable delegation in the composer when this task would benefit from help.</span>
        </div>
      )}
    </div>
  );
}

function DelegationRow({
  delegation,
  depth,
  identity,
  selected,
  focusable,
  onApprove,
  onDeny,
  onStop,
  onOpen,
}: {
  delegation: DelegationView;
  depth: number;
  identity: AgentVisualIdentity;
  selected: boolean;
  focusable: boolean;
  onApprove?: (delegationId: string) => Promise<void>;
  onDeny?: (delegationId: string) => Promise<void>;
  onStop?: (delegationId: string) => Promise<void>;
  onOpen: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const active = ["starting", "running", "waiting"].includes(delegation.status);
  const canApprove = delegation.status === "pending-approval" && Boolean(onApprove);
  const canDeny = delegation.status === "pending-approval" && Boolean(onDeny);
  const canStop = active && Boolean(onStop) && !selected;
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
    <motion.div
      layout="position"
      className="agent-row delegation-row"
      data-status={delegation.status}
      data-selected={selected}
      data-openable={Boolean(delegation.childTaskId)}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected}
      tabIndex={focusable ? 0 : -1}
      style={{ "--delegation-depth": depth } as CSSProperties}
      initial={reduceMotion ? false : { opacity: 0, x: -5 }}
      animate={{ opacity: 1, x: 0 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -4 }}
      transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 460, damping: 36 }}
      onClick={(event) => {
        if (!delegation.childTaskId) return;
        if ((event.target as HTMLElement).closest("button, input")) return;
        onOpen();
      }}
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
      <AgentGlyph
        variant={identity.variant}
        shade={identity.shade}
        provider={delegation.runtime}
        state={delegation.status}
        label={delegation.title}
      />
      <span className="agent-copy">
        <span className="agent-heading">
          <strong>
            <span className="agent-title">{delegation.title}</span>
            <i>{delegation.profileLabel}</i>
          </strong>
          <span className="agent-state" data-status={delegation.status}>
            {delegationStatusLabel(delegation.status)}
          </span>
        </span>
        <span className="agent-activity" title={delegation.brief}>
          {delegation.brief}
        </span>
        <AgentRoute runtime={delegation.runtime} model={delegation.model} />
        {delegation.unreadFromChild > 0 ? (
          <span className="agent-unread">
            {delegation.unreadFromChild} new message
            {delegation.unreadFromChild === 1 ? "" : "s"}
          </span>
        ) : null}
        {delegation.pendingQuestions.map((question, index) => (
          <small className="delegation-question" key={index}>
            {question}
          </small>
        ))}
        {canApprove || canDeny || canStop ? (
          <span className="delegation-actions">
            {canApprove && onApprove ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(() => onApprove(delegation.id))}
              >
                Approve
              </button>
            ) : null}
            {canDeny && onDeny ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(() => onDeny(delegation.id))}
              >
                Deny
              </button>
            ) : null}
            {canStop && onStop ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(() => onStop(delegation.id))}
              >
                Stop
              </button>
            ) : null}
          </span>
        ) : null}
        {actionError ? <small className="delegation-error">{actionError}</small> : null}
      </span>
    </motion.div>
  );
}

function AgentRow({
  agent,
  depth,
  identity,
}: {
  agent: ChildAgent;
  depth: number;
  identity: AgentVisualIdentity;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      layout="position"
      className="agent-row"
      data-status={agent.status}
      role="treeitem"
      aria-level={depth + 1}
      style={{ "--delegation-depth": depth } as CSSProperties}
      initial={reduceMotion ? false : { opacity: 0, x: -5 }}
      animate={{ opacity: 1, x: 0 }}
      transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 460, damping: 36 }}
    >
      <AgentGlyph
        variant={identity.variant}
        shade={identity.shade}
        provider={agent.runtime}
        state={agent.status}
        label={agent.name}
      />
      <span className="agent-copy">
        <span className="agent-heading">
          <strong>
            <span className="agent-title">{agent.name}</span>
            <i>{agent.role}</i>
          </strong>
          <span className="agent-state" data-status={agent.status}>
            {agent.status === "running"
              ? "Working"
              : agent.status === "completed"
                ? "Complete"
                : agent.status.charAt(0).toUpperCase() + agent.status.slice(1)}
          </span>
        </span>
        <span className="agent-activity" title={agent.activity}>
          {agent.activity}
        </span>
        <AgentRoute runtime={agent.runtime} model={agent.model} elapsed={agent.elapsed} />
      </span>
    </motion.div>
  );
}

interface FileContextMenuState {
  x: number;
  y: number;
  file: ProjectFileEntry;
  source: HTMLElement | null;
  keyboard: boolean;
}

function FilePanel({
  projectFiles = [],
  projectFilesState = "unavailable",
  fileOpeners = [],
  onOpenFile,
  activeFilePath = "",
  openingFilePath = "",
  onRenameProjectFile,
  onMentionProjectFile,
  onMentionProjectFolder,
  onOpenProjectFileExternal,
  onRevealProjectFile,
}: Pick<
  RightRailProps,
  | "projectFiles"
  | "projectFilesState"
  | "fileOpeners"
  | "onOpenFile"
  | "activeFilePath"
  | "openingFilePath"
  | "onRenameProjectFile"
  | "onMentionProjectFile"
  | "onMentionProjectFolder"
  | "onOpenProjectFileExternal"
  | "onRevealProjectFile"
>) {
  const [filter, setFilter] = useState("");
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const [folderHidingSelection, setFolderHidingSelection] = useState("");
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
  const contextMenuRef = useRef<HTMLDivElement>(null);
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
  const supportedFileOpeners = useMemo(
    () => fileOpeners.filter((opener) => opener.id === "cursor" || opener.id === "vscode"),
    [fileOpeners],
  );
  const selectionFadingForFolder = folderHidingSelection
    ? activeFilePath?.startsWith(`${folderHidingSelection.slice("project:".length)}/`)
    : false;

  const toggleFolder = (path: string) => {
    if (collapsedFolders.has(path)) {
      setCollapsedFolders((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
      if (folderHidingSelection === path) setFolderHidingSelection("");
      return;
    }

    // Collapse immediately so the folder slides shut as usual; the selection
    // pill just fades out in place instead of traveling with the rows.
    const folderPath = path.slice("project:".length);
    if (activeFilePath?.startsWith(`${folderPath}/`)) setFolderHidingSelection(path);
    setCollapsedFolders((current) => {
      const next = new Set(current);
      next.add(path);
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
      // The canvas owner keeps any open file tab pointing at the renamed file.
      await onRenameProjectFile(file, newName);
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
      <div className="file-panel-split">
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
            <TravelingSelection
              activeKey={activeFilePath}
              className="file-tree-active"
              layoutKey={`${normalizedFilter}:${treeLimit}:${renamingPath}:${Array.from(
                collapsedFolders,
              )
                .sort()
                .join("|")}:${treeProjectFiles.map((file) => file.path).join("|")}`}
              visible={!selectionFadingForFolder}
            />
            {projectFilesState === "loading" ? (
              <p className="empty-compact">Reading trusted project files…</p>
            ) : null}
            {projectFilesState === "ready" && visibleProjectFiles.length ? (
              <ProjectTree
                node={projectTree}
                collapsedFolders={collapsedFolders}
                forceExpanded={Boolean(normalizedFilter)}
                onToggleFolder={toggleFolder}
                onOpenFile={(file) => onOpenFile?.(file)}
                activePath={activeFilePath}
                openingPath={openingFilePath}
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
              onOpenFile?.(contextMenu.file);
              setContextMenu(null);
            }}
          >
            <FolderOpen /> Open file
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
                  transition={{ duration: 0.26, ease: [0.2, 0.8, 0.2, 1] }}
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
            data-traveling-selection={file.path}
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

const PLAN_USAGE_GUIDANCE: Record<RuntimeId, string> = {
  codex:
    "No subscription window was returned for this sign-in. API-key usage is billed separately.",
  claude: "Open Claude Code and run /usage to see its plan limits.",
  cursor: "Open the Cursor dashboard to see included usage and token breakdowns.",
  grok: "Run /usage in Grok Build or open Settings → Usage on grok.com.",
  antigravity: "Open Antigravity Settings to see baseline quota by model.",
  custom: "This ACP agent has not supplied a plan limit.",
};

const PLAN_TYPE_LABELS: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  team: "Team",
  self_serve_business_usage_based: "Business",
  business: "Business",
  enterprise_cbp_usage_based: "Enterprise",
  enterprise: "Enterprise",
  edu: "Edu",
};

function usageRuntimeLabel(runtime?: RuntimeId): string {
  if (!runtime) return "Provider";
  return {
    codex: "Codex",
    cursor: "Cursor",
    claude: "Claude Code",
    grok: "Grok Build",
    antigravity: "Antigravity",
    custom: "Custom ACP",
  }[runtime];
}

function quotaWindowLabel(window: SubscriptionWindow, index: number): string {
  const mins = window.windowDurationMins;
  if (!mins) return index === 0 ? "Primary limit" : "Secondary limit";
  if (Math.abs(mins - 300) <= 15) return "5-hour limit";
  if (Math.abs(mins - 1440) <= 72) return "Daily limit";
  if (Math.abs(mins - 10_080) <= 504) return "Weekly limit";
  if (mins < 60) return `${mins}-minute limit`;
  if (mins < 1440) return `${Math.round(mins / 60)}-hour limit`;
  return `${Math.round(mins / 1440)}-day limit`;
}

function quotaResetLabel(resetsAt?: number): string {
  if (!resetsAt) return "Reset time not reported";
  const date = new Date(resetsAt * 1000);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return `Resets ${date.toLocaleString([], {
    weekday: sameDay ? undefined : "short",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function UsagePanel({
  usage,
  runtime,
  subscription,
}: {
  usage: UsageSnapshot;
  runtime?: RuntimeId;
  subscription?: SubscriptionQuota;
}) {
  const windows = [subscription?.primary, subscription?.secondary].filter(
    (window): window is SubscriptionWindow => window != null,
  );
  const metrics = usage.metrics.filter((metric) => metric.label !== "Subscription usage");
  const runtimeName = usageRuntimeLabel(runtime);
  const planName = subscription?.planType
    ? (PLAN_TYPE_LABELS[subscription.planType] ?? subscription.planType)
    : undefined;
  return (
    <div className="rail-panel usage-panel">
      <header className="rail-panel-header">
        <span>
          <CircleDollarSign /> Usage evidence
        </span>
      </header>
      <section className="usage-plan" aria-label={`${runtimeName} plan limits`}>
        <div className="usage-plan-heading">
          <span>Plan limits</span>
          <small>{planName ? `${runtimeName} ${planName}` : runtimeName}</small>
        </div>
        {windows.length ? (
          <>
            <div className="usage-windows">
              {windows.map((window, index) => {
                const percent = Math.max(0, Math.min(100, Math.round(window.usedPercent)));
                return (
                  <div
                    className="usage-window"
                    key={`${index}-${window.windowDurationMins ?? "unknown"}`}
                  >
                    <div>
                      <span>{quotaWindowLabel(window, index)}</span>
                      <strong>{percent}% used</strong>
                    </div>
                    <div
                      className="usage-window-track"
                      role="progressbar"
                      aria-label={`${quotaWindowLabel(window, index)} used`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={percent}
                    >
                      <span style={{ width: `${percent}%` }} />
                    </div>
                    <small>{quotaResetLabel(window.resetsAt)}</small>
                  </div>
                );
              })}
            </div>
            <p>
              Reported by {runtimeName}
              {subscription?.updatedAt
                ? ` · updated ${new Date(subscription.updatedAt).toLocaleString()}`
                : ""}
              . Task tokens are separate.
            </p>
          </>
        ) : (
          <div className="usage-plan-empty">
            <strong>Plan telemetry not exposed</strong>
            <span>{runtime ? PLAN_USAGE_GUIDANCE[runtime] : "No plan limit was reported."}</span>
            <small>AI Integrator never estimates plan usage.</small>
          </div>
        )}
      </section>
      {metrics.length ? (
        <div className="usage-metrics">
          {metrics.map((metric) => (
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
      ) : null}
    </div>
  );
}

export function RightRail(props: RightRailProps) {
  const [tab, setTab] = useState<RailTab>("git");
  const { onRequestProjectFiles } = props;
  // Browser snapshots and test fixtures from before the Git state migration
  // may not yet carry the discriminator or remote list.
  const normalizedGit: GitSnapshot = {
    ...props.git,
    kind: props.git.kind ?? (props.git.worktree ? "repository" : "notRepository"),
    remotes: props.git.remotes ?? [],
  };
  useEffect(() => {
    if (tab === "files") onRequestProjectFiles?.();
  }, [onRequestProjectFiles, tab]);
  const tabs: Array<{
    id: RailTab;
    label: string;
    icon: typeof GitBranch;
    count?: number;
  }> = [
    {
      id: "git",
      label: "Git",
      icon: GitBranch,
      count: normalizedGit.kind === "repository" ? normalizedGit.files.length : undefined,
    },
    {
      id: "agents",
      label: "Agents",
      icon: Users,
      count: props.delegations ? props.delegations.length : props.children.length,
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
            {tab === item.id ? <SlidingTabIndicator layoutId="task-tools-tab-indicator" /> : null}
            <item.icon />
            <span>{item.label}</span>
            {item.count !== undefined ? <small>{item.count}</small> : null}
          </button>
        ))}
      </div>
      <div id={`task-tools-panel-${tab}`} role="tabpanel" aria-labelledby={`task-tools-tab-${tab}`}>
        {tab === "git" ? <GitPanel {...props} git={normalizedGit} /> : null}
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
          // Keyed by project so filter and folder state reset naturally when
          // the selected project changes.
          <FilePanel
            key={props.projectId ?? "no-project"}
            projectFiles={props.projectFiles}
            projectFilesState={props.projectFilesState}
            onOpenFile={props.onOpenFile}
            activeFilePath={props.activeFilePath}
            openingFilePath={props.openingFilePath}
            onRenameProjectFile={props.onRenameProjectFile}
            onMentionProjectFile={props.onMentionProjectFile}
            onMentionProjectFolder={props.onMentionProjectFolder}
            fileOpeners={props.fileOpeners}
            onOpenProjectFileExternal={props.onOpenProjectFileExternal}
            onRevealProjectFile={props.onRevealProjectFile}
          />
        ) : null}
        {tab === "usage" ? (
          <UsagePanel
            usage={props.usage}
            runtime={props.runtime}
            subscription={props.subscription}
          />
        ) : null}
      </div>
    </aside>
  );
}
