---
'@endo/agentry': minor
'@endo/agent-tools': minor
---

Code-mode lexical powers now use one normalized capability-and-declaration
grant representation.
Direct agents and retained daemon/Pi sessions derive runtime endowments,
declarations, collision checks, and prompt text from the same live grants.

Reader filesystem grants are now described as read-only in the generated
prompt instead of advertising writes that reject.
Lookup-backed `workspace` and `git` powers resolve through the new
asynchronous `makeCodeModeAgentFromLookup` / `resolveCodeModePowers` exports,
so posture validation inspects the live capability rather than the promise
for it.
