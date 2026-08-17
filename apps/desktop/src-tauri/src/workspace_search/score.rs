//! Path ranking. Cheap, tiered, and above all stable.
//!
//! Deterministic ordering matters more here than perfect relevance: the list
//! redraws on every keystroke, and a row that jumps out from under the cursor
//! between two frames costs the user more than a slightly misplaced hit. So the
//! score is a small set of tiers rather than a tuned weighting, and everything
//! inside a tier is settled by the path itself — shorter first, then
//! alphabetical — never by walk order or thread timing.
//!
//! Pure: no filesystem, no clock, no allocation.

use std::cmp::Ordering;

/// Exact basename. "the file you named".
const EXACT_BASENAME: i64 = 500;
/// Basename starts with the query. "the file you are still typing".
const BASENAME_PREFIX: i64 = 400;
/// Basename contains the query anywhere.
const BASENAME_SUBSTRING: i64 = 300;
/// The query appears in the path but not the basename — usually a directory.
const PATH_SUBSTRING: i64 = 200;
/// The query's characters appear in the basename in order. The fuzzy tier, and
/// the widest: it is last so it never outranks a literal match.
const BASENAME_SUBSEQUENCE: i64 = 100;

/// Folds a raw query into the form `score_path` compares against: lowercase, so
/// matching is case-insensitive the way every file finder is, and
/// forward-slashed, so a pasted Windows path still matches an indexed one.
pub(crate) fn normalize_query(query: &str) -> String {
    query.trim().to_lowercase().replace('\\', "/")
}

/// Scores one already-lowercased repository-relative path, or `None` when the
/// query does not match it at all.
pub(crate) fn score_path(path_lower: &str, query_lower: &str) -> Option<i64> {
    if query_lower.is_empty() {
        return None;
    }
    let basename = path_lower.rsplit('/').next().unwrap_or(path_lower);
    if basename == query_lower {
        return Some(EXACT_BASENAME);
    }
    if basename.starts_with(query_lower) {
        return Some(BASENAME_PREFIX);
    }
    if basename.contains(query_lower) {
        return Some(BASENAME_SUBSTRING);
    }
    if path_lower.contains(query_lower) {
        return Some(PATH_SUBSTRING);
    }
    // A query carrying a separator is a path fragment, not an abbreviation;
    // letting it match a basename subsequence turns "src/app" into noise.
    if !query_lower.contains('/') && is_subsequence(basename, query_lower) {
        return Some(BASENAME_SUBSEQUENCE);
    }
    None
}

/// Higher score first, then the shorter path, then alphabetical. The last two
/// are what make the order total: two paths can only tie on all three if they
/// are the same path, and the index holds each path once.
pub(crate) fn compare(left: (i64, &str), right: (i64, &str)) -> Ordering {
    right
        .0
        .cmp(&left.0)
        .then_with(|| left.1.len().cmp(&right.1.len()))
        .then_with(|| left.1.cmp(right.1))
}

/// Whether every character of `needle` appears in `haystack` in order.
fn is_subsequence(haystack: &str, needle: &str) -> bool {
    let mut chars = haystack.chars();
    needle
        .chars()
        .all(|wanted| chars.any(|candidate| candidate == wanted))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiers_rank_in_the_documented_order() {
        let table = [
            ("src/app.tsx", "app.tsx", Some(EXACT_BASENAME)),
            ("src/app.tsx", "app", Some(BASENAME_PREFIX)),
            ("src/my-app.tsx", "app", Some(BASENAME_SUBSTRING)),
            ("src/app/index.ts", "app/ind", Some(PATH_SUBSTRING)),
            ("src/widgets/index.ts", "app", None),
            (
                "src/spatialnavigation.ts",
                "sptnav",
                Some(BASENAME_SUBSEQUENCE),
            ),
            ("src/spatialnavigation.ts", "navspt", None),
            ("src/app.tsx", "", None),
        ];
        for (path, query, expected) in table {
            assert_eq!(
                score_path(path, &normalize_query(query)),
                expected,
                "{path} vs {query}"
            );
        }
    }

    #[test]
    fn query_normalization_is_case_and_separator_insensitive() {
        assert_eq!(normalize_query("  Src\\App.TSX "), "src/app.tsx");
        assert_eq!(
            score_path("src/app.tsx", &normalize_query("Src\\App")),
            Some(PATH_SUBSTRING)
        );
    }

    /// The one property the UI depends on: two paths never compare equal, so
    /// the same query always produces the same list in the same order.
    #[test]
    fn ties_break_on_length_then_alphabetically() {
        let mut hits = [
            (BASENAME_PREFIX, "z/app.tsx"),
            (BASENAME_PREFIX, "a/app.tsx"),
            (BASENAME_PREFIX, "deep/nested/app.tsx"),
            (EXACT_BASENAME, "very/deeply/nested/app.tsx"),
            (BASENAME_SUBSEQUENCE, "a.tsx"),
        ];
        hits.sort_by(|left, right| compare(*left, *right));
        assert_eq!(
            hits.iter().map(|hit| hit.1).collect::<Vec<_>>(),
            vec![
                "very/deeply/nested/app.tsx",
                "a/app.tsx",
                "z/app.tsx",
                "deep/nested/app.tsx",
                "a.tsx",
            ]
        );
        assert_eq!(
            compare(
                (BASENAME_PREFIX, "a/app.tsx"),
                (BASENAME_PREFIX, "a/app.tsx")
            ),
            Ordering::Equal
        );
    }

    #[test]
    fn subsequence_needs_every_character_in_order() {
        assert!(is_subsequence("workspace_search", "wsearch"));
        assert!(is_subsequence("abc", "abc"));
        assert!(!is_subsequence("abc", "abcd"));
        assert!(!is_subsequence("abc", "cb"));
        assert!(is_subsequence("abc", ""));
    }
}
