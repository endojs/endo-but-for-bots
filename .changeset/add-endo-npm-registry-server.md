---
'@endo/npm-registry-server': major
---

Add `@endo/npm-registry-server` package: an npm-protocol registry server for staged development releases.
Stock `npm` and Yarn clients publish `<version>-dev.<timestamp>.g<sha>` builds under dated `dev-YYYY-MM-DD` tags with a bearer publish grant scoped to a package allowlist, and install from it with a single registry override.
Exact tarball bytes and extracted package trees live in a content-addressed store, with versions, dist-tags, grants, and an audit log in SQLite; the server verifies the store before it listens.
When an upstream registry is configured, packages not staged locally are read through from that single pinned origin, integrity-checked, retained, and re-served, with stale metadata served when the upstream is unreachable.
The `npm-registry-admin` command issues, lists, and revokes grants and verifies the store.
