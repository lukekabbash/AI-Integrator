import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, LayoutGroup, m as motion, useReducedMotion } from "motion/react";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronUp,
  Folder,
  History,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  X,
} from "lucide-react";
import type { ProjectSummary, TaskMessageSearchHit, TaskSummary } from "../bridge";
import { AnimatedFolderIcon } from "./AnimatedFolderIcon";
import { BrandMark } from "./BrandMark";
import { ResizeHandle } from "./ResizeHandle";
import { Tooltip } from "./Tooltip";
import { TravelingSelection } from "./TravelingSelection";

interface TaskSidebarProps {
  projects: ProjectSummary[];
  tasks: TaskSummary[];
  activeProjectId: string;
  activeTaskId: string;
  openingProject: boolean;
  metadataActionsEnabled: boolean;
  taskActionBusyId: string;
  onSearchMessages?: (query: string) => Promise<TaskMessageSearchHit[]>;
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

type ChatDotKind = "streaming" | "attention" | "unread" | "unread-failed";

/** Chats only earn a dot when something is happening: streaming output,
 * waiting on the user, or holding an unread reply. Idle rows stay quiet. */
function chatDotKind(task: TaskSummary): ChatDotKind | null {
  if (task.status === "waiting") return "attention";
  if (task.status === "starting" || task.status === "running") return "streaming";
  if (task.unread) return task.status === "failed" ? "unread-failed" : "unread";
  return null;
}

const chatDotLabel: Record<ChatDotKind, string> = {
  streaming: "Streaming",
  attention: "Needs your input",
  unread: "Unread reply",
  "unread-failed": "Failed, unread",
};

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

const menuSpring = {
  type: "spring" as const,
  stiffness: 540,
  damping: 33,
  mass: 0.7,
};

const INITIAL_PROJECT_CHAT_LIMIT = 5;
const PROJECT_CHAT_PAGE_SIZE = 10;
const INITIAL_SEARCH_RESULT_LIMIT = 80;

/** Keep paging on compositor-friendly properties. The previous height-per-row
 * animation forced layout on every frame and made the sidebar judder. */
const chatRowVariants = {
  hidden: { opacity: 0, y: -5, scale: 0.985 },
  visible: (stagger: number) => ({
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      duration: 0.18,
      ease: [0.2, 0, 0, 1] as const,
      delay: Math.min(stagger, 5) * 0.014,
    },
  }),
  exit: (stagger: number) => ({
    opacity: 0,
    y: -4,
    scale: 0.99,
    transition: {
      duration: 0.12,
      ease: [0.4, 0, 1, 1] as const,
      delay: Math.min(stagger, 3) * 0.01,
    },
  }),
};

const chatListLayoutSpring = {
  type: "spring" as const,
  stiffness: 560,
  damping: 44,
  mass: 0.6,
};

export function TaskSidebar({
  projects,
  tasks,
  activeProjectId,
  activeTaskId,
  openingProject,
  metadataActionsEnabled,
  taskActionBusyId,
  onSearchMessages,
  onSelectProject,
  onSelectTask,
  onNewTask,
  onNewTaskInProject,
  onOpenProject,
  onUpdateTask,
  onOpenSettings,
  onResize,
}: TaskSidebarProps) {
  const reduceMotion =
    Boolean(useReducedMotion()) ||
    (typeof document !== "undefined" && document.documentElement.dataset.motion === "none");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [messageHits, setMessageHits] = useState<TaskMessageSearchHit[]>([]);
  const [messageSearchLoading, setMessageSearchLoading] = useState(false);
  const [searchResultLimit, setSearchResultLimit] = useState(INITIAL_SEARCH_RESULT_LIMIT);
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>(() =>
    activeProjectId ? { [activeProjectId]: true } : {},
  );
  const [openMenuId, setOpenMenuId] = useState("");
  const [renamingId, setRenamingId] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [projectChatLimits, setProjectChatLimits] = useState<Record<string, number>>({});
  // Index each project's newest reveal started at, so only freshly exposed
  // rows pick up a cascade delay — settled rows never re-stagger.
  const [projectRevealFrom, setProjectRevealFrom] = useState<Record<string, number>>({});
  // Project whose collapse should hide the active-chat pill: the pill fades
  // in place while the chat rows fold under the clip, instead of trailing
  // them over the groups below.
  const [projectHidingSelection, setProjectHidingSelection] = useState("");
  const chatListRef = useRef<HTMLDivElement>(null);
  const searchResultsRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchGenerationRef = useRef(0);
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

  useEffect(
    () => () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      searchGenerationRef.current += 1;
    },
    [],
  );

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const updateSearch = (value: string) => {
    setQuery(value);
    setMessageHits([]);
    setSearchResultLimit(INITIAL_SEARCH_RESULT_LIMIT);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    const generation = ++searchGenerationRef.current;
    const normalized = value.trim();
    if (!onSearchMessages || normalized.length < 2) {
      setMessageSearchLoading(false);
      return;
    }
    setMessageSearchLoading(true);
    searchTimerRef.current = setTimeout(() => {
      void onSearchMessages(normalized)
        .then((hits) => {
          if (searchGenerationRef.current === generation) setMessageHits(hits);
        })
        .catch(() => {
          if (searchGenerationRef.current === generation) setMessageHits([]);
        })
        .finally(() => {
          if (searchGenerationRef.current === generation) setMessageSearchLoading(false);
        });
    }, 140);
  };

  const closeSearch = () => {
    setSearchOpen(false);
    updateSearch("");
    searchButtonRef.current?.focus();
  };

  const deferredQuery = useDeferredValue(query);
  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const messageHitByTask = useMemo(
    () => new Map(messageHits.map((hit) => [hit.taskId, hit.snippet])),
    [messageHits],
  );
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const searchResults = useMemo(() => {
    if (!normalizedQuery) return [];
    const titleMatches = sortTasks(
      tasks.filter((task) => {
        const project = projectById.get(task.projectId);
        return `${task.title} ${project?.name ?? ""}`.toLowerCase().includes(normalizedQuery);
      }),
    );
    const seen = new Set(titleMatches.map((task) => task.id));
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    for (const hit of messageHits) {
      const task = taskById.get(hit.taskId);
      if (task && !seen.has(task.id)) {
        seen.add(task.id);
        titleMatches.push(task);
      }
    }
    return titleMatches;
  }, [messageHits, normalizedQuery, projectById, tasks]);
  const visibleSearchResults = searchResults.slice(0, searchResultLimit);

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

  const selectionFadingForProject =
    Boolean(projectHidingSelection) &&
    !(expandedProjects[projectHidingSelection] ?? false) &&
    (tasksByProject.get(projectHidingSelection) ?? []).some((task) => task.id === activeTaskId);

  const focusRelativeChat = (
    direction: 1 | -1,
    container: HTMLDivElement | null = chatListRef.current,
  ) => {
    const buttons = Array.from(
      container?.querySelectorAll<HTMLButtonElement>("[data-chat-select]") ?? [],
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

  const renderChat = (
    task: TaskSummary,
    options?: {
      showProject?: boolean;
      nested?: boolean;
      searchResult?: boolean;
      snippet?: string;
    },
  ) => {
    const project = projectById.get(task.projectId);
    const busy = taskActionBusyId === task.id;
    const active = task.id === activeTaskId;
    const dotKind = chatDotKind(task);
    const meta = options?.snippet
      ? `${project?.name ?? "Project"} · ${options.snippet}`
      : chatMeta(task, {
          showProject: options?.showProject,
          projectName: project?.name,
        });
    if (renamingId === task.id && !options?.searchResult) {
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
        data-traveling-selection={options?.searchResult ? undefined : task.id}
        key={task.id}
      >
        <Tooltip label={task.title} hint={meta} placement="right">
          <button
            className="chat-row"
            data-chat-select
            type="button"
            onClick={() => {
              onSelectTask(task.id);
              if (options?.searchResult) closeSearch();
            }}
            aria-current={active ? "page" : undefined}
            data-status={task.status}
          >
            {dotKind && options?.nested ? (
              <motion.span
                key="activity-dot"
                className="chat-dot-transition"
                role="img"
                aria-label={chatDotLabel[dotKind]}
                initial={reduceMotion ? false : { opacity: 0, scale: 0.72 }}
                animate={{ opacity: active ? 0 : 1, scale: active ? 0.72 : 1 }}
                transition={
                  reduceMotion ? { duration: 0 } : { duration: 0.18, ease: [0.2, 0, 0, 1] }
                }
              >
                <span className={`chat-dot chat-dot--${dotKind}`} aria-hidden="true" />
              </motion.span>
            ) : null}
            <span className="chat-row-copy">
              <motion.span
                className="chat-row-title"
                key={task.title}
                initial={reduceMotion ? false : { opacity: 0, y: 2, filter: "blur(2px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                transition={
                  reduceMotion ? { duration: 0 } : { duration: 0.2, ease: [0.2, 0, 0, 1] }
                }
              >
                {task.title}
              </motion.span>
              {options?.showProject ? <small>{meta}</small> : null}
            </span>
            {task.pinned ? <Pin className="chat-pin" aria-label="Pinned" /> : null}
          </button>
        </Tooltip>
        {!options?.searchResult ? (
          <Tooltip label="More actions">
            <button
              className="chat-more-button"
              type="button"
              aria-label="More chat actions"
              aria-expanded={openMenuId === task.id}
              onClick={() => setOpenMenuId((current) => (current === task.id ? "" : task.id))}
              disabled={busy}
            >
              <MoreHorizontal />
            </button>
          </Tooltip>
        ) : null}
        <AnimatePresence>
          {openMenuId === task.id && !options?.searchResult ? (
            <motion.div
              className="chat-action-menu"
              role="menu"
              ref={menuRef}
              initial={reduceMotion ? false : { opacity: 0, y: -5, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={
                reduceMotion
                  ? undefined
                  : {
                      opacity: 0,
                      y: -3,
                      scale: 0.98,
                      transition: { duration: 0.12, ease: [0.2, 0, 0, 1] },
                    }
              }
              transition={reduceMotion ? { duration: 0 } : menuSpring}
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

  return (
    <>
      <aside className="task-sidebar" aria-label="Chat navigation">
        <div className="sidebar-brand-row">
          <BrandMark />
          <Tooltip label="Search chats" hint={`${mod} K`}>
            <motion.button
              ref={searchButtonRef}
              className="sidebar-search-button"
              type="button"
              aria-label="Search chats"
              aria-haspopup="dialog"
              aria-expanded={searchOpen}
              onClick={() => {
                setOpenMenuId("");
                setSearchOpen(true);
              }}
              whileTap={reduceMotion ? undefined : { scale: 0.94 }}
            >
              <Search aria-hidden="true" />
            </motion.button>
          </Tooltip>
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
            <Tooltip label={openingProject ? "Opening project…" : "Open another project"}>
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
            </Tooltip>
          </div>

          <LayoutGroup id="sidebar-chats">
            <div className="project-tree" aria-label="Projects">
              <TravelingSelection
                activeKey={activeTaskId}
                className="chat-row-active"
                visible={!selectionFadingForProject}
                layoutKey={`${showArchived}:${projects
                  .map(
                    (project) =>
                      `${project.id}:${expandedProjects[project.id] ?? false}:${projectChatLimits[project.id] ?? INITIAL_PROJECT_CHAT_LIMIT}`,
                  )
                  .join("|")}:${tasks
                  .map((task) => `${task.id}:${task.projectId}:${task.updatedAt}:${task.archived}`)
                  .join("|")}`}
              />
              {projects.map((project) => {
                const expanded = expandedProjects[project.id] ?? false;
                const allProjectTasks = tasksByProject.get(project.id) ?? [];
                const projectChats = expanded ? chatsForProject(project.id) : [];
                const chatLimit = projectChatLimits[project.id] ?? INITIAL_PROJECT_CHAT_LIMIT;
                const visibleProjectChats = projectChats.slice(0, chatLimit);
                const activeProjectChat = projectChats.find((task) => task.id === activeTaskId);
                if (
                  activeProjectChat &&
                  !visibleProjectChats.some((task) => task.id === activeProjectChat.id)
                ) {
                  visibleProjectChats.push(activeProjectChat);
                }
                const hiddenChatCount = Math.max(0, projectChats.length - chatLimit);
                const visibleCount = showArchived
                  ? allProjectTasks.filter((task) => task.archived).length
                  : allProjectTasks.filter((task) => !task.archived).length;
                return (
                  <motion.div
                    className="project-group"
                    data-active={project.id === activeProjectId}
                    key={project.id}
                    layout={reduceMotion ? false : "position"}
                    layoutDependency={`${expanded}:${showArchived}:${visibleProjectChats
                      .map((task) => task.id)
                      .join(",")}`}
                    transition={reduceMotion ? { duration: 0 } : { layout: chatListLayoutSpring }}
                  >
                    <div className="project-group-header">
                      <button
                        className="project-disclosure"
                        type="button"
                        aria-label={`${expanded ? "Collapse" : "Expand"} ${project.name}`}
                        aria-expanded={expanded}
                        onClick={() => {
                          if (expanded) {
                            const containsActiveChat = (tasksByProject.get(project.id) ?? []).some(
                              (task) => task.id === activeTaskId,
                            );
                            if (containsActiveChat) setProjectHidingSelection(project.id);
                          } else if (projectHidingSelection === project.id) {
                            setProjectHidingSelection("");
                          }
                          setExpandedProjects((current) => ({
                            ...current,
                            [project.id]: !expanded,
                          }));
                        }}
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
                        <AnimatedFolderIcon open={expanded} />
                        <span>{project.name}</span>
                      </button>
                      <span className="project-header-meta">
                        <small
                          className="project-count"
                          aria-label={`${visibleCount} chat${visibleCount === 1 ? "" : "s"}`}
                        >
                          {visibleCount}
                        </small>
                        {onNewTaskInProject ? (
                          <Tooltip label={`New chat in ${project.name}`}>
                            <button
                              className="project-new-chat"
                              type="button"
                              aria-label={`New chat in ${project.name}`}
                              onClick={() => onNewTaskInProject(project.id)}
                            >
                              <Plus aria-hidden="true" />
                            </button>
                          </Tooltip>
                        ) : null}
                      </span>
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
                            <>
                              <AnimatePresence initial={false} mode="popLayout">
                                {visibleProjectChats.map((task, index) => {
                                  const stagger = Math.min(
                                    Math.max(0, index - (projectRevealFrom[project.id] ?? index)),
                                    PROJECT_CHAT_PAGE_SIZE - 1,
                                  );
                                  return (
                                    <motion.div
                                      key={task.id}
                                      className="chat-reveal"
                                      custom={stagger}
                                      variants={reduceMotion ? undefined : chatRowVariants}
                                      initial={reduceMotion ? false : "hidden"}
                                      animate="visible"
                                      exit={reduceMotion ? undefined : "exit"}
                                      style={{
                                        position: "relative",
                                        overflow:
                                          openMenuId === task.id || renamingId === task.id
                                            ? "visible"
                                            : "hidden",
                                        zIndex: openMenuId === task.id ? 5 : undefined,
                                      }}
                                    >
                                      {renderChat(task, { nested: true })}
                                    </motion.div>
                                  );
                                })}
                              </AnimatePresence>
                              {hiddenChatCount > 0 || chatLimit > INITIAL_PROJECT_CHAT_LIMIT ? (
                                <motion.div
                                  className="project-chat-footer"
                                  layout={reduceMotion ? false : "position"}
                                  layoutDependency={chatLimit}
                                  transition={
                                    reduceMotion
                                      ? { duration: 0 }
                                      : { layout: chatListLayoutSpring }
                                  }
                                >
                                  {hiddenChatCount > 0 ? (
                                    <motion.button
                                      className="project-chat-more"
                                      type="button"
                                      whileTap={reduceMotion ? undefined : { scale: 0.98 }}
                                      onClick={() => {
                                        setProjectRevealFrom((current) => ({
                                          ...current,
                                          [project.id]: Math.min(chatLimit, projectChats.length),
                                        }));
                                        setProjectChatLimits((current) => ({
                                          ...current,
                                          [project.id]: chatLimit + PROJECT_CHAT_PAGE_SIZE,
                                        }));
                                      }}
                                    >
                                      <ChevronDown aria-hidden="true" />
                                      Show {Math.min(PROJECT_CHAT_PAGE_SIZE, hiddenChatCount)} more
                                    </motion.button>
                                  ) : null}
                                  {chatLimit > INITIAL_PROJECT_CHAT_LIMIT ? (
                                    <motion.button
                                      className="project-chat-more project-chat-less"
                                      type="button"
                                      whileTap={reduceMotion ? undefined : { scale: 0.98 }}
                                      onClick={() => {
                                        setProjectRevealFrom((current) => ({
                                          ...current,
                                          [project.id]: INITIAL_PROJECT_CHAT_LIMIT,
                                        }));
                                        setProjectChatLimits((current) => ({
                                          ...current,
                                          [project.id]: INITIAL_PROJECT_CHAT_LIMIT,
                                        }));
                                      }}
                                    >
                                      <ChevronUp aria-hidden="true" />
                                      Show less
                                    </motion.button>
                                  ) : null}
                                </motion.div>
                              ) : null}
                            </>
                          ) : (
                            <p className="project-chat-empty" role="status">
                              {showArchived ? "No archived chats" : "No chats yet"}
                            </p>
                          )}
                        </motion.div>
                      ) : null}
                    </AnimatePresence>
                  </motion.div>
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
      {typeof document !== "undefined"
        ? createPortal(
            <AnimatePresence>
              {searchOpen ? (
                <motion.div
                  className="search-modal-backdrop"
                  role="presentation"
                  initial={reduceMotion ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={reduceMotion ? undefined : { opacity: 0 }}
                  transition={{ duration: reduceMotion ? 0 : 0.16 }}
                  onMouseDown={(event) => {
                    if (event.target === event.currentTarget) closeSearch();
                  }}
                >
                  <motion.section
                    className="search-modal"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="chat-search-title"
                    initial={reduceMotion ? false : { opacity: 0, y: -12, scale: 0.985 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={reduceMotion ? undefined : { opacity: 0, y: -8, scale: 0.99 }}
                    transition={
                      reduceMotion
                        ? { duration: 0 }
                        : { type: "spring", stiffness: 460, damping: 36, mass: 0.75 }
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        closeSearch();
                        return;
                      }
                      if (event.key !== "Tab") return;
                      const focusable = Array.from(
                        event.currentTarget.querySelectorAll<HTMLElement>(
                          "button:not(:disabled), input:not(:disabled)",
                        ),
                      );
                      const first = focusable[0];
                      const last = focusable.at(-1);
                      if (event.shiftKey && document.activeElement === first) {
                        event.preventDefault();
                        last?.focus();
                      } else if (!event.shiftKey && document.activeElement === last) {
                        event.preventDefault();
                        first?.focus();
                      }
                    }}
                  >
                    <header className="search-modal-header">
                      <h2 id="chat-search-title">Search chats</h2>
                      <Tooltip label="Close search">
                        <button
                          className="search-modal-close"
                          type="button"
                          aria-label="Close search"
                          onClick={closeSearch}
                        >
                          <X aria-hidden="true" />
                        </button>
                      </Tooltip>
                    </header>
                    <label className="search-modal-input">
                      <Search aria-hidden="true" />
                      <span className="sr-only">Search chats</span>
                      <input
                        ref={searchInputRef}
                        aria-label="Search chats"
                        value={query}
                        onChange={(event) => updateSearch(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "ArrowDown") {
                            event.preventDefault();
                            focusRelativeChat(1, searchResultsRef.current);
                          }
                        }}
                        placeholder="Search chats, projects, and messages"
                      />
                      <kbd>{mod} K</kbd>
                    </label>
                    <div
                      className="search-modal-results"
                      ref={searchResultsRef}
                      aria-busy={messageSearchLoading}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                          event.preventDefault();
                          focusRelativeChat(
                            event.key === "ArrowDown" ? 1 : -1,
                            searchResultsRef.current,
                          );
                        }
                      }}
                    >
                      {normalizedQuery ? (
                        <>
                          <div className="search-modal-results-heading">
                            <span>Results</span>
                            <small>
                              {messageSearchLoading ? "Searching…" : searchResults.length}
                            </small>
                          </div>
                          {searchResults.length ? (
                            <div className="search-modal-result-list">
                              {visibleSearchResults.map((task) =>
                                renderChat(task, {
                                  showProject: true,
                                  searchResult: true,
                                  snippet: messageHitByTask.get(task.id),
                                }),
                              )}
                              {searchResults.length > searchResultLimit ? (
                                <button
                                  className="project-chat-more"
                                  type="button"
                                  onClick={() => setSearchResultLimit((current) => current + 120)}
                                >
                                  Show more results
                                </button>
                              ) : null}
                            </div>
                          ) : messageSearchLoading ? (
                            <div className="search-modal-state" role="status">
                              <Search aria-hidden="true" />
                              <strong>Searching…</strong>
                              <span>Looking through your chat history.</span>
                            </div>
                          ) : (
                            <div className="search-modal-state" role="status">
                              <History aria-hidden="true" />
                              <strong>No matching chats</strong>
                              <span>Try a chat title, project, or words from a message.</span>
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="search-modal-state search-modal-state--idle">
                          <Search aria-hidden="true" />
                          <strong>Find any conversation</strong>
                          <span>Search by chat title, project, or message text.</span>
                        </div>
                      )}
                    </div>
                  </motion.section>
                </motion.div>
              ) : null}
            </AnimatePresence>,
            document.body,
          )
        : null}
    </>
  );
}
