import type { CSSProperties } from "react";
import {
  BookOpen,
  Braces,
  Container,
  Database,
  FileArchive,
  FileCode2,
  FileImage,
  FileText,
  FileType2,
  GitBranch,
  Globe,
  Hash,
  Lock,
  Package,
  ScrollText,
  Settings2,
  TerminalSquare,
  type LucideIcon,
} from "lucide-react";

interface FileTypeStyle {
  icon: LucideIcon;
  color: string;
}

const DEFAULT_STYLE: FileTypeStyle = { icon: FileText, color: "#8a959e" };

/** Special-cased whole file names take priority over extension rules. */
const NAME_STYLES: Record<string, FileTypeStyle> = {
  "package.json": { icon: Package, color: "#cb3837" },
  "package-lock.json": { icon: Package, color: "#cb3837" },
  "pnpm-lock.yaml": { icon: Package, color: "#f9ad00" },
  "yarn.lock": { icon: Lock, color: "#2c8ebb" },
  "cargo.toml": { icon: Package, color: "#dea584" },
  "cargo.lock": { icon: Lock, color: "#dea584" },
  dockerfile: { icon: Container, color: "#2496ed" },
  ".dockerignore": { icon: Container, color: "#2496ed" },
  ".gitignore": { icon: GitBranch, color: "#f05033" },
  ".gitattributes": { icon: GitBranch, color: "#f05033" },
  ".gitmodules": { icon: GitBranch, color: "#f05033" },
  license: { icon: ScrollText, color: "#d0bf41" },
  "license.md": { icon: ScrollText, color: "#d0bf41" },
  "license.txt": { icon: ScrollText, color: "#d0bf41" },
  makefile: { icon: TerminalSquare, color: "#6d8086" },
};

const EXTENSION_STYLES: Record<string, FileTypeStyle> = {
  ts: { icon: FileCode2, color: "#519aba" },
  mts: { icon: FileCode2, color: "#519aba" },
  cts: { icon: FileCode2, color: "#519aba" },
  tsx: { icon: FileCode2, color: "#2bb7d6" },
  js: { icon: FileCode2, color: "#cbcb41" },
  mjs: { icon: FileCode2, color: "#cbcb41" },
  cjs: { icon: FileCode2, color: "#cbcb41" },
  jsx: { icon: FileCode2, color: "#2bb7d6" },
  json: { icon: Braces, color: "#cbcb41" },
  jsonc: { icon: Braces, color: "#cbcb41" },
  css: { icon: Hash, color: "#519aba" },
  scss: { icon: Hash, color: "#f55385" },
  sass: { icon: Hash, color: "#f55385" },
  less: { icon: Hash, color: "#a074c4" },
  html: { icon: Globe, color: "#e37933" },
  htm: { icon: Globe, color: "#e37933" },
  xml: { icon: Globe, color: "#e37933" },
  md: { icon: BookOpen, color: "#519aba" },
  mdx: { icon: BookOpen, color: "#519aba" },
  rs: { icon: Settings2, color: "#dea584" },
  py: { icon: FileCode2, color: "#4e8cc0" },
  go: { icon: FileCode2, color: "#00acd7" },
  java: { icon: FileCode2, color: "#cc3e44" },
  kt: { icon: FileCode2, color: "#a97bff" },
  c: { icon: FileCode2, color: "#519aba" },
  h: { icon: FileCode2, color: "#a074c4" },
  cpp: { icon: FileCode2, color: "#f34b7d" },
  hpp: { icon: FileCode2, color: "#a074c4" },
  cs: { icon: FileCode2, color: "#368832" },
  rb: { icon: FileCode2, color: "#cc342d" },
  php: { icon: FileCode2, color: "#a074c4" },
  swift: { icon: FileCode2, color: "#f05138" },
  vue: { icon: FileCode2, color: "#42b883" },
  svelte: { icon: FileCode2, color: "#ff3e00" },
  sh: { icon: TerminalSquare, color: "#89e051" },
  bash: { icon: TerminalSquare, color: "#89e051" },
  zsh: { icon: TerminalSquare, color: "#89e051" },
  ps1: { icon: TerminalSquare, color: "#4d8dc4" },
  psm1: { icon: TerminalSquare, color: "#4d8dc4" },
  bat: { icon: TerminalSquare, color: "#c1f12e" },
  cmd: { icon: TerminalSquare, color: "#c1f12e" },
  yml: { icon: Settings2, color: "#a074c4" },
  yaml: { icon: Settings2, color: "#a074c4" },
  toml: { icon: Settings2, color: "#6d8086" },
  ini: { icon: Settings2, color: "#6d8086" },
  cfg: { icon: Settings2, color: "#6d8086" },
  conf: { icon: Settings2, color: "#6d8086" },
  env: { icon: Settings2, color: "#ecd53f" },
  sql: { icon: Database, color: "#d0855c" },
  db: { icon: Database, color: "#d0855c" },
  sqlite: { icon: Database, color: "#d0855c" },
  svg: { icon: FileImage, color: "#b7b73b" },
  png: { icon: FileImage, color: "#a074c4" },
  jpg: { icon: FileImage, color: "#a074c4" },
  jpeg: { icon: FileImage, color: "#a074c4" },
  gif: { icon: FileImage, color: "#a074c4" },
  webp: { icon: FileImage, color: "#a074c4" },
  ico: { icon: FileImage, color: "#a074c4" },
  zip: { icon: FileArchive, color: "#b8956a" },
  tar: { icon: FileArchive, color: "#b8956a" },
  gz: { icon: FileArchive, color: "#b8956a" },
  "7z": { icon: FileArchive, color: "#b8956a" },
  rar: { icon: FileArchive, color: "#b8956a" },
  ttf: { icon: FileType2, color: "#cc6d6d" },
  otf: { icon: FileType2, color: "#cc6d6d" },
  woff: { icon: FileType2, color: "#cc6d6d" },
  woff2: { icon: FileType2, color: "#cc6d6d" },
  lock: { icon: Lock, color: "#6d8086" },
  txt: { icon: FileText, color: "#8a959e" },
};

/** VS Code-style icon + color for a file name or project-relative path. */
function fileTypeStyle(fileName: string): FileTypeStyle {
  const base = fileName.split("/").at(-1)?.toLowerCase() ?? "";
  const byName = NAME_STYLES[base];
  if (byName) return byName;
  if (base.startsWith(".env")) return EXTENSION_STYLES.env;
  const extension = base.includes(".") ? (base.split(".").at(-1) ?? "") : "";
  return EXTENSION_STYLES[extension] ?? DEFAULT_STYLE;
}

export function FileIcon({ fileName, className }: { fileName: string; className?: string }) {
  const { icon: Icon, color } = fileTypeStyle(fileName);
  return (
    <Icon
      className={className ? `file-type-icon ${className}` : "file-type-icon"}
      style={{ "--file-icon-color": color } as CSSProperties}
      aria-hidden="true"
    />
  );
}
