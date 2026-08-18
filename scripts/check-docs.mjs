import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const markdown = [];

function walk(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (entry === "node_modules" || entry === "target" || entry === ".git") continue;
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith(".md")) markdown.push(path);
  }
}

walk(root);

const failures = [];
const linkPattern = /\[[^\]]+\]\(([^)]+)\)/g;

for (const file of markdown) {
  const raw = readFileSync(file, "utf8");
  const fenceCount = raw.match(/^```/gm)?.length ?? 0;
  if (fenceCount % 2 !== 0) failures.push(`${file}: unbalanced code fences`);

  // A link inside a code span is an example of the form, not a link to
  // follow: a doc that shows `[path:line](./path#Lline)` is not claiming
  // there is a file called `path`.
  const source = raw.replace(/`[^`\n]*`/g, (span) => " ".repeat(span.length));

  for (const match of source.matchAll(linkPattern)) {
    const target = match[1].split("#")[0];
    if (!target || /^(https?:|mailto:|aiintegrator:)/.test(target)) continue;
    const local = resolve(dirname(file), decodeURIComponent(target));
    if (!existsSync(local)) failures.push(`${file}: missing local link ${target}`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Documentation OK: ${markdown.length} Markdown files`);
