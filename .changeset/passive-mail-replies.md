---
"@endo/floot": patch
---

Keep unclaimed mail replies passive, including after a restart.
Pending subagent requests still consume correlated replies, while late replies
and their capability attachments remain available for explicit handling.
This prevents agent acknowledgments and provider errors from generating an
unbounded exchange of model turns and growing histories until heap exhaustion.
