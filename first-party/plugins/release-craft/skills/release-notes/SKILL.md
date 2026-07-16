---
name: release-notes
description: Generate a changelog or release notes from git history between two refs. Use when the user asks to write release notes, update a CHANGELOG, summarize what changed since a tag, or prepare a version bump announcement.
---

# Release Notes

## Method

1. **Establish the range.** Last tag to HEAD by default:
   `git describe --tags --abbrev=0` then `git log <tag>..HEAD --oneline`.
   Confirm the range with the user if no tags exist.
2. **Read the real changes, not just subjects.** `git log` subjects lie by
   omission; for anything user-facing, check the diff stat
   (`git log --stat`) and skim key diffs. Merge/squash commits often bundle
   several changes — unpack them from the PR body if referenced.
3. **Classify by reader impact**, not by commit type: Added / Changed /
   Fixed / Deprecated / Removed / Security (Keep a Changelog order).
   Internal refactors, CI, and test-only changes are omitted or collapsed to
   one line unless they change behavior.
4. **Write for the user of the software, not the authors.** Lead each entry
   with what the reader can now do or what stopped being broken; name the
   feature area, not the file. Include breaking changes first, with
   migration steps.
5. **Link discipline.** Reference PR/issue numbers when the repo has a
   forge; keep a consistent format with existing CHANGELOG entries — match
   the file's established style before inventing one.

## Output forms

- `CHANGELOG.md` entry (Keep a Changelog format, new version section on top,
  with a comparison link when the repo has tags).
- GitHub release body: shorter, highlights-first, with a "Full changelog"
  compare link.

Never invent changes that aren't in the range, and never claim testing or
compatibility that the history doesn't show.
