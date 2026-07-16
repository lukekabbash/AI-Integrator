---
name: skill-creator
description: Create a new portable agent skill (SKILL.md) from a description of a repeated task or expertise. Use when the user wants to make, write, scaffold, or package a skill, or says "turn this into a skill".
---

# Skill Creator

You are creating a portable agent skill following the open Agent Skills
format (agentskills.io). The result must work in any compatible runtime
(Claude Code, Codex, Antigravity, Cursor, and others), not just the one you
are running in.

## Process

1. **Interview briefly.** Ask only what you cannot infer: what task the skill
   covers, when it should trigger, and what reference material or scripts it
   needs. If the user already described the task, skip to step 2.
2. **Pick a name.** Lowercase letters, digits, hyphens only; max 64 chars;
   must not contain "claude" or "anthropic". Specific beats generic
   (`fred-data`, not `data-helper`).
3. **Write the description carefully — it is the trigger.** One or two
   sentences, max 1024 chars, stating BOTH what the skill does AND when to
   use it, including keywords a user would actually type.
4. **Write the body** using this structure:
   - When to use / when not to use.
   - Step-by-step instructions, concrete over abstract.
   - Reference links or bundled file pointers, loaded only when needed.
   - Common failure modes and how to recover.
   Keep the body under ~4000 tokens. Move bulk reference material into
   sibling files (`REFERENCE.md`, `scripts/`) and point to them — they load
   on demand, so they are free until read.
5. **Stay runtime-neutral.** Do not reference runtime-specific tool names,
   slash commands, or config paths in the body. Scripts should be plain
   Python (stdlib) or POSIX shell. State any required API keys as environment
   variables the user sets themselves; never instruct an app to store
   credentials.
6. **Write the files** into `Documents/AI Integrator/Skills/<name>/` (ask the
   user to confirm the location if a project-scoped skill makes more sense —
   project skills live in the repository under `.aiintegrator/knowledge/skills/`).
7. **Validate** before finishing: frontmatter parses, name and description
   within limits, no credentials or absolute user paths embedded, body reads
   correctly on its own with no conversation context.

## Quality bar

A good skill is one an agent can follow cold. Test it mentally: given only
this file and a matching task, would an agent with file and shell access
succeed? If a step depends on knowledge only in your head, write it down.
