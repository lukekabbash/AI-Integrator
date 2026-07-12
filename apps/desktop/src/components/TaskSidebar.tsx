import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
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
import { ResizeHandle } from "./ResizeHandle";

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
  onNewTaskInProject?: (projectId: string) => void;
  onOpenProject: () => void;
  onUpdateTask: (
    taskId: string,
    patch: { title?: string; pinned?: boolean; archived?: boolean },
  ) => void;
  onOpenSettings: () => void;
  onResize?: (delta: number) => void;
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

const ACTIVE_STATUSES = new Set<TaskSummary["status"]>([
  "starting",
  "running",
  "waiting",
  "failed",
]);

function sortTasks(tasks: TaskSummary[]): TaskSummary[] {
  return [...tasks].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

function modKeyLabel(): string {
  return isApplePlatform() ? "⌘" : "Ctrl";
}

function formatRelativeUpdated(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 45_000) return "Just now";
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function chatMeta(
  task: TaskSummary,
  options?: { showProject?: boolean; projectName?: string },
): string {
  const prefix = options?.showProject ? `${options.projectName ?? "Project"} · ` : "";
  if (ACTIVE_STATUSES.has(task.status)) return `${prefix}${statusLabel[task.status]}`;
  const relative = formatRelativeUpdated(task.updatedAt);
  return relative ? `${prefix}${relative}` : `${prefix}${statusLabel[task.status]}`;
}

const expandTransition = {
  duration: 0.22,
  ease: [0.2, 0.8, 0.2, 1] as const,
};

const menuTransition = {
  duration: 0.16,
  ease: [0.2, 0, 0, 1] as const,
};

const activeSpring = {
  type: "spring" as const,
  stiffness: 460,
  damping: 38,
  mass: 0.7,
};

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
  onNewTaskInProject,
  onOpenProject,
  onUpdateTask,
  onOpenSettings,
  onResize,
}: TaskSidebarProps) {
  const reduceMotion = useReducedMotion();
  const [query, setQuery] = useState("");
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>(() =>
    activeProjectId ? { [activeProjectId]: true } : {},
  );
  const [openMenuId, setOpenMenuId] = useState("");
  const [renamingId, setRenamingId] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const chatListRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const mod = modKeyLabel();

  // Adjust-during-render (not an effect): the active project's group opens
  // the moment it changes, without an extra committed render in between.
  const [lastActiveProjectId, setLastActiveProjectId] = useState(activeProjectId);
  if (activeProjectId !== lastActiveProjectId) {
    setLastActiveProjectId(activeProjectId);
    if (activeProjectId && !expandedProjects[activeProjectId]) {
      setExpandedProjects({ ...expandedProjects, [activeProjectId]: true });
    }
  }

  useEffect(() => {
    if (!openMenuId) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpenMenuId("");
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenuId("");
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenuId]);

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

  const tasksByProject = useMemo(() => {
    const map = new Map<string, TaskSummary[]>();
    for (const project of projects) map.set(project.id, []);
    for (const task of tasks) {
      const list = map.get(task.projectId);
      if (list) list.push(task);
      else map.set(task.projectId, [task]);
    }
    for (const [id, list] of map) map.set(id, sortTasks(list));
    return map;
  }, [projects, tasks]);

  const archivedCount = useMemo(() => tasks.filter((task) => task.archived).length, [tasks]);

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

  const chatsForProject = (projectId: string): TaskSummary[] => {
    const all = tasksByProject.get(projectId) ?? [];
    if (showArchived) return all.filter((task) => task.archived);
    const pinned = all.filter((task) => task.pinned && !task.archived);
    const recent = all.filter((task) => !task.pinned && !task.archived);
    return [...pinned, ...recent];
  };

  const renderChat = (task: TaskSummary, options?: { showProject?: boolean; nested?: boolean }) => {
    const project = projects.find((candidate) => candidate.id === task.projectId);
    const busy = taskActionBusyId === task.id;
    const active = task.id === activeTaskId;
    if (renamingId === task.id) {
      return (
        <form
          className={`chat-rename-row${options?.nested ? " chat-rename-row--nested" : ""}`}
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
      <div
        className={`chat-row-shell${options?.nested ? " chat-row-shell--nested" : ""}${options?.showProject ? " chat-row-shell--search" : ""}`}
        data-active={active}
        data-menu-open={openMenuId === task.id}
        key={task.id}
      >
        {active ? (
          <motion.span
            className="chat-row-active"
            layoutId={reduceMotion ? undefined : "sidebar-active-chat"}
            transition={reduceMotion ? { duration: 0 } : activeSpring}
            aria-hidden="true"
          />
        ) : null}
        <button
          className="chat-row"
          data-chat-select
          type="button"
          onClick={() => onSelectTask(task.id)}
          aria-current={active ? "page" : undefined}
          title={chatMeta(task, {
            showProject: options?.showProject,
            projectName: project?.name,
          })}
          data-status={task.status}
        >
          <span
            className={`status-dot status-dot--${task.status}`}
            role="img"
            aria-label={`Status: ${task.status}`}
          />
          <span className="chat-row-copy">
            <span>{task.title}</span>
            <small>
              {chatMeta(task, {
                showProject: options?.showProject,
                projectName: project?.name,
              })}
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
              ref={menuRef}
              initial={reduceMotion ? false : { opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: -3, scale: 0.98 }}
              transition={menuTransition}
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
        {onResize ? (
          <ResizeHandle axis="horizontal" label="Resize chat sidebar" onResize={onResize} />
        ) : null}
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

      <motion.button
        className="new-task-button"
        type="button"
        onClick={onNewTask}
        whileTap={reduceMotion ? undefined : { scale: 0.985 }}
        transition={{ duration: 0.12 }}
      >
        <Plus aria-hidden="true" />
        <span>New chat</span>
        <kbd>{mod} N</kbd>
      </motion.button>

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
        <kbd>{mod} K</kbd>
      </label>

      <div
        className="sidebar-scroll"
        ref={chatListRef}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            focusRelativeChat(event.key === "ArrowDown" ? 1 : -1);
          }
        }}
      >
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

        <LayoutGroup id="sidebar-chats">
          {normalizedQuery ? (
            <section className="chat-section" aria-label="Search results">
              <div className="rail-section-heading rail-section-heading--later">
                <span>Search results</span>
                <small>{searchResults.length}</small>
              </div>
              {searchResults.length ? (
                searchResults.map((task) => renderChat(task, { showProject: true }))
              ) : (
                <div className="sidebar-chat-empty" role="status">
                  <History />
                  <strong>No matching chats</strong>
                  <span>Try a project name or a shorter phrase.</span>
                </div>
              )}
            </section>
          ) : (
            <div className="project-tree" aria-label="Projects">
              {projects.map((project) => {
                const expanded = expandedProjects[project.id] ?? false;
                const projectChats = chatsForProject(project.id);
                const visibleCount = showArchived
                  ? projectChats.length
                  : (tasksByProject.get(project.id) ?? []).filter((task) => !task.archived).length;
                return (
                  <div
                    className="project-group"
                    data-active={project.id === activeProjectId}
                    key={project.id}
                  >
                    <div className="project-group-header">
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
                        <small>{visibleCount}</small>
                      </button>
                      {onNewTaskInProject ? (
                        <button
                          className="project-new-chat"
                          type="button"
                          aria-label={`New chat in ${project.name}`}
                          title={`New chat in ${project.name}`}
                          onClick={() => onNewTaskInProject(project.id)}
                        >
                          <Plus aria-hidden="true" />
                        </button>
                      ) : null}
                    </div>
                    <AnimatePresence initial={false}>
                      {expanded ? (
                        <motion.div
                          className="project-chat-list"
                          data-menu-open={openMenuId ? "true" : "false"}
                          initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={reduceMotion ? undefined : { height: 0, opacity: 0 }}
                          transition={expandTransition}
                        >
                          {projectChats.length ? (
                            projectChats.map((task) => renderChat(task, { nested: true }))
                          ) : (
                            <p className="project-chat-empty" role="status">
                              {showArchived ? "No archived chats" : "No chats yet"}
                            </p>
                          )}
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
          )}
        </LayoutGroup>

        <button
          className="utility-row archived-toggle"
          data-active={showArchived}
          type="button"
          onClick={() => setShowArchived((value) => !value)}
        >
          <Archive />
          <span>{showArchived ? "Back to chats" : "Archived"}</span>
          {archivedCount ? <small>{archivedCount}</small> : null}
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
      {onResize ? (
        <ResizeHandle axis="horizontal" label="Resize chat sidebar" onResize={onResize} />
      ) : null}
    </aside>
  );
}
