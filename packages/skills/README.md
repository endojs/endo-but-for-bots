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

`name` must be 1-64 characters of lowercase `a-z`, `0-9`, and single hyphens
(none leading, trailing, or doubled), and match the directory name;
`description` is required and at most 1024 characters; `compatibility` is at
most 500 characters; `metadata` is a one-level string map; and
`disable-model-invocation` is a boolean. Like Pi, the loader is lenient: a
skill without a description is not loaded, and every other violation
(including YAML outside the supported subset) is a warning. `allowed-tools`
is parsed into `Skill.allowedTools` and never enforced: a skill carries
instructions, not authority. A `SKILL.md` over 1 MiB is rejected.

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

## Skills through read-only mounts

A confined agent such as Lal reads no disk. It holds the pet name
`agent-skills`, a directory of read-only mounts, one per skill source
directory. The setup script is the user's grant and the only code that reads
the filesystem:

```sh
endo-skills-setup <agent-pet-name> [--no-cross-harness]
```

It mounts each conventional directory above that exists as
`<agent>/agent-skills/<NN>-<label>` (for example `03-agents-user`), with the
two-digit prefix preserving precedence, and on rerun replaces only the
entries it wrote before. The agent loads them with `loadAgentSkills(powers)`
from `@endo/skills/mount.js`; skill locations are pet-name paths such as
`agent-skills/03-agents-user/my-skill/SKILL.md` that the model can pass to
`readText`.

## System prompt

```js
import {
  expandSkillCommand,
  formatSkillsForPrompt,
} from '@endo/skills/prompt.js';

const systemPrompt = `${basePrompt}\n\n${formatSkillsForPrompt(skills)}`;
```

The default reading instructions suit a host whose model reads files by path
with a `read` tool. A host that delivers skills another way passes its own
`formatSkillsForPrompt(skills, { readHint })`.

The prompt carries only each skill's name, description, and `SKILL.md`
location; the model reads the body when a task matches. Skills marked
`disable-model-invocation: true` are left out of the list but stay reachable
by command: `expandSkillCommand` turns a `/skill:<name> [arguments]` message
into the skill's body, wrapped in a `<skill>` element, followed by the
arguments.
