---
'@endo/skills': minor
---

Add `@endo/skills`, implementing phases 1-3 and 5 of the `endopi-skills-markdown-format` design. It parses `SKILL.md` skill directories in the agentskills.io format shared by Pi, Claude Code, and Codex; discovers them in `~/.claude/skills`, `~/.codex/skills`, `~/.pi/agent/skills`, `~/.agents/skills`, and the project's `.agents/skills`, `.claude/skills`, and `.pi/skills`; renders the compact name-and-description list for a system prompt; and expands `/skill:<name>` messages into the skill's body.
