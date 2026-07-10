import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Archive,
  ChevronDown,
  Folder,
  GitBranch,
  History,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import type { ProjectSummary, TaskSummary } from "../bridge";
import { BrandMark } from "./BrandMark";

interface TaskSidebarProps {
  projects: ProjectSummary[];
  tasks: TaskSummary[];
  activeTaskId: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelectTask: (taskId: string) => void;
  onNewTask: () => void;
  onOpenProject: () => void;
  openingProject: boolean;
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

export function TaskSidebar({
  projects,
  tasks,
  activeTaskId,
  collapsed,
  onToggleCollapsed,
  onSelectTask,
  onNewTask,
  onOpenProject,
  openingProject,
  onOpenSettings,
}: TaskSidebarProps) {
  const [query, setQuery] = useState("");
  const [projectExpansion, setProjectExpansion] = useState<Record<string, boolean>>({});

  const visibleTasks = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized
      ? tasks.filter((task) => task.title.toLowerCase().includes(normalized))
      : tasks;
  }, [query, tasks]);

  const toggleProject = (projectId: string) => {
    const project = projects.find((item) => item.id === projectId);
    setProjectExpansion((current) => ({
      ...current,
      [projectId]: !(current[projectId] ?? project?.expanded ?? false),
    }));
  };

  if (collapsed) {
    return (
      <aside className="task-sidebar task-sidebar--collapsed" aria-label="Project navigation">
        <div className="rail-icon-stack">
          <BrandMark compact />
          <button className="icon-button" type="button" onClick={onNewTask} aria-label="New task">
            <Plus />
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={onToggleCollapsed}
            aria-label="Expand project navigation"
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
    <aside className="task-sidebar" aria-label="Project navigation">
      <div className="sidebar-brand-row">
        <BrandMark />
        <button
          className="icon-button subtle"
          type="button"
          onClick={onToggleCollapsed}
          aria-label="Collapse project navigation"
        >
          <PanelLeftClose />
        </button>
      </div>

      <button className="new-task-button" type="button" onClick={onNewTask}>
        <Plus aria-hidden="true" />
        <span>New task</span>
        <kbd>Ctrl N</kbd>
      </button>

      <label className="sidebar-search">
        <Search aria-hidden="true" />
        <span className="sr-only">Search tasks</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search tasks"
        />
        <kbd>⌘ K</kbd>
      </label>

      <div className="sidebar-scroll">
        <div className="rail-section-heading">
          <span>Projects</span>
          <button
            type="button"
            className="icon-button tiny"
            aria-label={openingProject ? "Opening project" : "Open project"}
            onClick={onOpenProject}
            disabled={openingProject}
            aria-busy={openingProject}
          >
            <Plus />
          </button>
        </div>

        {projects.length === 0 ? (
          <button
            className="sidebar-empty-project"
            type="button"
            onClick={onOpenProject}
            disabled={openingProject}
          >
            <Folder aria-hidden="true" />
            <span>
              <strong>{openingProject ? "Opening folder…" : "Open your first project"}</strong>
              <small>Choose a local Git repository</small>
            </span>
          </button>
        ) : null}

        {projects.map((project) => {
          const expanded = projectExpansion[project.id] ?? project.expanded;
          const projectTasks = visibleTasks.filter((task) => task.projectId === project.id);
          if (query && projectTasks.length === 0) return null;
          return (
            <section className="project-group" key={project.id}>
              <button
                className="project-row"
                type="button"
                onClick={() => toggleProject(project.id)}
                aria-expanded={expanded}
              >
                <ChevronDown
                  className={expanded ? "disclosure disclosure--open" : "disclosure"}
                  aria-hidden="true"
                />
                <Folder aria-hidden="true" />
                <span className="row-label">{project.name}</span>
                {project.dirtyFiles ? (
                  <span className="quiet-count" title={`${project.dirtyFiles} changed files`}>
                    {project.dirtyFiles}
                  </span>
                ) : null}
              </button>
              <AnimatePresence initial={false}>
                {expanded ? (
                  <motion.div
                    className="project-task-list"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.18 }}
                  >
                    {projectTasks.map((task) => (
                      <button
                        key={task.id}
                        className="task-row"
                        data-active={task.id === activeTaskId}
                        type="button"
                        onClick={() => onSelectTask(task.id)}
                        aria-current={task.id === activeTaskId ? "page" : undefined}
                      >
                        <span
                          className={`status-dot status-dot--${task.status}`}
                          aria-hidden="true"
                        />
                        <span className="task-row-copy">
                          <span>{task.title}</span>
                          <small>
                            <GitBranch aria-hidden="true" /> {task.worktree ?? project.branch}
                          </small>
                        </span>
                        {task.unread ? (
                          <span className="unread-dot">
                            <span className="sr-only">Unread</span>
                          </span>
                        ) : null}
                        <span className="sr-only">{statusLabel[task.status]}</span>
                      </button>
                    ))}
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </section>
          );
        })}

        <div className="rail-section-heading rail-section-heading--later">
          <span>Library</span>
        </div>
        <button className="utility-row" type="button">
          <History />
          <span>Past sessions</span>
        </button>
        <button className="utility-row" type="button">
          <Archive />
          <span>Archived</span>
        </button>
      </div>

      <button
        className="sidebar-settings-row"
        type="button"
        onClick={onOpenSettings}
        aria-label="Open Settings"
      >
        <Settings aria-hidden="true" />
        <span>
          <strong>Settings</strong>
          <small>Appearance, agents, Git</small>
        </span>
      </button>
    </aside>
  );
}
