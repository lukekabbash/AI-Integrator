export type SyntaxTokenKind =
  "keyword" | "string" | "type" | "comment" | "plain" | "function" | "variable" | "number";

export interface SyntaxToken {
  text: string;
  kind: SyntaxTokenKind;
}

const KEYWORDS = new Set(
  `abstract as async await become bool break case catch class const continue crate
  debugger default defer delete do dyn else enum export extends false final finally
  fn for from function get go if impl import in infer instanceof interface is keyof
  let loop match mod move mut namespace new null of override package private protected
  pub public readonly ref return self set static struct super switch this throw trait
  true try type typeof undefined union unsafe use var void where while with yield`.split(/\s+/),
);

const SUPPORTED_EXTENSIONS = new Set([
  "c",
  "cc",
  "cpp",
  "cs",
  "css",
  "go",
  "h",
  "hpp",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "md",
  "php",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "svelte",
  "toml",
  "ts",
  "tsx",
  "vue",
  "xml",
  "yaml",
  "yml",
]);

const HASH_COMMENT_EXTENSIONS = new Set(["py", "rb", "sh", "toml", "yaml", "yml"]);
const MARKUP_EXTENSIONS = new Set(["html", "md", "svelte", "vue", "xml"]);
const NO_SLASH_COMMENT_EXTENSIONS = new Set([
  "json",
  "md",
  "py",
  "rb",
  "sh",
  "toml",
  "yaml",
  "yml",
]);
const patternCache = new Map<string, RegExp>();

function extensionForPath(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

function tokenPattern(extension: string): RegExp {
  const cached = patternCache.get(extension);
  if (cached) return cached;

  const sources = ['"(?:\\\\.|[^"\\\\])*"', "'(?:\\\\.|[^'\\\\])*'", "`(?:\\\\.|[^`\\\\])*`"];
  if (MARKUP_EXTENSIONS.has(extension)) sources.push("<!--.*?-->");
  if (!NO_SLASH_COMMENT_EXTENSIONS.has(extension)) {
    sources.push("\\/\\/.*", "\\/\\*.*?\\*\\/");
  }
  if (HASH_COMMENT_EXTENSIONS.has(extension)) sources.push("#.*");
  if (extension === "css" || extension === "scss") sources.push("#[\\da-fA-F]{3,8}\\b");
  sources.push(
    "\\b(?:0[xX][\\da-fA-F]+|0[bB][01]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b",
    "\\b[A-Za-z_$][\\w$]*\\b",
  );

  const pattern = new RegExp(sources.join("|"), "g");
  patternCache.set(extension, pattern);
  return pattern;
}

function tokenKind(text: string, after: string): SyntaxTokenKind {
  if (
    text.startsWith("//") ||
    text.startsWith("/*") ||
    text.startsWith("<!--") ||
    text.startsWith("# ") ||
    text.startsWith("#!") ||
    text === "#"
  ) {
    return "comment";
  }
  if (/^["'`]/.test(text)) return "string";
  if (/^#(?:[\da-fA-F]{3,8})$/.test(text) || /^\d/.test(text)) return "number";
  if (KEYWORDS.has(text)) return "keyword";
  if (/^[A-Z]/.test(text)) return "type";
  if (/^\s*\(/.test(after)) return "function";
  return "variable";
}

/**
 * Fast, line-local highlighting for the mounted diff window. It deliberately
 * avoids a grammar engine on the renderer thread, keeping large reviews
 * progressive while giving every visible context/change line semantic color.
 */
export function highlightCodeLine(line: string, path: string): SyntaxToken[] {
  // Empty lines must stay empty: a placeholder space shifts overlay-editor
  // character offsets after blank lines and misaligns native selection.
  if (!line) return [];
  const extension = extensionForPath(path);
  if (!SUPPORTED_EXTENSIONS.has(extension)) return [{ text: line, kind: "plain" }];

  const tokens: SyntaxToken[] = [];
  const pattern = tokenPattern(extension);
  pattern.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line))) {
    if (match.index > cursor) {
      tokens.push({ text: line.slice(cursor, match.index), kind: "plain" });
    }
    const text = match[0];
    tokens.push({
      text,
      kind:
        text.startsWith("#") && HASH_COMMENT_EXTENSIONS.has(extension)
          ? "comment"
          : tokenKind(text, line.slice(match.index + text.length)),
    });
    cursor = match.index + text.length;
  }
  if (cursor < line.length) tokens.push({ text: line.slice(cursor), kind: "plain" });
  return tokens.length ? tokens : [{ text: line, kind: "plain" }];
}
