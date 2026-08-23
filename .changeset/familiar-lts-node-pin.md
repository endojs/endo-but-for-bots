---
'@endo/familiar': patch
---

Bump bundled Node binary pin from `v20.18.1` to `v22.22.3` (Maintenance LTS).
Node 20 (Iron) reached EOL in April 2026; Node 22 (Jod) and Node 24 (Krypton)
are the currently supported LTS lines.
The bump is in lockstep across `scripts/download-node.mjs`,
`scripts/download-node.sh`, and the `familiar-release.yml` workflow.
Adds an `engines` field to the package declaring support for Node 22 and 24.
