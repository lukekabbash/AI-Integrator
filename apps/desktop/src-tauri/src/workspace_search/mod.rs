//! Two questions: where is this file, and where does this text appear.
//!
//! Both are answered with ripgrep's own crates in-process rather than by
//! shelling out to `rg`: no binary to locate, no process per keystroke, no
//! stdout to parse, and hits arrive as typed values instead of text we have to
//! re-derive. `ignore` also gives us real .gitignore semantics, which the
//! hand-rolled name blocklist in `commands.rs` never had.
//!
//! Nothing here knows about Tauri. The module takes a path, a query and a
//! budget, and returns plain values, so it is testable against a real
//! repository without launching anything.
//!
//! The one invariant worth stating up front: **no cap is silent**. The file
//! lister this replaces stopped at 5,000 entries and said nothing, which is
//! survivable only because this repository is smaller than that. Every result
//! here carries `truncated`, and both searches route their limits through the
//! same `SearchOutcome<T>` so there is exactly one truncation story and no
//! chance of one path claiming completeness the other would not.

mod index;
mod score;
mod walk;

use std::{
    io,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkMatch};
use ignore::overrides::Override;
use integrator_core::{IntegratorError, Result};
use serde::{Deserialize, Serialize};

use index::{IndexCache, IndexedFile};

/// Enough rows to fill a modal several times over. Past this the ranking, not
/// the count, is what the user is relying on.
const DEFAULT_MAX_RESULTS: usize = 200;
/// Matches the file lister's own read ceiling. A file bigger than this is a
/// bundle or a fixture, and a hit inside one is noise.
const DEFAULT_MAX_FILE_BYTES: u64 = 1_000_000;
/// Wall clock a search may spend before it returns what it has, marked.
const DEFAULT_DEADLINE: Duration = Duration::from_millis(2_000);
/// Widest preview a result row keeps. A minified bundle can put a match forty
/// thousand columns in; the row still has to fit.
const MAX_PREVIEW_CHARS: usize = 240;
/// How much of the line before the match a windowed preview keeps.
const PREVIEW_LEAD_CHARS: usize = 40;
/// How often the ranking loop looks at the clock. Scoring is cheap per path but
/// not free at six figures.
const SCORE_DEADLINE_INTERVAL: usize = 8_192;
/// Content search is bound by opening files, not by matching them: this
/// repository is 1,500 files and only 11 MB, and a sequential pass spends about
/// 240 ms of that on `open` alone. Spreading the opens across cores roughly
/// halves it and then flattens — the floor is the filesystem, not us. Capped
/// because this runs on a pool the rest of the app shares.
const MAX_CONTENT_THREADS: usize = 12;

#[derive(Clone, Debug)]
pub struct SearchLimits {
    pub max_results: usize,
    pub max_file_bytes: u64,
    /// Wall-clock budget. A search that runs out returns what it has, marked.
    pub deadline: Duration,
}

impl Default for SearchLimits {
    fn default() -> Self {
        Self {
            max_results: DEFAULT_MAX_RESULTS,
            max_file_bytes: DEFAULT_MAX_FILE_BYTES,
            deadline: DEFAULT_DEADLINE,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathHit {
    /// Repository-relative and forward-slashed, the shape `project_file_read`
    /// and the work pane already take.
    pub path: String,
    pub score: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentHit {
    pub path: String,
    /// 1-based, as an editor counts.
    pub line: u64,
    /// 1-based character column of the match **in the file's line**, which is
    /// not always a column in `text`: a long line is windowed for display and
    /// the column still has to be the one to jump to.
    pub column: u32,
    /// The matching line, trimmed to a bounded width around the match.
    pub text: String,
}

/// Never claims completeness it does not have.
///
/// `truncated` is set when the hit cap was reached or the deadline expired, and
/// also when the underlying walk was itself incomplete. Path search knows
/// exactly how many matches it dropped, so its flag is exact; content search
/// stops asking at the cap and cannot know whether the file it stopped in held
/// one more, so its flag errs toward saying "there may be more".
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutcome<T> {
    pub hits: Vec<T>,
    pub truncated: bool,
    pub scanned: usize,
    pub elapsed_ms: u64,
}

impl<T> SearchOutcome<T> {
    fn new(hits: Vec<T>, truncated: bool, scanned: usize, started: Instant) -> Self {
        Self {
            hits,
            truncated,
            scanned,
            elapsed_ms: started.elapsed().as_millis() as u64,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ContentOptions {
    /// ripgrep-style globs. Empty means every file the walk admitted.
    pub globs: Vec<String>,
    pub case_sensitive: bool,
    /// Treat the pattern as text rather than a regex. The caller decides: a
    /// search box the user types code into wants this on, or `foo(` is a
    /// syntax error instead of a search.
    pub literal: bool,
}

/// Finds files by name across a repository.
pub fn search_paths(
    root: &Path,
    query: &str,
    limits: &SearchLimits,
) -> Result<SearchOutcome<PathHit>> {
    search_paths_in(index::shared(), root, query, limits)
}

/// Finds text inside a repository's files.
pub fn search_contents(
    root: &Path,
    pattern: &str,
    options: &ContentOptions,
    limits: &SearchLimits,
) -> Result<SearchOutcome<ContentHit>> {
    search_contents_in(index::shared(), root, pattern, options, limits)
}

fn search_paths_in(
    cache: &IndexCache,
    root: &Path,
    query: &str,
    limits: &SearchLimits,
) -> Result<SearchOutcome<PathHit>> {
    let started = Instant::now();
    let deadline = started + limits.deadline;
    let query = score::normalize_query(query);
    if query.is_empty() {
        return Ok(SearchOutcome::new(Vec::new(), false, 0, started));
    }
    let lookup = cache.index(root, deadline)?;
    let files = &lookup.index.files;
    let mut ranked: Vec<(i64, usize)> = Vec::new();
    let mut scanned = 0usize;
    let mut timed_out = false;
    for (position, file) in files.iter().enumerate() {
        if position.is_multiple_of(SCORE_DEADLINE_INTERVAL) && Instant::now() >= deadline {
            timed_out = true;
            break;
        }
        scanned += 1;
        if let Some(score) = score::score_path(&file.rel_lower, &query) {
            ranked.push((score, position));
        }
    }
    ranked.sort_by(|left, right| {
        score::compare(
            (left.0, files[left.1].rel.as_str()),
            (right.0, files[right.1].rel.as_str()),
        )
    });
    // Every candidate was scored, so "there were more" is a fact here, not a
    // guess: the flag is set only when a match was actually dropped.
    let capped = ranked.len() > limits.max_results;
    ranked.truncate(limits.max_results);
    let hits = ranked
        .into_iter()
        .map(|(score, position)| PathHit {
            path: files[position].rel.clone(),
            score,
        })
        .collect();
    Ok(SearchOutcome::new(
        hits,
        capped || timed_out || lookup.incomplete(),
        scanned,
        started,
    ))
}

fn search_contents_in(
    cache: &IndexCache,
    root: &Path,
    pattern: &str,
    options: &ContentOptions,
    limits: &SearchLimits,
) -> Result<SearchOutcome<ContentHit>> {
    let started = Instant::now();
    let deadline = started + limits.deadline;
    if pattern.trim().is_empty() {
        return Ok(SearchOutcome::new(Vec::new(), false, 0, started));
    }
    let matcher = build_matcher(pattern, options)?;
    let filter = walk::glob_filter(root, &options.globs)?;
    let lookup = cache.index(root, deadline)?;
    let files = &lookup.index.files;
    let timed_out = AtomicBool::new(false);
    let mut hits: Vec<ContentHit> = Vec::new();
    let mut scanned = 0usize;

    if !files.is_empty() {
        // Contiguous chunks, joined in chunk order, each worker capped at the
        // caller's limit. That is what keeps the parallel answer identical to
        // the sequential one: the first `max_results` rows of the merge come
        // from the earliest paths, because a worker only stops early once it
        // already holds more hits than the whole search will return.
        let workers = std::thread::available_parallelism()
            .map_or(1, |count| count.get())
            .min(MAX_CONTENT_THREADS)
            .min(files.len());
        let chunk = files.len().div_ceil(workers.max(1));
        std::thread::scope(|scope| {
            let handles: Vec<_> = files
                .chunks(chunk.max(1))
                .map(|slice| {
                    let matcher = &matcher;
                    let filter = filter.as_ref();
                    let timed_out = &timed_out;
                    scope.spawn(move || {
                        search_chunk(slice, matcher, filter, limits, deadline, timed_out)
                    })
                })
                .collect();
            for handle in handles {
                // A panicking worker loses its chunk; the rest of the search
                // still answers, and the outcome still reports what it scanned.
                if let Ok(part) = handle.join() {
                    scanned += part.scanned;
                    hits.extend(part.hits);
                }
            }
        });
    }

    // Unlike path search we stopped asking rather than counting: reaching the
    // cap means we cannot claim there was nothing more.
    let capped = hits.len() >= limits.max_results;
    hits.truncate(limits.max_results);
    Ok(SearchOutcome::new(
        hits,
        capped || timed_out.load(Ordering::Relaxed) || lookup.incomplete(),
        scanned,
        started,
    ))
}

struct ChunkResult {
    hits: Vec<ContentHit>,
    scanned: usize,
}

/// One worker's share of the file list, searched in path order.
fn search_chunk(
    files: &[IndexedFile],
    matcher: &RegexMatcher,
    filter: Option<&Override>,
    limits: &SearchLimits,
    deadline: Instant,
    timed_out: &AtomicBool,
) -> ChunkResult {
    let mut searcher = SearcherBuilder::new()
        .line_number(true)
        .multi_line(false)
        // Not the default, despite what the crate's reputation suggests:
        // grep-searcher ships with detection off and ripgrep turns it on. A
        // result row quoting a line out of a `.png` is not a search result.
        .binary_detection(BinaryDetection::quit(0))
        .build();
    let mut result = ChunkResult {
        hits: Vec::new(),
        scanned: 0,
    };
    for file in files {
        if result.hits.len() >= limits.max_results {
            break;
        }
        if Instant::now() >= deadline {
            timed_out.store(true, Ordering::Relaxed);
            break;
        }
        if file.len > limits.max_file_bytes {
            continue;
        }
        if let Some(filter) = filter
            && !walk::glob_allows(filter, &file.abs)
        {
            continue;
        }
        result.scanned += 1;
        let remaining = limits.max_results - result.hits.len();
        let sink = HitSink {
            matcher,
            path: &file.rel,
            hits: &mut result.hits,
            remaining,
        };
        // A file that vanished between the walk and now, or that the OS will
        // not let us read, is one missing result — not a failed search.
        let _ = searcher.search_path(matcher, &file.abs, sink);
    }
    result
}

fn build_matcher(pattern: &str, options: &ContentOptions) -> Result<RegexMatcher> {
    RegexMatcherBuilder::new()
        .case_insensitive(!options.case_sensitive)
        .fixed_strings(options.literal)
        // Multi-line on the *matcher*, not on the searcher: it is what turns
        // `^` and `$` into line anchors instead of anchors on the whole
        // haystack, which is what someone typing `$` into a search box means.
        // The searcher still hands over one line at a time.
        .multi_line(true)
        // And `$` has to land where a Windows checkout puts it, before the
        // `\r\n`. Clearing the line terminator afterwards is the documented way
        // to keep that without declaring a CRLF terminator the searcher would
        // then have to be configured to agree with.
        .crlf(true)
        .line_terminator(None)
        .build(pattern)
        .map_err(|error| IntegratorError::InvalidInput(format!("invalid search pattern: {error}")))
}

/// Collects one file's matching lines, stopping the searcher as soon as the
/// caller's budget is spent rather than reading the rest of the file for
/// results nobody will see.
struct HitSink<'a> {
    matcher: &'a RegexMatcher,
    path: &'a str,
    hits: &'a mut Vec<ContentHit>,
    remaining: usize,
}

impl Sink for HitSink<'_> {
    type Error = io::Error;

    fn matched(
        &mut self,
        _searcher: &Searcher,
        matched: &SinkMatch<'_>,
    ) -> std::result::Result<bool, io::Error> {
        if self.remaining == 0 {
            return Ok(false);
        }
        let line = matched.bytes();
        let offset = self
            .matcher
            .find(line)
            .ok()
            .flatten()
            .map_or(0, |found| found.start());
        let (column, text) = preview(line, offset);
        self.hits.push(ContentHit {
            path: self.path.to_string(),
            line: matched.line_number().unwrap_or(0),
            column,
            text,
        });
        self.remaining -= 1;
        Ok(self.remaining > 0)
    }
}

/// The 1-based column of the match and the line as a result row should show it:
/// no terminator, no trailing whitespace, and never wider than
/// `MAX_PREVIEW_CHARS` — windowed around the match, with ellipses marking what
/// was cut so a trimmed line never reads as the whole line.
fn preview(line: &[u8], match_offset: usize) -> (u32, String) {
    let line = trim_terminator(line);
    let offset = match_offset.min(line.len());
    let column = String::from_utf8_lossy(&line[..offset]).chars().count();
    let text = String::from_utf8_lossy(line);
    let text = text.trim_end();
    let total = text.chars().count();
    if total <= MAX_PREVIEW_CHARS {
        return (column as u32 + 1, text.to_string());
    }
    let start = column
        .saturating_sub(PREVIEW_LEAD_CHARS)
        .min(total - MAX_PREVIEW_CHARS);
    let mut windowed = String::new();
    if start > 0 {
        windowed.push('…');
    }
    windowed.extend(text.chars().skip(start).take(MAX_PREVIEW_CHARS));
    if start + MAX_PREVIEW_CHARS < total {
        windowed.push('…');
    }
    (column as u32 + 1, windowed)
}

fn trim_terminator(line: &[u8]) -> &[u8] {
    let line = line.strip_suffix(b"\n").unwrap_or(line);
    line.strip_suffix(b"\r").unwrap_or(line)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn cache() -> IndexCache {
        IndexCache::new(Duration::from_secs(30))
    }

    fn limits(max_results: usize) -> SearchLimits {
        SearchLimits {
            max_results,
            ..SearchLimits::default()
        }
    }

    fn sample_tree() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        fs::create_dir_all(root.join("src").join("components")).unwrap();
        fs::write(root.join(".gitignore"), "build/\n").unwrap();
        fs::write(
            root.join("src").join("app.tsx"),
            "const focusRegion = 1;\nexport function useApp() {\n  return focusRegion;\n}\n",
        )
        .unwrap();
        fs::write(
            root.join("src").join("components").join("rail.tsx"),
            "import { focusRegion } from \"../app\";\n",
        )
        .unwrap();
        fs::write(root.join("readme.md"), "No matches here.\n").unwrap();
        fs::create_dir_all(root.join("build")).unwrap();
        fs::write(root.join("build").join("bundle.js"), "focusRegion\n").unwrap();
        dir
    }

    #[test]
    fn path_search_ranks_and_ignores_the_ignored() {
        let dir = sample_tree();
        let cache = cache();
        let found = search_paths_in(&cache, dir.path(), "rail", &limits(20)).expect("paths");
        assert_eq!(
            found
                .hits
                .iter()
                .map(|hit| hit.path.as_str())
                .collect::<Vec<_>>(),
            vec!["src/components/rail.tsx"]
        );
        assert!(!found.truncated);
        assert_eq!(found.scanned, 3, "gitignored and hidden files stay out");

        let empty = search_paths_in(&cache, dir.path(), "   ", &limits(20)).expect("empty");
        assert!(empty.hits.is_empty());
        assert!(!empty.truncated);
    }

    #[test]
    fn path_search_is_stable_across_repeated_queries() {
        let dir = tempfile::tempdir().expect("tempdir");
        for index in 0..25 {
            fs::write(dir.path().join(format!("app-{index:02}.tsx")), "x\n").unwrap();
        }
        let cache = cache();
        let first = search_paths_in(&cache, dir.path(), "app", &limits(10)).expect("first");
        let second = search_paths_in(&cache, dir.path(), "app", &limits(10)).expect("second");
        assert_eq!(
            first
                .hits
                .iter()
                .map(|hit| hit.path.clone())
                .collect::<Vec<_>>(),
            second
                .hits
                .iter()
                .map(|hit| hit.path.clone())
                .collect::<Vec<_>>()
        );
        assert_eq!(first.hits[0].path, "app-00.tsx");
    }

    /// The bug this module exists to not repeat: a cap that says nothing.
    #[test]
    fn a_tree_larger_than_the_cap_returns_exactly_the_cap_and_says_so() {
        let dir = tempfile::tempdir().expect("tempdir");
        for index in 0..40 {
            fs::write(dir.path().join(format!("note-{index:02}.txt")), "hay\n").unwrap();
        }
        let cache = cache();
        let paths = search_paths_in(&cache, dir.path(), "note", &limits(7)).expect("paths");
        assert_eq!(paths.hits.len(), 7);
        assert!(paths.truncated);
        assert_eq!(paths.scanned, 40);

        let contents = search_contents_in(
            &cache,
            dir.path(),
            "hay",
            &ContentOptions::default(),
            &limits(7),
        )
        .expect("contents");
        assert_eq!(contents.hits.len(), 7);
        assert!(contents.truncated);
        // Split across workers or not, the cap keeps the earliest paths.
        assert_eq!(
            contents
                .hits
                .iter()
                .map(|hit| hit.path.as_str())
                .collect::<Vec<_>>(),
            (0..7)
                .map(|index| format!("note-{index:02}.txt"))
                .collect::<Vec<_>>()
        );

        let roomy = search_paths_in(&cache, dir.path(), "note", &limits(100)).expect("roomy");
        assert_eq!(roomy.hits.len(), 40);
        assert!(!roomy.truncated);
    }

    #[test]
    fn an_expired_deadline_returns_partial_results_rather_than_an_error() {
        let dir = sample_tree();
        let cache = cache();
        let expired = SearchLimits {
            deadline: Duration::ZERO,
            ..SearchLimits::default()
        };
        let paths = search_paths_in(&cache, dir.path(), "app", &expired).expect("paths");
        assert!(paths.truncated);
        assert!(paths.hits.len() <= expired.max_results);

        let contents = search_contents_in(
            &cache,
            dir.path(),
            "focusRegion",
            &ContentOptions::default(),
            &expired,
        )
        .expect("contents");
        assert!(contents.truncated);
    }

    #[test]
    fn content_search_reports_line_column_and_a_bounded_preview() {
        let dir = sample_tree();
        let cache = cache();
        let found = search_contents_in(
            &cache,
            dir.path(),
            "focusRegion",
            &ContentOptions {
                case_sensitive: true,
                literal: true,
                ..ContentOptions::default()
            },
            &limits(20),
        )
        .expect("contents");
        let rows: Vec<(String, u64, u32)> = found
            .hits
            .iter()
            .map(|hit| (hit.path.clone(), hit.line, hit.column))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("src/app.tsx".to_string(), 1, 7),
                ("src/app.tsx".to_string(), 3, 10),
                ("src/components/rail.tsx".to_string(), 1, 10),
            ]
        );
        assert_eq!(found.hits[0].text, "const focusRegion = 1;");
        assert!(!found.truncated);
        assert_eq!(found.scanned, 3);
    }

    #[test]
    fn content_search_honours_case_globs_and_the_size_ceiling() {
        let dir = sample_tree();
        let cache = cache();
        let insensitive = search_contents_in(
            &cache,
            dir.path(),
            "FOCUSREGION",
            &ContentOptions::default(),
            &limits(20),
        )
        .expect("insensitive");
        assert_eq!(insensitive.hits.len(), 3);

        let sensitive = search_contents_in(
            &cache,
            dir.path(),
            "FOCUSREGION",
            &ContentOptions {
                case_sensitive: true,
                ..ContentOptions::default()
            },
            &limits(20),
        )
        .expect("sensitive");
        assert!(sensitive.hits.is_empty());

        let scoped = search_contents_in(
            &cache,
            dir.path(),
            "focusRegion",
            &ContentOptions {
                globs: vec!["*/components/*".into()],
                ..ContentOptions::default()
            },
            &limits(20),
        )
        .expect("scoped");
        assert_eq!(scoped.hits.len(), 1);
        assert_eq!(scoped.hits[0].path, "src/components/rail.tsx");
        assert_eq!(scoped.scanned, 1);

        let tiny = search_contents_in(
            &cache,
            dir.path(),
            "focusRegion",
            &ContentOptions::default(),
            &SearchLimits {
                max_file_bytes: 4,
                ..SearchLimits::default()
            },
        )
        .expect("tiny");
        assert!(tiny.hits.is_empty());
        assert_eq!(tiny.scanned, 0);
    }

    #[test]
    fn content_search_skips_binaries_and_rejects_a_broken_pattern() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::write(dir.path().join("text.txt"), "needle here\n").unwrap();
        fs::write(dir.path().join("blob.bin"), b"needle\x00 here\n").unwrap();
        let cache = cache();
        let found = search_contents_in(
            &cache,
            dir.path(),
            "needle",
            &ContentOptions::default(),
            &limits(20),
        )
        .expect("contents");
        assert_eq!(
            found
                .hits
                .iter()
                .map(|hit| hit.path.as_str())
                .collect::<Vec<_>>(),
            vec!["text.txt"]
        );

        let broken = search_contents_in(
            &cache,
            dir.path(),
            "focus(",
            &ContentOptions::default(),
            &limits(20),
        );
        assert!(broken.is_err(), "an unbalanced regex is invalid input");
        let literal = search_contents_in(
            &cache,
            dir.path(),
            "focus(",
            &ContentOptions {
                literal: true,
                ..ContentOptions::default()
            },
            &limits(20),
        );
        assert!(literal.is_ok(), "the same text is fine as a literal");
    }

    /// A checkout on this platform is full of CRLF files, and an anchored
    /// pattern that only matches on Unix endings would look like a broken
    /// search rather than a line-terminator subtlety.
    #[test]
    fn an_anchored_pattern_matches_across_crlf_endings() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::write(
            dir.path().join("windows.txt"),
            "const focusRegion\r\nsomething else\r\n",
        )
        .unwrap();
        fs::write(dir.path().join("unix.txt"), "const focusRegion\nelse\n").unwrap();
        let found = search_contents_in(
            &cache(),
            dir.path(),
            "^const focusRegion$",
            &ContentOptions::default(),
            &limits(20),
        )
        .expect("contents");
        assert_eq!(
            found
                .hits
                .iter()
                .map(|hit| (hit.path.as_str(), hit.line, hit.text.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("unix.txt", 1, "const focusRegion"),
                ("windows.txt", 1, "const focusRegion"),
            ]
        );
    }

    #[test]
    fn a_long_line_is_windowed_around_the_match() {
        let line = format!("{}NEEDLE{}", "a".repeat(400), "b".repeat(400));
        let offset = 400;
        let (column, text) = preview(line.as_bytes(), offset);
        assert_eq!(column, 401);
        assert!(text.starts_with('…') && text.ends_with('…'));
        assert!(text.contains("NEEDLE"));
        assert_eq!(text.chars().count(), MAX_PREVIEW_CHARS + 2);

        let short = preview(b"short line\r\n", 6);
        assert_eq!(short, (7, "short line".to_string()));
    }

    /// The repository this crate lives in, or whatever `WORKSPACE_SEARCH_ROOT`
    /// names — the benchmark is worth pointing at a bigger tree than ours.
    fn benchmark_root() -> std::path::PathBuf {
        if let Some(root) = std::env::var_os("WORKSPACE_SEARCH_ROOT") {
            return std::path::PathBuf::from(root);
        }
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .find(|directory| directory.join(".git").exists())
            .expect("repository root")
            .to_path_buf()
    }

    /// Runs against this repository. Ignored by default because it depends on a
    /// working tree that only exists on a developer's machine; run it with
    /// `cargo test -p ai-integrator-desktop workspace_search -- --ignored
    /// --nocapture`.
    #[test]
    #[ignore]
    fn benchmark_against_this_repository() {
        let root = benchmark_root();
        // Deliberately not the default deadline: this measures how long the
        // work takes, not how quickly the budget runs out.
        let limits = SearchLimits {
            deadline: Duration::from_secs(30),
            ..SearchLimits::default()
        };
        let options = ContentOptions {
            literal: true,
            ..ContentOptions::default()
        };

        let paths_cache = IndexCache::new(Duration::from_secs(60));
        let cold_paths = search_paths_in(&paths_cache, &root, "rightrail", &limits).expect("cold");
        let warm_paths = search_paths_in(&paths_cache, &root, "rightrail", &limits).expect("warm");

        let contents_cache = IndexCache::new(Duration::from_secs(60));
        let cold_contents =
            search_contents_in(&contents_cache, &root, "focusRegion", &options, &limits)
                .expect("cold contents");
        let warm_contents =
            search_contents_in(&contents_cache, &root, "focusRegion", &options, &limits)
                .expect("warm contents");

        eprintln!("root={}", root.display());
        eprintln!(
            "paths   cold={}ms warm={}ms hits={} scanned={} truncated={}",
            cold_paths.elapsed_ms,
            warm_paths.elapsed_ms,
            cold_paths.hits.len(),
            cold_paths.scanned,
            cold_paths.truncated
        );
        eprintln!(
            "content cold={}ms warm={}ms hits={} scanned={} truncated={}/{}",
            cold_contents.elapsed_ms,
            warm_contents.elapsed_ms,
            cold_contents.hits.len(),
            cold_contents.scanned,
            cold_contents.truncated,
            warm_contents.truncated
        );
        for hit in cold_paths.hits.iter().take(3) {
            eprintln!("  path {} score={}", hit.path, hit.score);
        }
        for hit in cold_contents.hits.iter().take(3) {
            eprintln!("  {}:{}:{} {}", hit.path, hit.line, hit.column, hit.text);
        }
        assert_eq!(cold_paths.scanned, warm_paths.scanned);
        assert_eq!(cold_contents.hits.len(), warm_contents.hits.len());
    }
}
