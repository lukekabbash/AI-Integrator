import { useState, type KeyboardEvent } from "react";
import {
  Activity,
  ChevronDown,
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
} from "lucide-react";
import type { ChildAgent, DiffFile, GitSnapshot, UsageSnapshot } from "../bridge";

type RailTab = "git" | "agents" | "files" | "usage";

interface RightRailProps {
  git: GitSnapshot;
  children: ChildAgent[];
  usage: UsageSnapshot;
  activeFile?: DiffFile;
  onSelectFile: (file: DiffFile) => void;
  onStageFile: (file: DiffFile, staged: boolean) => Promise<void>;
  onCommit: (message: string) => Promise<void>;
  onPush: () => Promise<void>;
  onClose: () => void;
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
  const [message, setMessage] = useState("Build polished native v1 workspace");
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
          <span>
            <ChevronDown /> Staged changes
          </span>
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
          <span>
            <ChevronDown /> Changes
          </span>
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

function AgentPanel({ agents }: { agents: ChildAgent[] }) {
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
          <Users /> Agent lineage
        </span>
        <small>Read-only</small>
      </header>
      <p className="rail-description">
        Agents reported by the active task appear here. Delegation controls are not connected yet.
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
        <p className="empty-compact">No child agents have been reported for this task.</p>
      )}
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

function FilePanel({ git, onSelectFile }: Pick<RightRailProps, "git" | "onSelectFile">) {
  const [filter, setFilter] = useState("");
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const files = normalizedFilter
    ? git.files.filter((file) => file.path.toLocaleLowerCase().includes(normalizedFilter))
    : git.files;

  return (
    <div className="rail-panel file-panel">
      <header className="rail-panel-header">
        <span>
          <FileText /> Files
        </span>
        <small>{files.length}</small>
      </header>
      <label className="rail-filter">
        <span className="sr-only">Filter files</span>
        <input
          placeholder="Filter by name"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </label>
      <div className="file-tree">
        {files.map((file) => (
          <button
            type="button"
            key={file.path}
            onClick={() => onSelectFile(file)}
            title={file.path}
          >
            <FileCode2 />
            <span>{file.path}</span>
            <small>{file.status.at(0)?.toUpperCase()}</small>
          </button>
        ))}
        {files.length === 0 ? (
          <p className="empty-compact">
            {git.files.length === 0 ? "No changed files." : "No changed files match this filter."}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function UsagePanel({ usage }: { usage: UsageSnapshot }) {
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
          <strong>Resets {usage.resetAt ?? "when reported"}</strong>
          <span>Subscription and API usage stay separate.</span>
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
      count: props.children.filter((agent) => agent.status === "running").length,
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
        {tab === "agents" ? <AgentPanel agents={props.children} /> : null}
        {tab === "files" ? <FilePanel git={props.git} onSelectFile={props.onSelectFile} /> : null}
        {tab === "usage" ? <UsagePanel usage={props.usage} /> : null}
      </div>
    </aside>
  );
}
