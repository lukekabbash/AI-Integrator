import { useState } from "react";
import {
  Activity,
  Bot,
  ChevronDown,
  CircleDollarSign,
  FileCode2,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequestArrow,
  MessageSquare,
  Minus,
  MoreHorizontal,
  Plus,
  Radio,
  RefreshCw,
  Send,
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
  const staged = git.files.filter((file) => file.staged);
  const unstaged = git.files.filter((file) => !file.staged);

  const runCommit = async () => {
    if (!message.trim() || staged.length === 0) return;
    setBusy("commit");
    try {
      await onCommit(message.trim());
      setMessage("");
    } finally {
      setBusy(null);
    }
  };

  const runPush = async () => {
    setBusy("push");
    try {
      await onPush();
    } finally {
      setBusy(null);
    }
  };

  const fileRow = (file: DiffFile, isStaged: boolean) => (
    <div className="git-file-row" data-active={activeFile?.path === file.path} key={file.path}>
      <button
        className="git-stage-button"
        type="button"
        onClick={() => void onStageFile(file, !isStaged)}
        aria-label={`${isStaged ? "Unstage" : "Stage"} ${file.path}`}
      >
        {isStaged ? <Minus /> : <Plus />}
      </button>
      <button
        className="git-file-name"
        type="button"
        onClick={() => onSelectFile(file)}
        title={file.path}
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
        <button type="button" className="branch-button">
          <GitBranch />
          <span>{git.branch}</span>
          <ChevronDown />
        </button>
        <button className="icon-button subtle" type="button" aria-label="Fetch">
          <RefreshCw />
        </button>
        <button className="icon-button subtle" type="button" aria-label="More Git actions">
          <MoreHorizontal />
        </button>
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
          rows={2}
          placeholder="Message (Ctrl Enter to commit)"
        />
        <button className="sparkle-button" type="button" aria-label="Generate commit message">
          <Bot />
        </button>
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
        {unstaged.map((file) => fileRow(file, false))}
      </div>

      <div className="git-history">
        <div className="git-section-title">
          <span>
            <Activity /> Graph
          </span>
          <button type="button">All branches</button>
        </div>
        {git.commits.map((commit, index) => (
          <div className="commit-row" key={`${commit.id}-${index}`} data-current={commit.current}>
            <span className="commit-node" />
            <span>
              <strong>{commit.subject}</strong>
              <small>
                {commit.id} · {commit.relativeTime}
              </small>
            </span>
          </div>
        ))}
      </div>

      <div className="rail-sticky-actions">
        <button className="secondary-button" type="button">
          <GitPullRequestArrow /> Open PR
        </button>
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
        <button type="button" className="secondary-button small">
          <Plus /> Delegate
        </button>
      </header>
      <p className="rail-description">
        Children receive bounded assignments and report evidence through the local broker.
      </p>
      {roots.map((root) => (
        <div className="agent-tree" key={root.id}>
          <AgentRow agent={root} root />
          <div className="agent-children">
            {(childMap.get(root.id) ?? []).map((agent) => (
              <AgentRow agent={agent} key={agent.id} />
            ))}
          </div>
        </div>
      ))}
      <div className="broker-message-box">
        <MessageSquare />
        <span>
          <strong>Broker mailbox</strong>
          <small>3 delivered · all transcripts scoped</small>
        </span>
        <button type="button">
          <Send />
          <span className="sr-only">Message agent</span>
        </button>
      </div>
    </div>
  );
}

function AgentRow({ agent, root = false }: { agent: ChildAgent; root?: boolean }) {
  return (
    <button className="agent-row" type="button" data-root={root}>
      <span className={`agent-avatar agent-avatar--${agent.runtime}`}>
        {agent.name.slice(0, 1)}
      </span>
      <span className="agent-copy">
        <strong>
          {agent.name}
          <i>{agent.role}</i>
        </strong>
        <span>{agent.activity}</span>
        <small>
          {agent.model} · {agent.elapsed} · {agent.worktree}
        </small>
      </span>
      <span className={`status-dot status-dot--${agent.status}`}>
        <span className="sr-only">{agent.status}</span>
      </span>
    </button>
  );
}

function FilePanel({ git, onSelectFile }: Pick<RightRailProps, "git" | "onSelectFile">) {
  return (
    <div className="rail-panel file-panel">
      <header className="rail-panel-header">
        <span>
          <FileText /> Files
        </span>
        <button className="icon-button subtle" type="button">
          <Plus />
          <span className="sr-only">New file</span>
        </button>
      </header>
      <label className="rail-filter">
        <span className="sr-only">Filter files</span>
        <input placeholder="Filter by name" />
      </label>
      <div className="file-tree">
        <div className="tree-folder">
          <ChevronDown />
          <span>src</span>
        </div>
        {git.files.map((file) => (
          <button type="button" key={file.path} onClick={() => onSelectFile(file)}>
            <FileCode2 />
            <span>{file.path.replace("src/", "")}</span>
            <small>{file.status.at(0)?.toUpperCase()}</small>
          </button>
        ))}
        <div className="tree-folder">
          <ChevronDown />
          <span>docs</span>
        </div>
        <button type="button">
          <FileText />
          <span>v1-scope.md</span>
        </button>
        <button type="button">
          <FileText />
          <span>repo-coordination-protocol.md</span>
        </button>
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
          <strong>{usage.subscriptionPercent ?? "—"}%</strong>
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
  return (
    <aside className="right-rail" aria-label="Task tools">
      <div className="rail-tabs" role="tablist" aria-label="Task tools">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            data-active={tab === item.id}
            onClick={() => setTab(item.id)}
          >
            <item.icon />
            <span>{item.label}</span>
            {item.count ? <small>{item.count}</small> : null}
          </button>
        ))}
      </div>
      {tab === "git" ? <GitPanel {...props} /> : null}
      {tab === "agents" ? <AgentPanel agents={props.children} /> : null}
      {tab === "files" ? <FilePanel git={props.git} onSelectFile={props.onSelectFile} /> : null}
      {tab === "usage" ? <UsagePanel usage={props.usage} /> : null}
    </aside>
  );
}
