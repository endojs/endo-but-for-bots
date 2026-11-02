---
'@endo/cli': minor
'@endo/tar': minor
---

`endo install` installs a package's skills and prompts into the `.agents`
discovery paths from `npm:`, `git:`, or a local path, reading the new `endo` key
of `package.json`. `endo list packages`, `endo remove <source>`, `endo config
enable|disable`, and `endo update` manage what was installed. `endo list
packages` now reads this ledger, so a daemon directory with the pet name
`packages` can no longer be listed by that exact command. A package's `guests`
and `providers` are reported but not yet installed.

`@endo/tar` entries now report their header's permission bits as `mode`.
