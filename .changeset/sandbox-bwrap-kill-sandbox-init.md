---
'@endo/sandbox': patch
---

The bwrap driver now kills a slice's sandbox init directly before it signals
the launcher's process group. bwrap arms `--die-with-parent` in the init only
after namespace setup, and the init leaves the host process group through
`setsid()`, so a launcher killed during setup used to strand the init: blocked
forever on setup, or running the command with no death signal and beyond the
reach of any later group signal. The driver reads the init's host pid from
bwrap's `--info-fd` report and kills it first, which tears down the whole pid
namespace.
