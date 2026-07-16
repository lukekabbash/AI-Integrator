//! Bounded, read-only context gathering for the selection explainer.
//!
//! The explainer runs tool-denied, so everything the model is allowed to see
//! has to be assembled here and injected into the prompt. Two kinds of context
//! exist, both scaled by the verbosity slider so a one-paragraph answer never
//! pays for a repository read:
//!
//! * the window of the open buffer surrounding the selection, and
//! * heavily truncated excerpts of files the selection actually references.
//!
//! Import resolution is deliberately heuristic. A specifier that does not
//! resolve is skipped rather than guessed at, and a name that resolves to
//! nothing costs context rather than correctness — the explanation still runs,
//! just with less to look at. Every resolved path is re-checked against the
//! canonical project root before it is opened, so a crafted import cannot walk
//! out of the repository.

use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

/// Import statements live at the top of a file in every language handled here,
/// so the scan stops well before the end of a large module.
const HEAD_LINES: usize = 400;
/// Referenced files are read whole before excerpting; this keeps a generated
/// or vendored bundle from being pulled into memory.
const MAX_REFERENCED_FILE_BYTES: u64 = 512 * 1024;
/// Doc comments and attributes sit above a definition; the signature and the
/// first few lines of body sit below. The asymmetry favours the body.
const REFERENCED_LINES_ABOVE: usize = 4;
const REFERENCED_LINES_BELOW: usize = 12;

/// How much context one explanation may gather, derived from the verbosity
/// slider. The bands are deliberately coarse: the slider is a preference, not a
/// line count, and a user moving it from 61 to 62 should not change the answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContextBudget {
    /// Lines of the open buffer to include above and below the selection.
    pub surrounding_lines: usize,
    /// Maximum number of distinct referenced files to excerpt.
    pub referenced_files: usize,
    /// Total character cap across every referenced excerpt combined.
    pub referenced_chars: usize,
}

impl ContextBudget {
    pub fn for_verbosity(verbosity: u8) -> Self {
        match verbosity.min(100) {
            0..=29 => Self {
                surrounding_lines: 0,
                referenced_files: 0,
                referenced_chars: 0,
            },
            30..=59 => Self {
                surrounding_lines: 24,
                referenced_files: 0,
                referenced_chars: 0,
            },
            60..=79 => Self {
                surrounding_lines: 60,
                referenced_files: 3,
                referenced_chars: 2_400,
            },
            _ => Self {
                surrounding_lines: 120,
                referenced_files: 6,
                referenced_chars: 6_000,
            },
        }
    }

    pub fn reads_referenced_files(&self) -> bool {
        self.referenced_files > 0 && self.referenced_chars > 0
    }
}

/// One contiguous excerpt of a file, addressed the way it will be rendered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Excerpt {
    /// Project-relative path, as it appears in the prompt.
    pub path: String,
    /// 1-based line number of the first line of `text`.
    pub start_line: usize,
    pub text: String,
}

impl Excerpt {
    pub fn end_line(&self) -> usize {
        self.start_line + self.text.lines().count().saturating_sub(1)
    }
}

/// Everything the explainer may show the model besides the selection itself.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SelectionContext {
    pub surrounding: Option<Excerpt>,
    pub referenced: Vec<Excerpt>,
}

/// Assemble the context for one selection. `file_text` is the live editor
/// buffer rather than the file on disk: the file view is editable, so reading
/// the selection's own file back from disk would explain a stale version
/// whenever the user has unsaved edits. Referenced files are not open, so those
/// are read from disk.
pub fn gather(
    root: &Path,
    path: &str,
    file_text: &str,
    start_line: Option<u32>,
    end_line: Option<u32>,
    selection: &str,
    budget: ContextBudget,
) -> SelectionContext {
    let surrounding = surrounding_window(path, file_text, start_line, end_line, budget);
    let referenced = if budget.reads_referenced_files() {
        referenced_excerpts(root, path, file_text, selection, budget)
    } else {
        Vec::new()
    };
    SelectionContext {
        surrounding,
        referenced,
    }
}

/// The window of the open buffer around the selection. Returns `None` when the
/// window would add nothing the selection does not already show.
///
/// The scan stops at the last wanted line rather than collecting the buffer, so
/// the cost tracks the window rather than the size of the open file.
fn surrounding_window(
    path: &str,
    file_text: &str,
    start_line: Option<u32>,
    end_line: Option<u32>,
    budget: ContextBudget,
) -> Option<Excerpt> {
    if budget.surrounding_lines == 0 {
        return None;
    }
    let start = start_line? as usize;
    if start == 0 {
        return None;
    }
    let end = end_line.map_or(start, |line| line as usize).max(start);
    let first = start.saturating_sub(budget.surrounding_lines).max(1);
    let last = end.saturating_add(budget.surrounding_lines);

    let mut window = Vec::new();
    for (index, line) in file_text.lines().enumerate() {
        let number = index + 1;
        if number < first {
            continue;
        }
        if number > last {
            break;
        }
        window.push(line);
    }
    if window.is_empty() {
        return None;
    }
    // A buffer shorter than the window simply yields fewer lines, so the real
    // end comes from what was collected rather than from the requested bound.
    let collected_last = first + window.len() - 1;
    if first >= start && collected_last <= end {
        return None;
    }
    Some(Excerpt {
        path: path.to_owned(),
        start_line: first,
        text: window.join("\n"),
    })
}

/// Excerpt the definitions that the selection actually names, from the files
/// the current file imports. Everything is best-effort: unresolvable imports,
/// unreadable files, and names with no visible definition are skipped.
fn referenced_excerpts(
    root: &Path,
    path: &str,
    file_text: &str,
    selection: &str,
    budget: ContextBudget,
) -> Vec<Excerpt> {
    let Some(language) = language_of(path) else {
        return Vec::new();
    };
    let Ok(root) = root.canonicalize() else {
        return Vec::new();
    };
    let current = root.join(path);
    let wanted = identifiers(selection);
    if wanted.is_empty() {
        return Vec::new();
    }

    let head: String = file_text
        .lines()
        .take(HEAD_LINES)
        .collect::<Vec<_>>()
        .join("\n");

    // One file can be imported by several statements; merge the names each
    // contributes so a file is read once and counts once against the budget.
    let mut targets: Vec<(PathBuf, HashSet<String>)> = Vec::new();
    let mut seen: HashMap<PathBuf, usize> = HashMap::new();
    for import in imports(language, &head) {
        let relevant: HashSet<String> = import
            .names
            .iter()
            .filter(|name| wanted.contains(name.as_str()))
            .cloned()
            .collect();
        if relevant.is_empty() {
            continue;
        }
        let Some(resolved) = resolve(&root, &current, language, &import.specifier) else {
            continue;
        };
        if resolved == current {
            continue;
        }
        match seen.get(&resolved) {
            Some(index) => targets[*index].1.extend(relevant),
            None => {
                if targets.len() >= budget.referenced_files {
                    continue;
                }
                seen.insert(resolved.clone(), targets.len());
                targets.push((resolved, relevant));
            }
        }
    }

    let mut excerpts = Vec::new();
    let mut spent = 0usize;
    for (resolved, names) in targets {
        if spent >= budget.referenced_chars {
            break;
        }
        let Some(text) = read_bounded(&resolved) else {
            continue;
        };
        let relative = resolved
            .strip_prefix(&root)
            .unwrap_or(&resolved)
            .to_string_lossy()
            .replace('\\', "/");
        for excerpt in file_excerpts(&relative, &text, &names) {
            if spent >= budget.referenced_chars {
                break;
            }
            let remaining = budget.referenced_chars - spent;
            let excerpt = truncate_excerpt(excerpt, remaining);
            spent += excerpt.text.chars().count();
            excerpts.push(excerpt);
        }
    }
    excerpts
}

fn truncate_excerpt(mut excerpt: Excerpt, remaining: usize) -> Excerpt {
    if excerpt.text.chars().count() <= remaining {
        return excerpt;
    }
    // Cut on a line boundary so the excerpt never ends mid-token, and never
    // claim a line range the text does not actually cover.
    let mut kept = String::new();
    for line in excerpt.text.lines() {
        if kept.chars().count() + line.chars().count() + 1 > remaining {
            break;
        }
        if !kept.is_empty() {
            kept.push('\n');
        }
        kept.push_str(line);
    }
    excerpt.text = kept;
    excerpt
}

fn read_bounded(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_REFERENCED_FILE_BYTES {
        return None;
    }
    fs::read_to_string(path).ok()
}

/// Every region of `text` that defines one of `names`, merged where the regions
/// overlap so a cluster of small definitions reads as one block.
fn file_excerpts(relative: &str, text: &str, names: &HashSet<String>) -> Vec<Excerpt> {
    let lines: Vec<&str> = text.lines().collect();
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if !names.iter().any(|name| defines(line, name)) {
            continue;
        }
        let first = index.saturating_sub(REFERENCED_LINES_ABOVE);
        let last = (index + REFERENCED_LINES_BELOW).min(lines.len().saturating_sub(1));
        ranges.push((first, last));
    }
    if ranges.is_empty() {
        return Vec::new();
    }
    ranges.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (first, last) in ranges {
        match merged.last_mut() {
            Some((_, previous_last)) if first <= previous_last.saturating_add(1) => {
                *previous_last = (*previous_last).max(last);
            }
            _ => merged.push((first, last)),
        }
    }
    merged
        .into_iter()
        .map(|(first, last)| Excerpt {
            path: relative.to_owned(),
            start_line: first + 1,
            text: lines[first..=last].join("\n"),
        })
        .collect()
}

/// Whether `line` looks like the definition of `name`. Keyword-driven and
/// intentionally shallow: this decides what to show a reader, so a false
/// positive costs a few wasted lines and a false negative costs some context.
fn defines(line: &str, name: &str) -> bool {
    const DEFINITION_KEYWORDS: &[&str] = &[
        "function",
        "const",
        "let",
        "var",
        "class",
        "interface",
        "type",
        "enum",
        "fn",
        "struct",
        "trait",
        "impl",
        "mod",
        "def",
        "static",
        "async",
        "macro_rules!",
    ];
    let Some(index) = word_index(line, name) else {
        return false;
    };
    line[..index]
        .split_whitespace()
        .next_back()
        .is_some_and(|word| DEFINITION_KEYWORDS.contains(&word))
}

/// The byte index of `name` in `line` as a whole word, if present.
fn word_index(line: &str, name: &str) -> Option<usize> {
    if name.is_empty() {
        return None;
    }
    let bytes = line.as_bytes();
    let mut from = 0;
    while let Some(offset) = line.get(from..)?.find(name) {
        let index = from + offset;
        let end = index + name.len();
        let starts_word = index == 0 || !is_ident_continue(bytes[index - 1]);
        let ends_word = end >= bytes.len() || !is_ident_continue(bytes[end]);
        if starts_word && ends_word {
            return Some(index);
        }
        from = end;
    }
    None
}

fn is_ident_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_' || byte == b'$'
}

fn is_ident_continue(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$'
}

/// Identifiers mentioned in `text`. A superset is fine: this only decides which
/// imports are worth resolving. Identifier characters are all ASCII, so the
/// byte walk never slices a multi-byte character.
fn identifiers(text: &str) -> HashSet<&str> {
    const NOISE: &[&str] = &[
        "if", "else", "for", "while", "return", "let", "const", "var", "fn", "pub", "use", "mod",
        "self", "this", "true", "false", "null", "undefined", "new", "await", "async", "import",
        "export", "from", "as", "type", "match", "impl", "in", "of", "not", "and", "or", "is",
    ];
    let bytes = text.as_bytes();
    let mut names = HashSet::new();
    let mut index = 0;
    while index < bytes.len() {
        if !is_ident_start(bytes[index]) {
            index += 1;
            continue;
        }
        let start = index;
        while index < bytes.len() && is_ident_continue(bytes[index]) {
            index += 1;
        }
        let name = &text[start..index];
        if name.len() >= 2 && !NOISE.contains(&name) {
            names.insert(name);
        }
    }
    names
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Language {
    TypeScript,
    Rust,
    Python,
}

fn language_of(path: &str) -> Option<Language> {
    match Path::new(path).extension()?.to_str()? {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => Some(Language::TypeScript),
        "rs" => Some(Language::Rust),
        "py" | "pyi" => Some(Language::Python),
        _ => None,
    }
}

/// One import declared by the file being explained.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Import {
    specifier: String,
    /// Every name the statement binds. Aliases contribute both sides: the local
    /// name is what the selection references, the source name is what the child
    /// file defines, and matching either is cheaper than tracking the mapping.
    names: Vec<String>,
}

fn imports(language: Language, head: &str) -> Vec<Import> {
    match language {
        Language::TypeScript => typescript_imports(head),
        Language::Rust => rust_imports(head),
        Language::Python => python_imports(head),
    }
}

/// Accumulate lines into one statement until it is complete, so multi-line
/// `import { … } from "…"` blocks parse as a single import.
fn statements(head: &str, starts: fn(&str) -> bool, complete: fn(&str) -> bool) -> Vec<String> {
    const MAX_STATEMENT_CHARS: usize = 2_000;
    let mut statements = Vec::new();
    let mut current = String::new();
    for line in head.lines() {
        let trimmed = line.trim();
        if current.is_empty() {
            if !starts(trimmed) {
                continue;
            }
            current.push_str(trimmed);
        } else {
            current.push(' ');
            current.push_str(trimmed);
        }
        if complete(&current) {
            statements.push(std::mem::take(&mut current));
        } else if current.len() > MAX_STATEMENT_CHARS {
            current.clear();
        }
    }
    statements
}

fn typescript_imports(head: &str) -> Vec<Import> {
    statements(
        head,
        |line| line.starts_with("import ") || line.starts_with("import{") || line.contains("require("),
        |statement| quoted_specifier(statement).is_some(),
    )
    .into_iter()
    .filter_map(|statement| {
        let specifier = quoted_specifier(&statement)?;
        // Everything before `from` is the binding clause; a bare `require()`
        // call has its bindings before the `=` instead. With neither, the
        // statement is a side-effect import that binds nothing — scanning it
        // whole would mine the specifier itself for names ("./styles.css"
        // would "import" `styles` and `css`).
        let clause = &statement[..statement.find(" from ").or_else(|| statement.find("require("))?];
        let names = clause_names(clause);
        (!names.is_empty()).then_some(Import { specifier, names })
    })
    .collect()
}

fn quoted_specifier(statement: &str) -> Option<String> {
    let start = statement.find(['"', '\''])?;
    let quote = statement.as_bytes()[start] as char;
    let rest = &statement[start + 1..];
    let end = rest.find(quote)?;
    Some(rest[..end].to_owned())
}

fn clause_names(clause: &str) -> Vec<String> {
    identifiers(clause)
        .into_iter()
        .filter(|name| !matches!(*name, "require" | "default"))
        .map(str::to_owned)
        .collect()
}

fn rust_imports(head: &str) -> Vec<Import> {
    statements(
        head,
        |line| line.starts_with("use ") || line.starts_with("pub use "),
        |statement| statement.ends_with(';'),
    )
    .into_iter()
    .filter_map(|statement| {
        let body = statement
            .trim_end_matches(';')
            .trim_start_matches("pub ")
            .trim_start_matches("use ")
            .trim();
        // Split the module path from the braced item group, if there is one.
        let (path, items) = match body.find('{') {
            Some(index) => (
                body[..index].trim().trim_end_matches("::"),
                body[index..].trim(),
            ),
            None => match body.rfind("::") {
                Some(index) => (&body[..index], &body[index + 2..]),
                None => return None,
            },
        };
        let names = clause_names(items);
        (!names.is_empty()).then(|| Import {
            specifier: path.to_owned(),
            names,
        })
    })
    .collect()
}

fn python_imports(head: &str) -> Vec<Import> {
    statements(
        head,
        |line| line.starts_with("from "),
        |statement| statement.contains(" import ") && !statement.trim_end().ends_with('('),
    )
    .into_iter()
    .filter_map(|statement| {
        let index = statement.find(" import ")?;
        let specifier = statement[5..index].trim().to_owned();
        let names = clause_names(&statement[index + 8..]);
        (!names.is_empty() && !specifier.is_empty()).then_some(Import { specifier, names })
    })
    .collect()
}

/// Resolve an import specifier to a file inside the project, or `None`.
fn resolve(root: &Path, current: &Path, language: Language, specifier: &str) -> Option<PathBuf> {
    let candidate = match language {
        Language::TypeScript => resolve_typescript(current, specifier),
        Language::Rust => resolve_rust(root, current, specifier),
        Language::Python => resolve_python(current, specifier),
    }?;
    // Resolution joins caller-influenced text onto a real path, so the result
    // is only trustworthy after canonicalization: `../` sequences and symlinks
    // both collapse here, and anything landing outside the project is dropped.
    let resolved = candidate.canonicalize().ok()?;
    resolved.starts_with(root).then_some(resolved)
}

fn resolve_typescript(current: &Path, specifier: &str) -> Option<PathBuf> {
    const EXTENSIONS: &[&str] = &["ts", "tsx", "js", "jsx", "mjs", "cjs"];
    // A bare specifier is a package, not a project file.
    if !specifier.starts_with('.') {
        return None;
    }
    let base = current.parent()?.join(specifier);
    if base.is_file() {
        return Some(base);
    }
    for extension in EXTENSIONS {
        let candidate = base.with_file_name(format!(
            "{}.{extension}",
            base.file_name()?.to_str()?
        ));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    // `./foo.js` is the ESM way to spell `./foo.ts`.
    for extension in EXTENSIONS {
        let candidate = base.with_extension(extension);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    for extension in EXTENSIONS {
        let candidate = base.join(format!("index.{extension}"));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Best-effort Rust module resolution. `crate::` anchors at the nearest
/// ancestor holding a Cargo.toml; `self`/`super` walk from the current module.
/// External crates resolve to nothing and are skipped by the root check.
fn resolve_rust(_root: &Path, current: &Path, specifier: &str) -> Option<PathBuf> {
    let mut segments: Vec<&str> = specifier.split("::").filter(|part| !part.is_empty()).collect();
    if segments.is_empty() {
        return None;
    }
    let base = match segments[0] {
        "crate" => {
            segments.remove(0);
            crate_source_root(current)?
        }
        "self" => {
            segments.remove(0);
            current.parent()?.to_path_buf()
        }
        "super" => {
            let mut directory = current.parent()?.to_path_buf();
            while segments.first() == Some(&"super") {
                segments.remove(0);
                directory = directory.parent()?.to_path_buf();
            }
            directory
        }
        // A bare path may be a sibling module or an external crate; try the
        // sibling and let the caller's root check discard anything else.
        _ => current.parent()?.to_path_buf(),
    };
    if segments.is_empty() {
        return None;
    }
    // The trailing segments may name an item rather than a module, so try the
    // longest module path first and shorten until a file appears.
    while !segments.is_empty() {
        let mut candidate = base.clone();
        for segment in &segments {
            candidate = candidate.join(segment);
        }
        let file = candidate.with_extension("rs");
        if file.is_file() {
            return Some(file);
        }
        let module = candidate.join("mod.rs");
        if module.is_file() {
            return Some(module);
        }
        segments.pop();
    }
    None
}

fn crate_source_root(current: &Path) -> Option<PathBuf> {
    let mut directory = current.parent()?;
    loop {
        if directory.join("Cargo.toml").is_file() {
            return Some(directory.join("src"));
        }
        directory = directory.parent()?;
    }
}

fn resolve_python(current: &Path, specifier: &str) -> Option<PathBuf> {
    let leading = specifier.len() - specifier.trim_start_matches('.').len();
    if leading == 0 {
        return None;
    }
    let mut base = current.parent()?.to_path_buf();
    for _ in 1..leading {
        base = base.parent()?.to_path_buf();
    }
    for segment in specifier.trim_start_matches('.').split('.') {
        if segment.is_empty() {
            continue;
        }
        base = base.join(segment);
    }
    let file = base.with_extension("py");
    if file.is_file() {
        return Some(file);
    }
    let package = base.join("__init__.py");
    package.is_file().then_some(package)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbosity_gates_repository_reads_behind_a_long_answer() {
        assert_eq!(ContextBudget::for_verbosity(1).surrounding_lines, 0);
        assert!(!ContextBudget::for_verbosity(1).reads_referenced_files());
        assert!(!ContextBudget::for_verbosity(45).reads_referenced_files());
        assert!(ContextBudget::for_verbosity(45).surrounding_lines > 0);
        assert!(ContextBudget::for_verbosity(100).reads_referenced_files());
        // The slider is clamped, not wrapped: an out-of-range value is the max.
        assert_eq!(
            ContextBudget::for_verbosity(255),
            ContextBudget::for_verbosity(100)
        );
    }

    #[test]
    fn the_surrounding_window_is_clamped_to_the_buffer() {
        let text = (1..=10)
            .map(|line| format!("line {line}"))
            .collect::<Vec<_>>()
            .join("\n");
        let budget = ContextBudget {
            surrounding_lines: 3,
            referenced_files: 0,
            referenced_chars: 0,
        };
        let window = surrounding_window("a.ts", &text, Some(5), Some(6), budget).expect("window");
        assert_eq!(window.start_line, 2);
        assert_eq!(window.end_line(), 9);
        assert!(window.text.starts_with("line 2"));
        assert!(window.text.ends_with("line 9"));

        // A selection covering the whole file has no surroundings to add.
        assert_eq!(
            surrounding_window("a.ts", &text, Some(1), Some(10), budget),
            None
        );
    }

    #[test]
    fn typescript_imports_survive_multiline_and_aliased_clauses() {
        let head = "import { useMemo } from \"react\";\n\
                    import {\n  bridge,\n  type LocalSetting as Setting,\n} from \"../bridge\";\n\
                    import Dropdown from \"./Dropdown\";\n\
                    import \"./styles.css\";\n";
        let imports = typescript_imports(head);
        assert_eq!(imports.len(), 3);
        assert_eq!(imports[1].specifier, "../bridge");
        // Both sides of the alias are captured: the selection uses `Setting`,
        // the child file defines `LocalSetting`.
        assert!(imports[1].names.contains(&"bridge".to_owned()));
        assert!(imports[1].names.contains(&"LocalSetting".to_owned()));
        assert!(imports[1].names.contains(&"Setting".to_owned()));
        // A side-effect import binds nothing and is dropped.
        assert!(!imports.iter().any(|import| import.specifier.ends_with(".css")));
    }

    #[test]
    fn rust_imports_split_the_module_path_from_the_item_group() {
        let imports = rust_imports(
            "use crate::commands::{CommandError, CommandResult};\nuse std::path::Path;\n",
        );
        assert_eq!(imports.len(), 2);
        assert_eq!(imports[0].specifier, "crate::commands");
        assert!(imports[0].names.contains(&"CommandError".to_owned()));
        assert_eq!(imports[1].specifier, "std::path");
        assert!(imports[1].names.contains(&"Path".to_owned()));
    }

    #[test]
    fn definitions_are_found_by_keyword_not_by_mention() {
        assert!(defines("export function resolveModelEffort(entry) {", "resolveModelEffort"));
        assert!(defines("pub struct Setting {", "Setting"));
        assert!(defines("  const bridge = createBridge();", "bridge"));
        assert!(defines("async fn generate_codex_title(", "generate_codex_title"));
        // A call site is not a definition, and a substring is not a word.
        assert!(!defines("  resolveModelEffort(entry, preferred);", "resolveModelEffort"));
        assert!(!defines("pub struct SettingRow {", "Setting"));
    }

    #[test]
    fn excerpts_merge_overlapping_definitions_and_report_true_line_numbers() {
        let text = (1..=60)
            .map(|line| match line {
                20 => "pub fn alpha() {".to_owned(),
                24 => "pub fn beta() {".to_owned(),
                50 => "pub fn gamma() {".to_owned(),
                _ => format!("    // filler {line}"),
            })
            .collect::<Vec<_>>()
            .join("\n");
        let names: HashSet<String> = ["alpha", "beta", "gamma"]
            .iter()
            .map(|name| (*name).to_owned())
            .collect();
        let excerpts = file_excerpts("a.rs", &text, &names);
        // alpha and beta overlap into one block; gamma stands alone.
        assert_eq!(excerpts.len(), 2);
        assert_eq!(excerpts[0].start_line, 16);
        assert_eq!(excerpts[0].end_line(), 36);
        assert_eq!(excerpts[1].start_line, 46);
        assert!(excerpts[0].text.contains("pub fn alpha"));
        assert!(excerpts[0].text.contains("pub fn beta"));
    }

    #[test]
    fn truncation_keeps_whole_lines() {
        let excerpt = Excerpt {
            path: "a.rs".into(),
            start_line: 1,
            text: "alpha\nbeta\ngamma".into(),
        };
        let truncated = truncate_excerpt(excerpt, 11);
        assert_eq!(truncated.text, "alpha\nbeta");
    }

    #[test]
    fn identifiers_ignore_noise_and_multibyte_text() {
        let names = identifiers("const café = resolveModelEffort(x); // naïve");
        assert!(names.contains("resolveModelEffort"));
        assert!(names.contains("naïve") || names.contains("na"));
        assert!(!names.contains("const"));
        // Single characters are never worth resolving an import for.
        assert!(!names.contains("x"));
    }
}
