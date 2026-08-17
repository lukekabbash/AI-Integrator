//! The warm cache: one walk answers a whole burst of keystrokes.
//!
//! Mirrors `usage_history`'s `ScanCache` — a `(mtime, len)` fingerprint per
//! file, behind a mutex, keyed by root — with one difference that follows from
//! what is expensive here. There, the file list was cheap and parsing was dear,
//! so the cache remembered parsed records. Here the walk itself is the cost:
//! gitignore matching over every directory entry in a repository. So the cache
//! remembers the walk, and the fingerprints exist to answer a narrower
//! question — did anything actually change — without opening a single file.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant, SystemTime},
};

use integrator_core::Result;

use super::walk::{self, WalkBudget, WalkCounters, WalkLimit, WalkedFile};

/// How long a walk is trusted without re-checking the disk. Long enough that a
/// burst of typing shares one walk; short enough that a file created a moment
/// ago turns up while the user is still looking for it. A watcher already
/// exists in `repository_watch`, so this is the floor, not the ceiling, of how
/// fresh the index can be made later.
const FRESH_FOR: Duration = Duration::from_secs(5);

/// Ceiling on indexed files. Not a size the app expects to meet — this
/// repository is about 1,500 files — but the point of this module is that no
/// bound stays silent, and an unbounded walk of an accidental root (a home
/// directory, a mounted drive) has to stop somewhere.
const MAX_INDEXED_FILES: usize = 200_000;

#[derive(Clone, Debug)]
pub(crate) struct IndexedFile {
    pub rel: String,
    /// `rel`, lowercased once at index time. Scoring runs over every file on
    /// every keystroke; lowercasing there would allocate a string per file per
    /// frame to throw it away again.
    pub rel_lower: String,
    pub abs: PathBuf,
    pub len: u64,
    pub modified: Option<SystemTime>,
}

impl From<WalkedFile> for IndexedFile {
    fn from(file: WalkedFile) -> Self {
        Self {
            rel_lower: file.rel.to_lowercase(),
            rel: file.rel,
            abs: file.abs,
            len: file.len,
            modified: file.modified,
        }
    }
}

#[derive(Debug)]
pub(crate) struct RepoIndex {
    pub files: Arc<[IndexedFile]>,
    /// The walk stopped at the file cap, so every search over this index is
    /// answering from a partial tree and has to say so.
    pub capped: bool,
}

/// What one lookup got, and whether it is allowed to claim completeness.
pub(crate) struct IndexLookup {
    pub index: Arc<RepoIndex>,
    /// This lookup's own walk ran out of the caller's wall-clock budget.
    timed_out: bool,
}

impl IndexLookup {
    /// True when the index cannot support the claim "that is everything".
    pub(crate) fn incomplete(&self) -> bool {
        self.timed_out || self.index.capped
    }
}

#[derive(Debug)]
struct Cached {
    index: Arc<RepoIndex>,
    built_at: Instant,
}

#[derive(Debug)]
pub(crate) struct IndexCache {
    entries: Mutex<HashMap<PathBuf, Cached>>,
    fresh_for: Duration,
    counters: WalkCounters,
}

/// The process-wide cache the public search functions use.
pub(crate) fn shared() -> &'static IndexCache {
    static CACHE: OnceLock<IndexCache> = OnceLock::new();
    CACHE.get_or_init(|| IndexCache::new(FRESH_FOR))
}

impl IndexCache {
    pub(crate) fn new(fresh_for: Duration) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            fresh_for,
            counters: WalkCounters::default(),
        }
    }

    /// The file list for `root`, walking only if what we remember has aged out.
    pub(crate) fn index(&self, root: &Path, deadline: Instant) -> Result<IndexLookup> {
        // One root spelled two ways is one repository; canonicalizing keeps it
        // one cache entry. `dunce` because the verbatim `\\?\` form std hands
        // back on Windows would show up in every path we then derive.
        let key = dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        let remembered = self.remembered(&key);
        if let Some(cached) = &remembered
            && cached.built_at.elapsed() < self.fresh_for
        {
            return Ok(IndexLookup {
                index: Arc::clone(&cached.index),
                timed_out: false,
            });
        }
        let tree = walk::walk_files(
            &key,
            WalkBudget {
                max_files: MAX_INDEXED_FILES,
                deadline,
            },
            &self.counters,
        )?;
        let timed_out = tree.limit == Some(WalkLimit::Deadline);
        let files: Vec<IndexedFile> = tree.files.into_iter().map(IndexedFile::from).collect();
        // Nothing moved on disk: hand back the previous allocation rather than
        // a fresh copy of the same list. That keeps the index's identity stable
        // across refreshes, which is what any later per-file memo will key on.
        let files = match remembered {
            Some(cached) if same_files(&cached.index.files, &files) => {
                Arc::clone(&cached.index.files)
            }
            _ => files.into(),
        };
        let index = Arc::new(RepoIndex {
            files,
            capped: tree.limit == Some(WalkLimit::Cap),
        });
        if !timed_out {
            self.store(key, Arc::clone(&index));
        }
        Ok(IndexLookup { index, timed_out })
    }

    fn remembered(&self, key: &Path) -> Option<Cached> {
        self.lock().get(key).map(|cached| Cached {
            index: Arc::clone(&cached.index),
            built_at: cached.built_at,
        })
    }

    fn store(&self, key: PathBuf, index: Arc<RepoIndex>) {
        self.lock().insert(
            key,
            Cached {
                index,
                built_at: Instant::now(),
            },
        );
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<PathBuf, Cached>> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[cfg(test)]
    pub(crate) fn stat_calls(&self) -> usize {
        self.counters.stats()
    }
}

/// Whether two walks of the same root saw the same files unchanged. Both lists
/// arrive sorted by `rel`, so this is a single pass over the fingerprints — no
/// file is opened and nothing is re-stat'd.
fn same_files(previous: &[IndexedFile], next: &[IndexedFile]) -> bool {
    previous.len() == next.len()
        && previous.iter().zip(next).all(|(before, after)| {
            before.rel == after.rel && before.len == after.len && before.modified == after.modified
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn deadline() -> Instant {
        Instant::now() + Duration::from_secs(30)
    }

    fn tree_of(count: usize) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        for index in 0..count {
            fs::write(dir.path().join(format!("file-{index:03}.txt")), "body\n").unwrap();
        }
        dir
    }

    /// The claim is "a repeat search does no filesystem work", and the counter
    /// says so exactly. A timing assertion for the same thing flakes.
    #[test]
    fn a_warm_lookup_does_not_restat_the_tree() {
        let dir = tree_of(12);
        let cache = IndexCache::new(Duration::from_secs(30));
        let cold = cache.index(dir.path(), deadline()).expect("cold");
        assert_eq!(cold.index.files.len(), 12);
        let after_cold = cache.stat_calls();
        assert_eq!(after_cold, 12);

        let warm = cache.index(dir.path(), deadline()).expect("warm");
        assert_eq!(
            cache.stat_calls(),
            after_cold,
            "warm lookup re-stat'd files"
        );
        assert!(Arc::ptr_eq(&cold.index, &warm.index));
        assert!(!warm.incomplete());
    }

    /// Past the freshness window the walk runs again — but an unchanged tree
    /// keeps the same file list, which is the whole point of the fingerprint.
    #[test]
    fn an_aged_index_rewalks_but_keeps_an_unchanged_file_list() {
        let dir = tree_of(6);
        let cache = IndexCache::new(Duration::from_millis(0));
        let first = cache.index(dir.path(), deadline()).expect("first");
        let before = cache.stat_calls();
        let second = cache.index(dir.path(), deadline()).expect("second");
        assert!(cache.stat_calls() > before, "aged index must rewalk");
        assert!(Arc::ptr_eq(&first.index.files, &second.index.files));

        fs::write(dir.path().join("file-000.txt"), "changed body\n").unwrap();
        let third = cache.index(dir.path(), deadline()).expect("third");
        assert!(!Arc::ptr_eq(&second.index.files, &third.index.files));
        assert_eq!(third.index.files.len(), 6);
    }

    /// A caller with no time left must not leave its partial view behind for
    /// the next caller to inherit.
    #[test]
    fn a_deadline_truncated_walk_is_never_remembered() {
        let dir = tree_of(30);
        let cache = IndexCache::new(Duration::from_secs(30));
        let expired = cache.index(dir.path(), Instant::now()).expect("expired");
        assert!(expired.incomplete());
        let full = cache.index(dir.path(), deadline()).expect("full");
        assert_eq!(full.index.files.len(), 30);
        assert!(!full.incomplete());
    }

    #[test]
    fn a_missing_root_is_an_error_not_an_empty_index() {
        let cache = IndexCache::new(Duration::from_secs(30));
        let missing = std::env::temp_dir().join("integrator-search-does-not-exist");
        assert!(cache.index(&missing, deadline()).is_err());
    }
}
