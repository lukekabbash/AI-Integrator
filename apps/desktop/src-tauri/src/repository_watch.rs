use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    time::Duration,
};

use notify_debouncer_mini::{
    Config, DebounceEventResult, Debouncer, new_debouncer_opt,
    notify::{RecommendedWatcher, RecursiveMode},
};
use serde::Serialize;
use tauri::{Emitter, State, WebviewWindow};

use crate::{
    command_api::{CommandError, CommandResult},
    commands::authorized_project_directory,
    state::AppState,
};

const WORKING_TREE_CHANGED_EVENT: &str = "git://working-tree-changed";
const WATCH_DEBOUNCE: Duration = Duration::from_millis(100);

type NativeDebouncer = Debouncer<RecommendedWatcher>;

pub struct RepositoryWatcher {
    _debouncer: NativeDebouncer,
}

struct ActiveWatch<T> {
    id: String,
    _watch: T,
}

struct WatchSlot<T> {
    desired_id: Option<String>,
    active: Option<ActiveWatch<T>>,
}

pub struct RepositoryWatchRegistry<T> {
    slots: HashMap<String, WatchSlot<T>>,
}

impl<T> Default for WatchSlot<T> {
    fn default() -> Self {
        Self {
            desired_id: None,
            active: None,
        }
    }
}

impl<T> Default for RepositoryWatchRegistry<T> {
    fn default() -> Self {
        Self {
            slots: HashMap::new(),
        }
    }
}

impl<T> RepositoryWatchRegistry<T> {
    fn begin(&mut self, window_label: &str, watch_id: &str) {
        self.slots
            .entry(window_label.to_owned())
            .or_default()
            .desired_id = Some(watch_id.to_owned());
    }

    fn install(&mut self, window_label: &str, watch_id: &str, watch: T) -> bool {
        let Some(slot) = self.slots.get_mut(window_label) else {
            return false;
        };
        if slot.desired_id.as_deref() != Some(watch_id) {
            return false;
        }
        slot.active = Some(ActiveWatch {
            id: watch_id.to_owned(),
            _watch: watch,
        });
        true
    }

    fn stop(&mut self, window_label: &str, watch_id: &str) {
        let mut remove_slot = false;
        if let Some(slot) = self.slots.get_mut(window_label) {
            if slot.desired_id.as_deref() == Some(watch_id) {
                slot.desired_id = None;
            }
            if slot
                .active
                .as_ref()
                .is_some_and(|active| active.id == watch_id)
            {
                slot.active = None;
            }
            remove_slot = slot.desired_id.is_none() && slot.active.is_none();
        }
        if remove_slot {
            self.slots.remove(window_label);
        }
    }

    pub fn remove_window(&mut self, window_label: &str) {
        self.slots.remove(window_label);
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkingTreeChanged {
    watch_id: String,
}

fn is_working_tree_path(root: &Path, candidate: &Path) -> bool {
    let Ok(relative) = candidate.strip_prefix(root) else {
        return false;
    };
    let mut components = relative.components();
    let Some(first) = components.next() else {
        return false;
    };
    std::iter::once(first)
        .chain(components)
        .all(|component| !matches!(component, Component::Normal(name) if name == ".git"))
}

fn create_watcher(
    window: WebviewWindow,
    watch_id: String,
    root: PathBuf,
) -> CommandResult<RepositoryWatcher> {
    let event_watch_id = watch_id.clone();
    let event_root = root.clone();
    let config = Config::default()
        .with_timeout(WATCH_DEBOUNCE)
        .with_batch_mode(true);
    let mut debouncer =
        new_debouncer_opt::<_, RecommendedWatcher>(config, move |result: DebounceEventResult| {
            match result {
                Ok(events)
                    if events
                        .iter()
                        .any(|event| is_working_tree_path(&event_root, &event.path)) =>
                {
                    let _ = window.emit(
                        WORKING_TREE_CHANGED_EVENT,
                        WorkingTreeChanged {
                            watch_id: event_watch_id.clone(),
                        },
                    );
                }
                Ok(_) => {}
                Err(error) => eprintln!("working-tree watcher event failed: {error}"),
            }
        })
        .map_err(|error| CommandError {
            code: "unavailable",
            message: format!("could not start the working-tree watcher: {error}"),
        })?;
    debouncer
        .watcher()
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|error| CommandError {
            code: "unavailable",
            message: format!("could not watch the working tree: {error}"),
        })?;
    Ok(RepositoryWatcher {
        _debouncer: debouncer,
    })
}

#[tauri::command]
pub async fn repository_watch_start(
    window: WebviewWindow,
    state: State<'_, AppState>,
    watch_id: String,
    repository: PathBuf,
) -> CommandResult<()> {
    if watch_id.trim().is_empty() {
        return Err(CommandError {
            code: "invalid-input",
            message: "working-tree watch id is required".into(),
        });
    }
    let window_label = window.label().to_owned();
    state
        .repository_watchers
        .lock()
        .expect("repository watcher registry lock")
        .begin(&window_label, &watch_id);

    let root = match authorized_project_directory(&state, repository).await {
        Ok(root) => root,
        Err(error) => {
            state
                .repository_watchers
                .lock()
                .expect("repository watcher registry lock")
                .stop(&window_label, &watch_id);
            return Err(error);
        }
    };
    let watcher = match create_watcher(window, watch_id.clone(), root) {
        Ok(watcher) => watcher,
        Err(error) => {
            state
                .repository_watchers
                .lock()
                .expect("repository watcher registry lock")
                .stop(&window_label, &watch_id);
            return Err(error);
        }
    };
    state
        .repository_watchers
        .lock()
        .expect("repository watcher registry lock")
        .install(&window_label, &watch_id, watcher);
    Ok(())
}

#[tauri::command]
pub fn repository_watch_stop(window: WebviewWindow, state: State<'_, AppState>, watch_id: String) {
    state
        .repository_watchers
        .lock()
        .expect("repository watcher registry lock")
        .stop(window.label(), &watch_id);
}

#[cfg(test)]
mod tests {
    use super::{RepositoryWatchRegistry, WATCH_DEBOUNCE, is_working_tree_path, new_debouncer_opt};
    use notify_debouncer_mini::{
        Config, DebounceEventResult,
        notify::{RecommendedWatcher, RecursiveMode},
    };
    use std::{fs, path::Path, sync::mpsc, time::Duration};

    #[test]
    fn happy_working_tree_file_is_refresh_worthy() {
        assert!(is_working_tree_path(
            Path::new("/repo"),
            Path::new("/repo/src/main.rs")
        ));
    }

    #[test]
    fn degraded_root_metadata_event_is_ignored() {
        assert!(!is_working_tree_path(
            Path::new("/repo"),
            Path::new("/repo")
        ));
    }

    #[test]
    fn adversarial_git_internal_event_is_ignored() {
        assert!(!is_working_tree_path(
            Path::new("/repo"),
            Path::new("/repo/.git/index")
        ));
    }

    #[test]
    #[ignore = "requires host filesystem notifications unavailable in sandboxed test runners"]
    fn native_backend_reports_a_real_file_edit() {
        let directory = tempfile::tempdir().expect("temporary repository");
        let root = dunce::canonicalize(directory.path()).expect("canonical temporary repository");
        let (sender, receiver) = mpsc::channel();
        let config = Config::default()
            .with_timeout(WATCH_DEBOUNCE)
            .with_batch_mode(true);
        let mut debouncer = new_debouncer_opt::<_, RecommendedWatcher>(
            config,
            move |result: DebounceEventResult| {
                let _ = sender.send(result);
            },
        )
        .expect("native watcher");
        debouncer
            .watcher()
            .watch(&root, RecursiveMode::Recursive)
            .expect("watch temporary repository");
        let edited = root.join("edited.txt");
        fs::write(&edited, "changed").expect("write watched file");

        let events = receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("working-tree event")
            .expect("valid working-tree event");
        assert!(
            events
                .iter()
                .any(|event| event.path == edited && is_working_tree_path(&root, &event.path)),
            "events: {events:?}"
        );
    }

    #[test]
    fn reconnect_replaces_only_the_named_windows_watcher() {
        let mut registry = RepositoryWatchRegistry::default();
        registry.begin("main", "first");
        assert!(registry.install("main", "first", "old"));
        registry.begin("main", "second");
        assert!(registry.install("main", "second", "new"));
        assert_eq!(
            registry
                .slots
                .get("main")
                .and_then(|slot| slot.active.as_ref())
                .map(|active| active._watch),
            Some("new")
        );
    }

    #[test]
    fn cancellation_race_rejects_a_late_stale_watcher() {
        let mut registry = RepositoryWatchRegistry::default();
        registry.begin("main", "old");
        registry.begin("main", "new");
        assert!(!registry.install("main", "old", "stale"));
        assert!(registry.install("main", "new", "current"));
    }

    #[test]
    fn stale_stop_cannot_remove_the_current_watcher() {
        let mut registry = RepositoryWatchRegistry::default();
        registry.begin("main", "old");
        assert!(registry.install("main", "old", "old-watch"));
        registry.begin("main", "new");
        assert!(registry.install("main", "new", "new-watch"));
        registry.stop("main", "old");
        assert_eq!(
            registry
                .slots
                .get("main")
                .and_then(|slot| slot.active.as_ref())
                .map(|active| active._watch),
            Some("new-watch")
        );
    }
}
