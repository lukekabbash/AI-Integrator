//! The one place that decides what a repository walk can see.
//!
//! Every traversal in this module goes through `walk_files`, so the policy —
//! real `.gitignore` semantics, hidden files, symlinks, secrets, the file cap
//! and the wall-clock budget — is decided here and nowhere else. The file
//! lister this module replaces spread its policy across a hand-maintained
//! blocklist of directory names inside its own recursion, which is how a repo
//! with an unusual build directory got walked and a repo with a tracked `dist`
//! got skipped. One function, one policy, one place to be wrong.

use std::{
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Instant, SystemTime},
};

use ignore::{
    WalkBuilder, WalkState,
    overrides::{Override, OverrideBuilder},
};
use integrator_core::{IntegratorError, Result};

/// `Instant::now()` is a real clock read per call; asking on every dirent shows
/// up once a tree runs to six figures. Once per this many entries keeps the
/// deadline honest to well under a millisecond of overwalk.
const DEADLINE_CHECK_INTERVAL: usize = 128;

/// A walk is I/O bound long before it is CPU bound, and this runs on a blocking
/// pool shared with the rest of the app. More threads than this buys nothing
/// and costs the app responsiveness while the user is still typing.
const MAX_WALK_THREADS: usize = 12;

/// What a walk touched. The cache test asserts a warm search does no `stat`
/// work; a timing assertion for the same claim flakes, a counter does not.
#[derive(Debug, Default)]
pub(crate) struct WalkCounters {
    stats: AtomicUsize,
}

impl WalkCounters {
    #[cfg(test)]
    pub(crate) fn stats(&self) -> usize {
        self.stats.load(Ordering::Relaxed)
    }
}

/// Why a walk stopped before the tree ran out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WalkLimit {
    /// Hit `max_files`. The bound is stable even though the exact set of files
    /// under it is not, so a capped tree is still worth remembering: rewalking
    /// a six-figure repository on every keystroke is the worse failure.
    Cap,
    /// Ran out of wall clock. Which files were seen depends on how the threads
    /// happened to be scheduled, so a tree walked this way is never cached —
    /// one caller's tight deadline must not poison the next caller's search.
    Deadline,
}

#[derive(Clone, Debug)]
pub(crate) struct WalkedFile {
    /// Repository-relative, forward-slashed, which is the shape the renderer
    /// and `project_file_read` already speak.
    pub rel: String,
    pub abs: PathBuf,
    pub len: u64,
    pub modified: Option<SystemTime>,
}

#[derive(Debug)]
pub(crate) struct WalkedTree {
    /// Sorted by `rel`. A parallel walk finishes in whatever order the threads
    /// land, and a result list that reshuffles between keystrokes is worse than
    /// a slightly wrong one that holds still.
    pub files: Vec<WalkedFile>,
    pub limit: Option<WalkLimit>,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct WalkBudget {
    pub max_files: usize,
    pub deadline: Instant,
}

/// Every ordinary file under `root` that the policy above admits.
pub(crate) fn walk_files(
    root: &Path,
    budget: WalkBudget,
    counters: &WalkCounters,
) -> Result<WalkedTree> {
    if !root.is_dir() {
        return Err(IntegratorError::NotFound(format!(
            "{} is not a directory",
            root.display()
        )));
    }
    let files = Mutex::new(Vec::new());
    let capped = AtomicBool::new(false);
    let timed_out = AtomicBool::new(false);

    builder(root).build_parallel().run(|| {
        let files = &files;
        let capped = &capped;
        let timed_out = &timed_out;
        // Per worker, not shared: the count only paces the clock reads, and a
        // shared counter would let one thread's arithmetic decide when another
        // thread notices it is out of time.
        let mut seen = 0usize;
        Box::new(move |entry| {
            let checkpoint = seen.is_multiple_of(DEADLINE_CHECK_INTERVAL);
            seen += 1;
            if checkpoint && Instant::now() >= budget.deadline {
                timed_out.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }
            // An unreadable directory is a fact about the machine, not a reason
            // to fail the whole search.
            let Ok(entry) = entry else {
                return WalkState::Continue;
            };
            let Some(file_type) = entry.file_type() else {
                return WalkState::Continue;
            };
            if file_type.is_symlink() {
                // Not followed and not reported: a link can point outside the
                // repository the caller was authorized for, and a loop of them
                // never terminates.
                return WalkState::Skip;
            }
            if !file_type.is_file() {
                return WalkState::Continue;
            }
            let Some(rel) = relative_path(root, entry.path()) else {
                return WalkState::Continue;
            };
            if is_sensitive(&rel) {
                return WalkState::Continue;
            }
            counters.stats.fetch_add(1, Ordering::Relaxed);
            let metadata = entry.metadata().ok();
            let len = metadata.as_ref().map_or(0, |data| data.len());
            let modified = metadata.and_then(|data| data.modified().ok());
            let mut guard = files
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.push(WalkedFile {
                rel,
                abs: entry.into_path(),
                len,
                modified,
            });
            if guard.len() >= budget.max_files {
                capped.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }
            WalkState::Continue
        })
    });

    let mut files = files
        .into_inner()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    files.sort_by(|left, right| left.rel.cmp(&right.rel));
    let limit = if timed_out.load(Ordering::Relaxed) {
        Some(WalkLimit::Deadline)
    } else if capped.load(Ordering::Relaxed) {
        Some(WalkLimit::Cap)
    } else {
        None
    };
    Ok(WalkedTree { files, limit })
}

/// The traversal policy itself.
fn builder(root: &Path) -> WalkBuilder {
    let threads = std::thread::available_parallelism()
        .map_or(1, |count| count.get())
        .min(MAX_WALK_THREADS);
    let mut builder = WalkBuilder::new(root);
    builder
        // Hidden files stay out, the way ripgrep's default does: `.git` alone
        // is more entries than the rest of a repository put together.
        .hidden(true)
        .parents(true)
        .ignore(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        // A project directory that is not itself a git repository still keeps
        // its `.gitignore` honoured; the default would quietly ignore the file.
        .require_git(false)
        .follow_links(false)
        .threads(threads);
    builder
}

/// Compiles the caller's globs into a filter over paths the walk already
/// admitted. The globs cannot go on the walk itself: one index is shared by
/// every query against a repository, and a glob from one content search must
/// not decide what a later path search can find.
pub(crate) fn glob_filter(root: &Path, globs: &[String]) -> Result<Option<Override>> {
    let mut builder = OverrideBuilder::new(root);
    let mut added = false;
    for glob in globs {
        let glob = glob.trim();
        if glob.is_empty() {
            continue;
        }
        builder.add(glob).map_err(|error| {
            IntegratorError::InvalidInput(format!("invalid glob {glob:?}: {error}"))
        })?;
        added = true;
    }
    if !added {
        return Ok(None);
    }
    builder
        .build()
        .map(Some)
        .map_err(|error| IntegratorError::InvalidInput(format!("invalid glob set: {error}")))
}

pub(crate) fn glob_allows(filter: &Override, path: &Path) -> bool {
    !filter.matched(path, false).is_ignore()
}

/// Drops paths that are not valid UTF-8. The renderer boundary is UTF-8 either
/// way, so a lossy name would name a file nothing could then open.
fn relative_path(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    Some(relative.to_str()?.replace('\\', "/"))
}

/// Files `project_file_list` and `project_file_read` already refuse to hand to
/// the renderer. Search would otherwise be a way around that refusal — worse
/// than the file lister, because content search would print the secret itself
/// into a result row. The rule is duplicated rather than imported on purpose:
/// this module may not depend on the commands facade, and "what a walk is
/// allowed to see" is this file's job anyway.
fn is_sensitive(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel).to_ascii_lowercase();
    let protected_env = name == ".env"
        || (name.starts_with(".env.")
            && !name.ends_with(".example")
            && !name.ends_with(".sample")
            && !name.ends_with(".template"));
    protected_env
        || name.ends_with(".pem")
        || name.ends_with(".p12")
        || name.ends_with(".pfx")
        || name.ends_with(".key")
        || matches!(
            name.as_str(),
            "id_rsa" | "id_ed25519" | "credentials.json" | "service-account.json"
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, time::Duration};

    fn budget() -> WalkBudget {
        WalkBudget {
            max_files: 10_000,
            deadline: Instant::now() + Duration::from_secs(30),
        }
    }

    fn names(tree: &WalkedTree) -> Vec<String> {
        tree.files.iter().map(|file| file.rel.clone()).collect()
    }

    #[test]
    fn walk_honours_nested_ignores_hidden_directories_and_secrets() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        fs::write(root.join(".gitignore"), "ignored/\n*.log\n").unwrap();
        fs::write(root.join("keep.rs"), "fn main() {}\n").unwrap();
        fs::write(root.join("notes.log"), "noise\n").unwrap();
        fs::write(root.join(".env"), "TOKEN=shh\n").unwrap();
        fs::write(root.join("server.pem"), "-----BEGIN-----\n").unwrap();
        fs::create_dir_all(root.join("ignored")).unwrap();
        fs::write(root.join("ignored").join("secret.rs"), "nope\n").unwrap();
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("nested").join(".gitignore"), "skip.txt\n").unwrap();
        fs::write(root.join("nested").join("keep.txt"), "yes\n").unwrap();
        fs::write(root.join("nested").join("skip.txt"), "no\n").unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        fs::write(root.join(".hidden").join("inside.rs"), "hidden\n").unwrap();

        let counters = WalkCounters::default();
        let tree = walk_files(root, budget(), &counters).expect("walk");
        assert_eq!(names(&tree), vec!["keep.rs", "nested/keep.txt"]);
        assert_eq!(tree.limit, None);
        // One metadata call per admitted file, and none for what was filtered.
        assert_eq!(counters.stats(), 2);
        assert!(tree.files.iter().all(|file| file.len > 0));
    }

    /// Windows only creates symlinks for a privileged or developer-mode
    /// process, so this asserts the policy when it can and stays quiet when the
    /// machine will not let us build the fixture.
    #[test]
    fn walk_never_follows_a_symlink_loop() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        fs::write(root.join("keep.rs"), "fn main() {}\n").unwrap();
        fs::create_dir_all(root.join("real")).unwrap();
        fs::write(root.join("real").join("inner.rs"), "inner\n").unwrap();
        #[cfg(windows)]
        let linked =
            std::os::windows::fs::symlink_dir(root, root.join("real").join("loop")).is_ok();
        #[cfg(not(windows))]
        let linked = std::os::unix::fs::symlink(root, root.join("real").join("loop")).is_ok();
        if !linked {
            return;
        }
        let counters = WalkCounters::default();
        let tree = walk_files(root, budget(), &counters).expect("walk");
        assert_eq!(names(&tree), vec!["keep.rs", "real/inner.rs"]);
    }

    #[test]
    fn walk_marks_the_file_cap_and_the_deadline() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        for index in 0..40 {
            fs::write(root.join(format!("file-{index:03}.txt")), "x\n").unwrap();
        }
        let counters = WalkCounters::default();
        let capped = walk_files(
            root,
            WalkBudget {
                max_files: 5,
                deadline: Instant::now() + Duration::from_secs(30),
            },
            &counters,
        )
        .expect("walk");
        assert_eq!(capped.limit, Some(WalkLimit::Cap));
        assert!(capped.files.len() >= 5);

        let expired = walk_files(
            root,
            WalkBudget {
                max_files: 10_000,
                deadline: Instant::now(),
            },
            &counters,
        )
        .expect("walk");
        assert_eq!(expired.limit, Some(WalkLimit::Deadline));
    }

    #[test]
    fn walk_rejects_a_root_that_is_not_a_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("plain.txt");
        fs::write(&file, "x").unwrap();
        let counters = WalkCounters::default();
        assert!(walk_files(&file, budget(), &counters).is_err());
    }

    #[test]
    fn globs_filter_paths_and_reject_nonsense() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let filter = glob_filter(root, &["*.rs".into(), "  ".into()])
            .expect("filter")
            .expect("some filter");
        assert!(glob_allows(&filter, &root.join("main.rs")));
        assert!(!glob_allows(&filter, &root.join("main.ts")));
        assert!(glob_filter(root, &[]).expect("no globs").is_none());
        assert!(glob_filter(root, &["[".into()]).is_err());
    }

    #[test]
    fn sensitivity_rule_matches_the_file_lister() {
        assert!(is_sensitive(".env"));
        assert!(is_sensitive("config/.env.production"));
        assert!(is_sensitive("certs/server.PEM"));
        assert!(is_sensitive("keys/id_ed25519"));
        assert!(!is_sensitive(".env.example"));
        assert!(!is_sensitive("src/env.rs"));
    }
}
