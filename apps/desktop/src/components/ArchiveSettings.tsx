import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArchiveRestore, Folder, Search, Trash2 } from "lucide-react";
import { Dropdown } from "./Dropdown";
import { SettingRow } from "./SettingControls";
import { readSetting, type SettingsMap } from "./settingsModel";

// Relative timestamps match the compact labels used in the chat sidebar.
function formatRelativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 60_000) return "just now";
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const AUTO_ARCHIVE_OPTIONS = [
  { value: "never", label: "Never" },
  { value: "7d", label: "After 7 days" },
  { value: "14d", label: "After 14 days" },
  { value: "30d", label: "After 30 days" },
  { value: "90d", label: "After 90 days" },
];

const AUTO_DELETE_OPTIONS = [
  { value: "never", label: "Never" },
  { value: "24h", label: "After 24 hours" },
  { value: "3d", label: "After 3 days" },
  { value: "7d", label: "After 7 days" },
  { value: "30d", label: "After 30 days" },
  { value: "90d", label: "After 90 days" },
];

export interface ArchiveProject {
  id: string;
  name: string;
  path: string;
  archived?: boolean;
}

export interface ArchiveTask {
  id: string;
  projectId: string;
  title: string;
  updatedAt: string;
  archived?: boolean;
  parentId?: string;
}

export interface ArchiveSettingsProps {
  projects: ArchiveProject[];
  tasks: ArchiveTask[];
  taskActionBusyId?: string;
  archivedLoading?: boolean;
  archivedHasMore?: boolean;
  onEnsureArchived?: () => void;
  onLoadMoreArchived?: () => void;
  settings: SettingsMap;
  setSetting: (key: string, value: unknown) => void;
  onOpenTask?: (taskId: string) => void;
  onUpdateTask?: (taskId: string, patch: { archived?: boolean }) => void;
  onUpdateProject?: (projectId: string, patch: { archived?: boolean }) => void;
  onDeleteTask?: (taskId: string) => void;
  onDeleteProject?: (projectId: string) => void;
  onDeleteArchivedChats?: (projectId: string) => void;
}

/**
 * A full-width view over the same archive the sidebar toggle shows, sized for
 * triage: filter across every project at once, then restore, reopen, or
 * delete without leaving the page. Destructive actions defer to the shared
 * confirmation modals owned by the workspace.
 */
export function ArchiveSettings({
  projects,
  tasks,
  taskActionBusyId,
  archivedLoading = false,
  archivedHasMore = false,
  onEnsureArchived,
  onLoadMoreArchived,
  settings,
  setSetting,
  onOpenTask,
  onUpdateTask,
  onUpdateProject,
  onDeleteTask,
  onDeleteProject,
  onDeleteArchivedChats,
}: ArchiveSettingsProps) {
  const [filter, setFilter] = useState("");
  const ensureArchivedRef = useRef(onEnsureArchived);
  useEffect(() => {
    ensureArchivedRef.current = onEnsureArchived;
  }, [onEnsureArchived]);
  useEffect(() => {
    ensureArchivedRef.current?.();
  }, []);
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  const archivedChats = useMemo(
    () =>
      tasks
        .filter((task) => task.archived && !task.parentId)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [tasks],
  );
  const archivedProjects = projects.filter((project) => project.archived);
  const query = filter.trim().toLowerCase();
  const visibleChats = query
    ? archivedChats.filter(
        (task) =>
          task.title.toLowerCase().includes(query) ||
          (projectNames.get(task.projectId) ?? "").toLowerCase().includes(query),
      )
    : archivedChats;
  // Group in the sidebar's project order so both archive views read the same.
  const groups = projects
    .map((project) => ({
      project,
      chats: visibleChats.filter((task) => task.projectId === project.id),
    }))
    .filter((group) => group.chats.length > 0);
  const canMutate = Boolean(onUpdateTask);

  return (
    <>
      <div className="settings-page-heading">
        <span>
          <Archive />
        </span>
        <div>
          <h1>Archives</h1>
          <p>
            Everything you have archived, in one sortable place. The sidebar toggle shows the same
            data next to your chats.
          </p>
        </div>
      </div>
      <section className="settings-section">
        <header>
          <h2>Retention</h2>
          <p>Automatically archive inactive chats and delete archived ones after a delay.</p>
        </header>
        <SettingRow
          label="Auto-archive inactive chats"
          description="Archive chats with no activity for this long. Pinned chats and the open chat are never touched."
        >
          <Dropdown
            aria-label="Auto-archive inactive chats"
            value={readSetting(settings, "archive.autoArchiveAfter", "never")}
            onChange={(value) => setSetting("archive.autoArchiveAfter", value)}
            options={AUTO_ARCHIVE_OPTIONS}
          />
        </SettingRow>
        <SettingRow
          label="Auto-delete archived chats"
          description="Permanently delete a chat this long after it was archived. The timer starts at archival, not at last activity."
        >
          <Dropdown
            aria-label="Auto-delete archived chats"
            value={readSetting(settings, "archive.autoDeleteAfter", "never")}
            onChange={(value) => setSetting("archive.autoDeleteAfter", value)}
            options={AUTO_DELETE_OPTIONS}
          />
        </SettingRow>
      </section>
      <section className="settings-section">
        <header>
          <h2>Archived chats{archivedChats.length ? ` · ${archivedChats.length}` : ""}</h2>
          <p>Restore returns a chat to its project; Open jumps straight back into it.</p>
        </header>
        {archivedChats.length > 0 ? (
          <label className="settings-search archive-filter">
            <Search />
            <span className="sr-only">Filter archived chats</span>
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter by title or project"
            />
          </label>
        ) : null}
        {archivedLoading && archivedChats.length === 0 ? (
          <p className="archive-empty" role="status">
            Loading archived chats…
          </p>
        ) : archivedChats.length === 0 ? (
          <p className="archive-empty" role="status">
            Nothing archived. Chats you archive from the sidebar will show up here.
          </p>
        ) : groups.length === 0 ? (
          <p className="archive-empty" role="status">
            No archived chats match “{filter.trim()}”.
          </p>
        ) : (
          groups.map(({ project, chats }) => (
            <div className="archive-group" key={project.id}>
              <div className="archive-group-header">
                <Folder aria-hidden="true" />
                <strong>{project.name}</strong>
                <small>{chats.length}</small>
                {onDeleteArchivedChats && !project.archived ? (
                  <button
                    className="archive-action archive-action--danger"
                    type="button"
                    onClick={() => onDeleteArchivedChats(project.id)}
                  >
                    Delete all…
                  </button>
                ) : null}
              </div>
              {chats.map((task) => (
                <div className="archive-row" key={task.id}>
                  <span className="archive-row-copy">
                    <strong>{task.title || "Untitled chat"}</strong>
                    <small>{formatRelativeTime(task.updatedAt)}</small>
                  </span>
                  <div className="archive-row-actions">
                    {onOpenTask ? (
                      <button
                        className="archive-action"
                        type="button"
                        onClick={() => onOpenTask(task.id)}
                      >
                        Open
                      </button>
                    ) : null}
                    {canMutate ? (
                      <button
                        className="archive-action"
                        type="button"
                        disabled={taskActionBusyId === task.id}
                        onClick={() => onUpdateTask?.(task.id, { archived: false })}
                      >
                        <ArchiveRestore aria-hidden="true" /> Restore
                      </button>
                    ) : null}
                    {onDeleteTask ? (
                      <button
                        className="archive-action archive-action--danger"
                        type="button"
                        onClick={() => onDeleteTask(task.id)}
                      >
                        <Trash2 aria-hidden="true" /> Delete…
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
        {archivedHasMore ? (
          <button
            className="archive-action"
            type="button"
            disabled={archivedLoading}
            onClick={() => onLoadMoreArchived?.()}
          >
            {archivedLoading ? "Loading…" : "Show more archived chats"}
          </button>
        ) : null}
      </section>
      {archivedProjects.length > 0 ? (
        <section className="settings-section">
          <header>
            <h2>Archived projects · {archivedProjects.length}</h2>
            <p>Restoring a project brings its chats back to the sidebar unchanged.</p>
          </header>
          {archivedProjects.map((project) => (
            <div className="archive-row" key={project.id}>
              <span className="archive-row-copy">
                <strong>{project.name}</strong>
                <small>{project.path}</small>
              </span>
              <div className="archive-row-actions">
                {onUpdateProject ? (
                  <button
                    className="archive-action"
                    type="button"
                    onClick={() => onUpdateProject(project.id, { archived: false })}
                  >
                    <ArchiveRestore aria-hidden="true" /> Restore
                  </button>
                ) : null}
                {onDeleteProject ? (
                  <button
                    className="archive-action archive-action--danger"
                    type="button"
                    onClick={() => onDeleteProject(project.id)}
                  >
                    <Trash2 aria-hidden="true" /> Delete…
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </section>
      ) : null}
    </>
  );
}
