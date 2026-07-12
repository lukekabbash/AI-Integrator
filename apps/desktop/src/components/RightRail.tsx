import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  FileCode2,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  Minus,
  PanelRightClose,
  Plus,
  Radio,
  SquareArrowOutUpRight,
  Users,
  X,
} from "lucide-react";
import type {
  ChildAgent,
  DelegationView,
  DiffFile,
  GitSnapshot,
  ProjectFileContent,
  ProjectFileEntry,
  UsageSnapshot,
} from "../bridge";
import { ResizeHandle } from "./ResizeHandle";

type RailTab = "git" | "agents" | "files" | "usage";

interface RightRailProps {
  git: GitSnapshot;
  children: ChildAgent[];
  /** Live delegated subagents from the native broker; overrides `children`. */
  delegations?: DelegationView[];
  onApproveDelegation?: (delegationId: string) => Promise<void>;
  onDenyDelegation?: (delegationId: string) => Promise<void>;
  onNudgeDelegation?: (delegationId: string, message: string) => Promise<void>;
  onStopDelegation?: (delegationId: string) => Promise<void>;
  /** Opens the child task's transcript in the main view. */
  onOpenDelegationTask?: (taskId: string) => void;
  usage: UsageSnapshot;
  activeFile?: DiffFile;
  /** Clears in-rail open file tabs when the selected project changes. */
  projectId?: string;
  projectFiles?: ProjectFileEntry[];
  projectFilesState?: "loading" | "ready" | "unavailable";
  onSelectFile: (file: DiffFile) => void;
  onOpenProjectFile?: (file: ProjectFileEntry) => Promise<ProjectFileContent>;
  onStageFile: (file: DiffFile, staged: boolean) => Promise<void>;
  onCommit: (message: string) => Promise<void>;
  onPush: () => Promise<void>;
  onClose: () => void;
  onResize?: (delta: number) => void;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The Git action could not be completed.";
}

function GitPanel({
  git,
  activeFile,
  onSelectFile,
  onStageFile,
  onCommit,
  onPush,
}: Pick<
  RightRailProps,
  "git" | "activeFile" | "onSelectFile" | "onStageFile" | "onCommit" | "onPush"
>) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"commit" | "push" | null>(null);
  const [stagingPath, setStagingPath] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const staged = git.files.filter((file) => file.staged);
  const unstaged = git.files.filter((file) => !file.staged);

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

  const runCommit = async () => {
    if (!message.trim() || staged.length === 0 || busy !== null) return;
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

  const runPush = async () => {
    if (busy !== null || git.ahead === 0) return;
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

  const fileRow = (file: DiffFile, isStaged: boolean) => (
    <div className="git-file-row" data-active={activeFile?.path === file.path} key={file.path}>
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
      <button
        className="git-file-name"
        type="button"
        onClick={() => onSelectFile(file)}
        title={file.path}
        aria-pressed={activeFile?.path === file.path}
      >
        <FileCode2 />
        <span>{file.path.split("/").at(-1)}</span>
        <small>{file.path.split("/").slice(0, -1).join("/")}</small>
      </button>
      <span className="file-change-count">
        <i>+{file.additions}</i>
        <b>−{file.deletions}</b>
      </span>
      <span className="file-state">{file.status.at(0)?.toUpperCase()}</span>
    </div>
  );

  return (
    <div className="rail-panel git-panel">
      <div className="branch-header">
        <div className="branch-button" aria-label={`Current branch ${git.branch}`}>
          <GitBranch />
          <span>{git.branch}</span>
        </div>
      </div>
      <div className="sync-status">
        <span>
          {git.ahead} ahead · {git.behind} behind
        </span>
        <small>{git.upstream}</small>
      </div>

      <label className="commit-composer">
        <span className="sr-only">Commit message</span>
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
              event.preventDefault();
              void runCommit();
            }
          }}
          rows={2}
          placeholder="Message (Ctrl/Cmd+Enter to commit)"
        />
      </label>
      <button
        className="primary-button commit-button"
        type="button"
        onClick={() => void runCommit()}
        disabled={!message.trim() || staged.length === 0 || busy !== null}
      >
        <GitCommitHorizontal />{" "}
        {busy === "commit" ? "Committing…" : `Commit ${staged.length || ""}`}
      </button>
      {actionError ? (
        <p className="empty-compact" role="alert">
          {actionError}
        </p>
      ) : null}

      <div className="git-section">
        <div className="git-section-title">
          <span>Staged changes</span>
          <small>{staged.length}</small>
        </div>
        {staged.length ? (
          staged.map((file) => fileRow(file, true))
        ) : (
          <p className="empty-compact">Stage a file to prepare the next commit.</p>
        )}
      </div>
      <div className="git-section">
        <div className="git-section-title">
          <span>Changes</span>
          <small>{unstaged.length}</small>
        </div>
        {unstaged.length ? (
          unstaged.map((file) => fileRow(file, false))
        ) : (
          <p className="empty-compact">No unstaged changes.</p>
        )}
      </div>

      <div className="git-history">
        <div className="git-section-title">
          <span>
            <Activity /> Graph
          </span>
          <small>{git.branch}</small>
        </div>
        {git.commits.length ? (
          git.commits.map((commit, index) => (
            <div className="commit-row" key={`${commit.id}-${index}`} data-current={commit.current}>
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

      <div className="rail-sticky-actions">
        <button
          className="primary-button"
          type="button"
          onClick={() => void runPush()}
          disabled={git.ahead === 0 || busy !== null}
        >
          <SquareArrowOutUpRight /> {busy === "push" ? "Pushing…" : `Push ${git.ahead || ""}`}
        </button>
      </div>
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

function AgentPanel({
  agents,
  delegations,
  onApprove,
  onDeny,
  onNudge,
  onStop,
  onOpenTask,
}: {
  agents: ChildAgent[];
  delegations?: DelegationView[];
  onApprove?: (delegationId: string) => Promise<void>;
  onDeny?: (delegationId: string) => Promise<void>;
  onNudge?: (delegationId: string, message: string) => Promise<void>;
  onStop?: (delegationId: string) => Promise<void>;
  onOpenTask?: (taskId: string) => void;
}) {
  if (delegations && delegations.length > 0) {
    return (
      <div className="rail-panel agent-panel">
        <header className="rail-panel-header">
          <span>
            <Users /> Subagents
          </span>
          <small>{delegations.length}</small>
        </header>
        <p className="rail-description">
          Subagents delegated by this task's orchestrator. Messages never interrupt a running
          turn — nudges are delivered when a subagent is idle.
        </p>
        {delegations.map((delegation) => (
          <DelegationRow
            key={delegation.id}
            delegation={delegation}
            onApprove={onApprove}
            onDeny={onDeny}
            onNudge={onNudge}
            onStop={onStop}
            onOpenTask={onOpenTask}
          />
        ))}
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
  onApprove,
  onDeny,
  onNudge,
  onStop,
  onOpenTask,
}: {
  delegation: DelegationView;
  onApprove?: (delegationId: string) => Promise<void>;
  onDeny?: (delegationId: string) => Promise<void>;
  onNudge?: (delegationId: string, message: string) => Promise<void>;
  onStop?: (delegationId: string) => Promise<void>;
  onOpenTask?: (taskId: string) => void;
}) {
  const [nudge, setNudge] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const active = ["starting", "running", "waiting"].includes(delegation.status);
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
    <div className="agent-row delegation-row" data-status={delegation.status}>
      <span className={`agent-avatar agent-avatar--${delegation.runtime}`}>
        {delegation.profileLabel.slice(0, 1)}
      </span>
      <span className="agent-copy">
        <strong>
          {delegation.title}
          <i>{delegation.profileLabel}</i>
        </strong>
        <span>
          {delegation.status}
          {delegation.unreadFromChild > 0 ? ` · ${delegation.unreadFromChild} new message(s)` : ""}
        </span>
        <small>{[delegation.model, delegation.runtime].filter(Boolean).join(" · ")}</small>
        {delegation.pendingQuestions.map((question, index) => (
          <small className="delegation-question" key={index}>
            ❓ {question}
          </small>
        ))}
        {delegation.result ? <small className="delegation-result">{delegation.result}</small> : null}
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
          {active && onStop ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => onStop(delegation.id))}
            >
              Stop
            </button>
          ) : null}
          {delegation.childTaskId && onOpenTask ? (
            <button type="button" onClick={() => onOpenTask(delegation.childTaskId ?? "")}>
              Open transcript
            </button>
          ) : null}
        </span>
        {active && onNudge ? (
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

function FilePanel({
  projectFiles = [],
  projectFilesState = "unavailable",
  onOpenProjectFile,
}: Pick<RightRailProps, "projectFiles" | "projectFilesState" | "onOpenProjectFile">) {
  const [filter, setFilter] = useState("");
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const [openTabs, setOpenTabs] = useState<ProjectFileContent[]>([]);
  const [activePath, setActivePath] = useState<string>("");
  const [openingPath, setOpeningPath] = useState<string>("");
  const [readError, setReadError] = useState("");
  const [readerRatio, setReaderRatio] = useState(0.5);
  const splitRef = useRef<HTMLDivElement>(null);
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const visibleProjectFiles = normalizedFilter
    ? projectFiles.filter((file) => file.path.toLocaleLowerCase().includes(normalizedFilter))
    : projectFiles;
  const projectTree = useMemo(() => buildProjectTree(visibleProjectFiles), [visibleProjectFiles]);
  const activeFile = openTabs.find((file) => file.path === activePath) ?? openTabs[0];
  const readerOpen = Boolean(activeFile || openingPath || readError);

  const toggleFolder = (path: string) => {
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const openProjectFile = async (file: ProjectFileEntry) => {
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
  };

  const closeTab = (path: string) => {
    setOpenTabs((current) => {
      const next = current.filter((tab) => tab.path !== path);
      if (activePath === path) setActivePath(next[0]?.path ?? "");
      return next;
    });
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
        <div className="file-reader-pane" aria-label="Open project files">
          {openTabs.length ? (
            <div className="file-reader-tabs" role="tablist" aria-label="Open files">
              {openTabs.map((tab) => (
                <div
                  className="file-reader-tab"
                  data-active={tab.path === (activeFile?.path ?? "")}
                  key={tab.path}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab.path === (activeFile?.path ?? "")}
                    title={tab.path}
                    onClick={() => setActivePath(tab.path)}
                  >
                    <FileCode2 />
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
                </div>
              ))}
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
              activeFile.isBinary ? (
                <p className="empty-compact">
                  This binary file cannot be safely previewed as text.
                </p>
              ) : (
                <ol className="file-reader-lines" aria-label={`Contents of ${activeFile.path}`}>
                  {activeFile.content.split("\n").map((line, index) => (
                    <li key={`${activeFile.path}-${index}`}>
                      <code>
                        {highlightFileLine(line).map((token, tokenIndex) => (
                          <span
                            className={`syntax-${token.kind}`}
                            key={`${activeFile.path}-${index}-${tokenIndex}`}
                          >
                            {token.text}
                          </span>
                        ))}
                      </code>
                    </li>
                  ))}
                </ol>
              )
            ) : !openingPath && !readError ? (
              <p className="empty-compact">Select a file from the project tree to preview it.</p>
            ) : null}
          </div>
        </div>
      </div>
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
      const next = current.folders.get(segment) ?? { folders: new Map(), files: [] };
      current.folders.set(segment, next);
      current = next;
    }
    current.files.push(file);
  }
  return root;
}

function ProjectTree({
  node,
  collapsedFolders,
  forceExpanded,
  onToggleFolder,
  onOpenFile,
  activePath,
  openingPath,
  path = "",
  depth = 0,
}: {
  node: ProjectTreeNode;
  collapsedFolders: Set<string>;
  forceExpanded: boolean;
  onToggleFolder: (path: string) => void;
  onOpenFile: (file: ProjectFileEntry) => void;
  activePath?: string;
  openingPath?: string;
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
            >
              {expanded ? <ChevronDown /> : <ChevronRight />}
              <span>{name}</span>
            </button>
            {expanded ? (
              <ProjectTree
                node={child}
                collapsedFolders={collapsedFolders}
                forceExpanded={forceExpanded}
                onToggleFolder={onToggleFolder}
                onOpenFile={onOpenFile}
                activePath={activePath}
                openingPath={openingPath}
                path={folderPath}
                depth={depth + 1}
              />
            ) : null}
          </div>
        );
      })}
      {node.files.map((file) => (
        <button
          type="button"
          key={`project-${file.path}`}
          data-tree-depth={depth}
          style={{ "--tree-depth": depth } as CSSProperties}
          onClick={() => onOpenFile(file)}
          title={`Open ${file.path}`}
          aria-current={activePath === file.path ? "page" : undefined}
          aria-busy={openingPath === file.path}
          data-active={activePath === file.path}
        >
          <FileCode2 />
          <span>{file.path.split("/").at(-1)}</span>
          <small>{formatFileSize(file.size)}</small>
        </button>
      ))}
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
          style={{ "--usage": `${usage.subscriptionPercent ?? 0}%` } as React.CSSProperties}
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
  const tabs: Array<{ id: RailTab; label: string; icon: typeof GitBranch; count?: number }> = [
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
    <aside className="right-rail" aria-label="Task tools">
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
        <button
          className="rail-close-button"
          type="button"
          aria-label="Close task tools"
          onClick={props.onClose}
        >
          <PanelRightClose />
        </button>
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
            onOpenTask={props.onOpenDelegationTask}
          />
        ) : null}
        {tab === "files" ? (
          // Keyed by project so open tabs, filter, and folder state reset
          // naturally when the selected project changes.
          <FilePanel
            key={props.projectId ?? "no-project"}
            projectFiles={props.projectFiles}
            projectFilesState={props.projectFilesState}
            onOpenProjectFile={props.onOpenProjectFile}
          />
        ) : null}
        {tab === "usage" ? <UsagePanel usage={props.usage} /> : null}
      </div>
    </aside>
  );
}
