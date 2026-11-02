---
"@endo/daemon": patch
---

Retire a development environment's native controller after a shell execution
rejects. Wait for cleanup acknowledgement before allowing a fresh controller,
retain a failed cleanup owner for explicit retry, and never replay the command.
