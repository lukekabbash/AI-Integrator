//! The group a tab belongs to: its task's project, or the one Chat group.
//!
//! A group is derived from the task and never edited. Ids are stable across
//! restarts (a project's uuid; a digest of an unregistered path), names can
//! change when a project is re-registered, so names are cached per task and
//! the cache is cleared from the project commands.

use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
};

use integrator_core::{ProjectId, TaskId, TaskKind};
use serde::{Deserialize, Serialize};
use session_store::LocalStore;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Runtime};

use super::BrowserTabs;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GroupKind {
    Chat,
    Project,
    Path,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    pub kind: GroupKind,
}

pub const CHAT_GROUP_ID: &str = "chat";
pub const CHAT_GROUP_NAME: &str = "Chat";

/// The name given to a task the store cannot describe. Its group is still a
/// stable path over the task id, so its tabs never join another group.
const UNKNOWN_GROUP_NAME: &str = "Unknown";

/// The name given to a path with no last component.
const WORKSPACE_GROUP_NAME: &str = "Workspace";

impl Group {
    pub fn chat() -> Self {
        Self {
            id: CHAT_GROUP_ID.to_string(),
            name: CHAT_GROUP_NAME.to_string(),
            kind: GroupKind::Chat,
        }
    }
}

/// `project:<uuid>` for a trusted project.
pub fn project_group_id(project: ProjectId) -> String {
    format!("project:{project}")
}

/// `path:<sha256 prefix>` for a Code task whose path matches no trusted
/// project. A digest, not a counter, so the id survives restarts.
pub fn path_group_id(repository_path: &Path) -> String {
    let digest = Sha256::digest(repository_path.to_string_lossy().as_bytes());
    let hex = format!("{digest:x}");
    format!("path:{}", &hex[..32])
}

/// The last component of the path, or "Workspace" when there is none.
pub fn path_group_name(repository_path: &Path) -> String {
    repository_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| WORKSPACE_GROUP_NAME.to_string())
}

/// The store's answer. Chat → Chat; Code with a trusted project → Project;
/// Code with an unregistered path → Path; unparsable / missing task → Path
/// over the task id itself, named "Unknown". Never errors: a tab must always
/// have a group.
pub fn resolve_group(store: &LocalStore, task_id: &str) -> Group {
    let unknown = || Group {
        id: path_group_id(Path::new(task_id)),
        name: UNKNOWN_GROUP_NAME.to_string(),
        kind: GroupKind::Path,
    };
    let Ok(id) = task_id.parse::<TaskId>() else {
        return unknown();
    };
    let Ok(task) = store.get_task(id) else {
        return unknown();
    };
    if task.kind == TaskKind::Chat {
        return Group::chat();
    }
    let Some(path) = task.repository_path else {
        return unknown();
    };
    if let Ok(Some(project)) = store.project_for_repository_path(&path) {
        return Group {
            id: project_group_id(project.id),
            name: project.display_name,
            kind: GroupKind::Project,
        };
    }
    Group {
        id: path_group_id(&path),
        name: path_group_name(&path),
        kind: GroupKind::Path,
    }
}

/// Cached per task in `BrowserTabs`; a task's path never changes, so the id is
/// fixed. Names can change when a project is re-registered, so
/// `invalidate_groups` clears the cache from the project commands.
pub fn group_for_task<R: Runtime>(app: &AppHandle<R>, tabs: &BrowserTabs, task_id: &str) -> Group {
    if let Some(group) = tabs.cached_group(task_id) {
        return group;
    }
    let group = match app.try_state::<crate::state::AppState>() {
        Some(state) => resolve_group(&state.store, task_id),
        None => Group {
            id: path_group_id(Path::new(task_id)),
            name: UNKNOWN_GROUP_NAME.to_string(),
            kind: GroupKind::Path,
        },
    };
    tabs.cache_group(task_id, group.clone());
    group
}

/// Forgets every cached group so the next lookup re-reads the store. Called
/// when a project is registered, created, cloned or removed.
pub fn invalidate_groups(tabs: &BrowserTabs) {
    tabs.groups
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clear();
}

/// [`invalidate_groups`] for the app's registry, when there is one.
pub fn invalidate_groups_in<R: Runtime>(app: &AppHandle<R>) {
    if let Some(tabs) = app.try_state::<Arc<BrowserTabs>>() {
        invalidate_groups(&tabs);
    }
}

pub(crate) type GroupCache = Mutex<HashMap<String, Group>>;

impl BrowserTabs {
    fn cached_group(&self, task_id: &str) -> Option<Group> {
        self.groups
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(task_id)
            .cloned()
    }

    fn cache_group(&self, task_id: &str, group: Group) {
        self.groups
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(task_id.to_string(), group);
    }

    /// The cached name for a task's group, when one has been resolved since
    /// the cache was last cleared. Snapshots use it to rename a pill after a
    /// project is re-registered without touching each tab.
    pub(crate) fn cached_group_name(&self, task_id: &str) -> Option<String> {
        self.cached_group(task_id).map(|group| group.name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use integrator_core::NewTask;
    use std::path::PathBuf;

    #[test]
    fn project_ids_carry_the_uuid() {
        let project = ProjectId::new();
        assert_eq!(project_group_id(project), format!("project:{project}"));
    }

    #[test]
    fn path_ids_are_stable_digests() {
        let path = Path::new("/home/luke/repo");
        let id = path_group_id(path);
        assert_eq!(id, path_group_id(path));
        assert!(id.starts_with("path:"));
        assert_eq!(id.len(), "path:".len() + 32);
        assert!(id["path:".len()..].chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(id, path_group_id(Path::new("/home/luke/other")));
        // Same string, same id: the digest is over the lossy path string.
        assert_eq!(
            path_group_id(Path::new("H:\\Code\\repo")),
            path_group_id(&PathBuf::from("H:\\Code\\repo"))
        );
    }

    #[test]
    fn path_names_are_the_last_component() {
        assert_eq!(path_group_name(Path::new("/home/luke/repo")), "repo");
        assert_eq!(
            path_group_name(Path::new("H:\\Code\\integrator-3")),
            "integrator-3"
        );
        assert_eq!(path_group_name(Path::new("/")), WORKSPACE_GROUP_NAME);
        assert_eq!(path_group_name(Path::new("")), WORKSPACE_GROUP_NAME);
    }

    #[test]
    fn serializes_camel_case() {
        assert_eq!(
            serde_json::to_string(&GroupKind::Project).unwrap(),
            "\"project\""
        );
        let group = Group::chat();
        assert_eq!(
            serde_json::to_value(&group).unwrap(),
            serde_json::json!({ "id": "chat", "name": "Chat", "kind": "chat" })
        );
    }

    fn task(store: &LocalStore, kind: TaskKind, path: Option<PathBuf>) -> String {
        store
            .create_task(NewTask {
                kind,
                title: "t".into(),
                repository_path: path,
                worktree_path: None,
                runtime: None,
                model: None,
                effort: None,
                parent_task_id: None,
            })
            .expect("create task")
            .id
            .to_string()
    }

    #[test]
    fn resolves_chat_project_path_and_unknown() {
        let directory = tempfile::tempdir().expect("temp directory");
        let repository = directory.path().join("repository");
        let stray = directory.path().join("stray");
        std::fs::create_dir_all(&repository).expect("fixture");
        let store = LocalStore::open_in_memory().expect("open store");
        let project = store
            .upsert_trusted_project("My project", &repository, None)
            .expect("register project");

        let chat = task(&store, TaskKind::Chat, None);
        assert_eq!(resolve_group(&store, &chat), Group::chat());

        let code = task(&store, TaskKind::Code, Some(repository.clone()));
        assert_eq!(
            resolve_group(&store, &code),
            Group {
                id: project_group_id(project.id),
                name: "My project".into(),
                kind: GroupKind::Project,
            }
        );

        let unregistered = task(&store, TaskKind::Code, Some(stray.clone()));
        assert_eq!(
            resolve_group(&store, &unregistered),
            Group {
                id: path_group_id(&stray),
                name: "stray".into(),
                kind: GroupKind::Path,
            }
        );

        let missing = TaskId::new().to_string();
        assert_eq!(
            resolve_group(&store, &missing),
            Group {
                id: path_group_id(Path::new(&missing)),
                name: UNKNOWN_GROUP_NAME.into(),
                kind: GroupKind::Path,
            }
        );
        let garbage = resolve_group(&store, "not-a-task");
        assert_eq!(garbage.kind, GroupKind::Path);
        assert_eq!(garbage.name, UNKNOWN_GROUP_NAME);
        assert_eq!(garbage.id, path_group_id(Path::new("not-a-task")));
    }

    #[test]
    fn re_registering_renames_the_project_group_but_keeps_its_id() {
        let directory = tempfile::tempdir().expect("temp directory");
        let repository = directory.path().join("repository");
        std::fs::create_dir_all(&repository).expect("fixture");
        let store = LocalStore::open_in_memory().expect("open store");
        store
            .upsert_trusted_project("First name", &repository, None)
            .expect("register project");
        let code = task(&store, TaskKind::Code, Some(repository.clone()));
        let before = resolve_group(&store, &code);
        store
            .upsert_trusted_project("Second name", &repository, None)
            .expect("re-register project");
        let after = resolve_group(&store, &code);
        assert_eq!(before.id, after.id);
        assert_eq!(after.name, "Second name");
    }

    #[test]
    fn the_cache_answers_until_invalidated() {
        let tabs = BrowserTabs::new();
        assert!(tabs.cached_group_name("task-a").is_none());
        tabs.cache_group("task-a", Group::chat());
        assert_eq!(tabs.cached_group_name("task-a").as_deref(), Some("Chat"));
        invalidate_groups(&tabs);
        assert!(tabs.cached_group_name("task-a").is_none());
    }
}
