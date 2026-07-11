import { useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  Folder,
  History,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import type { ProjectSummary, TaskSummary } from "../bridge";
import { BrandMark } from "./BrandMark";

interface TaskSidebarProps {
  projects: ProjectSummary[];
  tasks: TaskSummary[];
  activeProjectId: string;
  activeTaskId: string;
  collapsed: boolean;
  openingProject: boolean;
  metadataActionsEnabled: boolean;
  taskActionBusyId: string;
  onToggleCollapsed: () => void;
  onSelectProject: (projectId: string) => void;
  onSelectTask: (taskId: string) => void;
  onNewTask: () => void;
  onOpenProject: () => void;
  onUpdateTask: (
    taskId: string,
    patch: { title?: string; pinned?: boolean; archived?: boolean },
  ) => void;
  onOpenSettings: () => void;
}

const statusLabel: Record<TaskSummary["status"], string> = {
  draft: "Draft",
  starting: "Starting",
  running: "Running",
  waiting: "Waiting for input",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};

function sortTasks(tasks: TaskSummary[]): TaskSummary[] {
  return [...tasks].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function TaskSidebar({
  projects,
  tasks,
  activeProjectId,
  activeTaskId,
  collapsed,
  openingProject,
  metadataActionsEnabled,
  taskActionBusyId,
  onToggleCollapsed,
  onSelectProject,
  onSelectTask,
  onNewTask,
  onOpenProject,
  onUpdateTask,
  onOpenSettings,
}: TaskSidebarProps) {
  const [query, setQuery] = useState("");
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [openMenuId, setOpenMenuId] = useState("");
  const [renamingId, setRenamingId] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const chatListRef = useRef<HTMLDivElement>(null);

  const activeProject = projects.find((project) => project.id === activeProjectId);
  const normalizedQuery = query.trim().toLowerCase();
  const searchResults = useMemo(
    () =>
      normalizedQuery
        ? sortTasks(
            tasks.filter((task) => {
              const project = projects.find((candidate) => candidate.id === task.projectId);
              return `${task.title} ${project?.name ?? ""}`.toLowerCase().includes(normalizedQuery);
            }),
          )
        : [],
    [normalizedQuery, projects, tasks],
  );
  const projectTasks = useMemo(
    () => sortTasks(tasks.filter((task) => task.projectId === activeProjectId)),
    [activeProjectId, tasks],
  );
  const pinnedTasks = projectTasks.filter((task) => task.pinned && !task.archived);
  const recentTasks = projectTasks.filter((task) => !task.pinned && !task.archived);
  const archivedTasks = projectTasks.filter((task) => task.archived);
  const displayedSections = normalizedQuery
    ? [{ label: "Search results", tasks: searchResults }]
    : showArchived
      ? [{ label: "Archived", tasks: archivedTasks }]
      : [
          { label: "Pinned", tasks: pinnedTasks },
          { label: "Recent chats", tasks: recentTasks },
        ];

  const focusRelativeChat = (direction: 1 | -1) => {
    const buttons = Array.from(
      chatListRef.current?.querySelectorAll<HTMLButtonElement>("[data-chat-select]") ?? [],
    );
    if (buttons.length === 0) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[
      (current < 0
        ? direction > 0
          ? 0
          : buttons.length - 1
        : current + direction + buttons.length) % buttons.length
    ]?.focus();
  };

  const beginRename = (task: TaskSummary) => {
    setOpenMenuId("");
    setRenamingId(task.id);
    setRenameValue(task.title);
  };

  const submitRename = (taskId: string) => {
    const title = renameValue.trim();
    if (title) onUpdateTask(taskId, { title });
    setRenamingId("");
  };

  const renderChat = (task: TaskSummary) => {
    const project = projects.find((candidate) => candidate.id === task.projectId);
    const busy = taskActionBusyId === task.id;
    if (renamingId === task.id) {
      return (
        <form
          className="chat-rename-row"
          key={task.id}
          onSubmit={(event) => {
            event.preventDefault();
            submitRename(task.id);
          }}
        >
          <input
            autoFocus
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            aria-label="Chat name"
            onKeyDown={(event) => {
              if (event.key === "Escape") setRenamingId("");
            }}
          />
          <button type="submit">Save</button>
        </form>
      );
    }
    return (
      <div className="chat-row-shell" data-active={task.id === activeTaskId} key={task.id}>
        <button
          className="chat-row"
          data-chat-select
          type="button"
          onClick={() => onSelectTask(task.id)}
          aria-current={task.id === activeTaskId ? "page" : undefined}
        >
          <span className={`status-dot status-dot--${task.status}`} aria-hidden="true" />
          <span className="chat-row-copy">
            <span>{task.title}</span>
            <small>
              {normalizedQuery ? `${project?.name ?? "Project"} · ` : ""}
              {statusLabel[task.status]}
            </small>
          </span>
          {task.pinned ? <Pin className="chat-pin" aria-label="Pinned" /> : null}
          {task.unread ? <span className="unread-dot" aria-label="Unread" /> : null}
        </button>
        <button
          className="chat-more-button"
          type="button"
          aria-label="More chat actions"
          title={`More actions for ${task.title}`}
          aria-expanded={openMenuId === task.id}
          onClick={() => setOpenMenuId((current) => (current === task.id ? "" : task.id))}
          disabled={busy}
        >
          <MoreHorizontal />
        </button>
        <AnimatePresence>
          {openMenuId === task.id ? (
            <motion.div
              className="chat-action-menu"
              role="menu"
              initial={{ opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -3, scale: 0.98 }}
              transition={{ duration: 0.12 }}
            >
              <button
                role="menuitem"
                type="button"
                onClick={() => beginRename(task)}
                disabled={!metadataActionsEnabled}
                title={metadataActionsEnabled ? undefined : "Native persistence is being added"}
              >
                <Pencil /> Rename
              </button>
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  onUpdateTask(task.id, { pinned: !task.pinned });
                  setOpenMenuId("");
                }}
                disabled={!metadataActionsEnabled}
              >
                {task.pinned ? <PinOff /> : <Pin />} {task.pinned ? "Unpin" : "Pin"}
              </button>
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  onUpdateTask(task.id, { archived: !task.archived });
                  setOpenMenuId("");
                }}
                disabled={!metadataActionsEnabled}
              >
                {task.archived ? <ArchiveRestore /> : <Archive />}
                {task.archived ? "Restore" : "Archive"}
              </button>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    );
  };

  if (collapsed) {
    return (
      <aside className="task-sidebar task-sidebar--collapsed" aria-label="Chat navigation">
        <div className="rail-icon-stack">
          <BrandMark compact />
          <button className="icon-button" type="button" onClick={onNewTask} aria-label="New chat">
            <Plus />
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={onToggleCollapsed}
            aria-label="Expand chat navigation"
          >
            <PanelLeftOpen />
          </button>
        </div>
        <button
          className="icon-button rail-settings"
          type="button"
          onClick={onOpenSettings}
          aria-label="Open Settings"
        >
          <Settings />
        </button>
      </aside>
    );
  }

  return (
    <aside className="task-sidebar" aria-label="Chat navigation">
      <div className="sidebar-brand-row">
        <BrandMark />
        <button
          className="icon-button subtle"
          type="button"
          onClick={onToggleCollapsed}
          aria-label="Collapse chat navigation"
        >
          <PanelLeftClose />
        </button>
      </div>

      <button className="new-task-button" type="button" onClick={onNewTask}>
        <Plus aria-hidden="true" />
        <span>New chat</span>
        <kbd>Ctrl N</kbd>
      </button>

      <label className="sidebar-search">
        <Search aria-hidden="true" />
        <span className="sr-only">Search chats</span>
        <input
          aria-label="Search chats"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              focusRelativeChat(1);
            } else if (event.key === "Escape") {
              setQuery("");
              event.currentTarget.blur();
            }
          }}
          placeholder="Search chats"
        />
        <kbd>⌘ K</kbd>
      </label>

      <div className="sidebar-scroll">
        <div className="rail-section-heading">
          <span>Projects</span>
          <button
            type="button"
            className="icon-button tiny"
            aria-label={openingProject ? "Opening project" : "Open another project"}
            onClick={onOpenProject}
            disabled={openingProject}
            aria-busy={openingProject}
          >
            <Plus />
          </button>
        </div>
        <div className="project-switcher" aria-label="Projects">
          {projects.map((project) => {
            const expanded = expandedProjects[project.id] ?? false;
            const count = tasks.filter(
              (task) => task.projectId === project.id && !task.archived,
            ).length;
            return (
              <div
                className="project-switch-row"
                data-active={project.id === activeProjectId}
                key={project.id}
              >
                <button
                  className="project-disclosure"
                  type="button"
                  aria-label={`${expanded ? "Collapse" : "Expand"} ${project.name}`}
                  aria-expanded={expanded}
                  onClick={() =>
                    setExpandedProjects((current) => ({
                      ...current,
                      [project.id]: !expanded,
                    }))
                  }
                >
                  <ChevronDown
                    className={expanded ? "disclosure disclosure--open" : "disclosure"}
                  />
                </button>
                <button
                  className="project-select-button"
                  type="button"
                  onClick={() => onSelectProject(project.id)}
                  aria-label={`Open project ${project.name}`}
                  aria-current={project.id === activeProjectId ? "true" : undefined}
                >
                  <Folder />
                  <span>{project.name}</span>
                  <small>{count}</small>
                </button>
                <AnimatePresence initial={false}>
                  {expanded ? (
                    <motion.div
                      className="project-switch-detail"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.14 }}
                    >
                      <span>{project.branch || "Local repository"}</span>
                      <button type="button" onClick={() => onSelectProject(project.id)}>
                        Open chats
                      </button>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>
            );
          })}
          {projects.length === 0 ? (
            <button className="sidebar-empty-project" type="button" onClick={onOpenProject}>
              <Folder />
              <span>
                <strong>Open your first project</strong>
                <small>Choose a local Git repository</small>
              </span>
            </button>
          ) : null}
        </div>

        <div
          className="chat-list"
          ref={chatListRef}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              focusRelativeChat(event.key === "ArrowDown" ? 1 : -1);
            }
          }}
        >
          {displayedSections.map((section) =>
            section.tasks.length > 0 ? (
              <section className="chat-section" key={section.label}>
                <div className="rail-section-heading rail-section-heading--later">
                  <span>{section.label}</span>
                  <small>{section.tasks.length}</small>
                </div>
                {section.tasks.map(renderChat)}
              </section>
            ) : null,
          )}
          {displayedSections.every((section) => section.tasks.length === 0) ? (
            <div className="sidebar-chat-empty" role="status">
              <History />
              <strong>
                {normalizedQuery
                  ? "No matching chats"
                  : showArchived
                    ? "No archived chats"
                    : "No chats yet"}
              </strong>
              <span>
                {normalizedQuery
                  ? "Try a project name or a shorter phrase."
                  : showArchived
                    ? "Archived chats will appear here."
                    : `Start a chat in ${activeProject?.name ?? "this project"}.`}
              </span>
            </div>
          ) : null}
        </div>

        <button
          className="utility-row archived-toggle"
          data-active={showArchived}
          type="button"
          onClick={() => setShowArchived((value) => !value)}
        >
          <Archive />
          <span>{showArchived ? "Back to chats" : "Archived"}</span>
          {archivedTasks.length ? <small>{archivedTasks.length}</small> : null}
        </button>
      </div>

      <button
        className="sidebar-settings-row"
        type="button"
        onClick={onOpenSettings}
        aria-label="Open Settings"
      >
        <Settings />
        <span>
          <strong>Settings</strong>
          <small>Appearance, agents, Git</small>
        </span>
      </button>
    </aside>
  );
}
