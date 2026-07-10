---
'@endo/agent-tools': minor
---

Add `discoverCapabilityTools`, which looks up the well-known capability pet
names (`fs`, `shell`, `git`) in an agent's own namespace and returns the
`ToolRecord`s each *granted* capability backs (filesystem read/list/stat/edit,
allowlisted shell `exec`/`inspect`, and git read/branch plus mount-bridged
`status`/`add`). A missing pet name is the discovery signal — it contributes no
tools — so the same agent code runs with or without coding capabilities. The
new `./discover.js` subpath and the `CapabilityToolOptions` type are exported
alongside it (daemon-agent-tools Phase 4).
