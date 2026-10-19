---
'@endo/cli': minor
---

Add `endo write <mount-name> <path...>`, which streams standard input to a
file within a mount. The path may be given as separate segments or as one
slash-delimited path; the mount resolves it under its own confinement rules
(`..` clamped at the mount root, escaping symlinks rejected), creates missing
parent directories, and replaces the target only once the whole input has been
read. Read-only mounts refuse the write.
