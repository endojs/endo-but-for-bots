---
'@endo/daemon': minor
'@endo/cli': minor
---

Add durable strong map and set stores to daemon agents. Named stores persist
their entries across daemon restarts and retain passable keys and values.

Add `endo mkmap`, `endo mkset`, and coherent `endo map` / `endo set` command
groups for creating and operating on these stores from the command line.
