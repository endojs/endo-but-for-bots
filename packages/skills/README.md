# @endo/skills

Parse and discover skills in the [agentskills.io](https://agentskills.io/specification)
format that Pi, Claude Code, and Codex share, and render them for an agent's
system prompt. A skill written for any of those harnesses loads here without
translation.

A skill is a directory with a `SKILL.md` at its root:

```
my-skill/
├── SKILL.md       # required: frontmatter + body
├── scripts/       # optional helpers the body references
├── references/    # optional details loaded on demand
└── assets/        # optional templates and data
```

```markdown
---
name: my-skill
description: What this skill does and when to use it.
license: MIT
compatibility: Requires git, bash.
allowed-tools: read bash
disable-model-invocation: false
---

# My Skill

Run `./scripts/process.sh <input>`. See [API reference](references/api.md).
```

`name` must be 1-64 characters of lowercase `a-z`, `0-9`, and single hyphens,
and match the directory name; `description` is required and at most 1024
characters. Like Pi, the loader is lenient: a skill without a description is
not loaded, and every other violation is a warning.

## Discovery

```js
import { discoverSkills } from '@endo/skills/node.js';

const { skills, diagnostics } = await discoverSkills({
  homeDirectory: os.homedir(),
  workingDirectory: process.cwd(),
});
```

Directories are scanned from lowest to highest precedence; a later directory
overrides an earlier one on the same skill name, with a warning:

1. `~/.claude/skills`, `~/.codex/skills` (cross-harness)
2. `~/.pi/agent/skills`, `~/.agents/skills`
3. `.agents/skills` from the repository root down to the working directory
4. `.claude/skills` (cross-harness) and `.pi/skills` in the working directory

Pass `crossHarness: false` to skip the Claude Code and Codex directories.
`loadSkills` in `@endo/skills/load.js` takes any `SkillSource`, for hosts that
reach skill directories through something other than Node's filesystem.

## System prompt

```js
import {
  expandSkillCommand,
  formatSkillsForPrompt,
} from '@endo/skills/prompt.js';

const systemPrompt = `${basePrompt}\n\n${formatSkillsForPrompt(skills)}`;
```

The prompt carries only each skill's name, description, and `SKILL.md`
location; the model reads the body when a task matches. Skills marked
`disable-model-invocation: true` are left out of the list but stay reachable
by command: `expandSkillCommand` turns a `/skill:<name> [arguments]` message
into the skill's body, wrapped in a `<skill>` element, followed by the
arguments.
