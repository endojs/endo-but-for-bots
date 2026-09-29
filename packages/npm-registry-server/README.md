# `@endo/npm-registry-server`

An npm-protocol registry server for staged **development** releases, as
specified by
[`designs/npm-dev-registry-serving.md`](../../designs/npm-dev-registry-serving.md).
Stock `npm` and Yarn clients publish to it and install from it; nothing on the
client side is Endo-specific.

- **Publish** accepts `npm publish --tag dev-YYYY-MM-DD` for versions shaped
  `<major>.<minor>.<patch>-dev.<YYYYMMDDHHMMSS>.g<sha>`, from a bearer
  `PublishGrant` whose allowlist covers the package. The date tag must match
  the version's commit date. `latest`, release versions, unpublish,
  deprecate, and tag deletion are refused. `npm dist-tag add` may move a date
  channel (within its date) or the reserved `dev-latest` pointer, forward
  only.
- **Storage** keeps the exact `.tgz` bytes and the extracted immutable package
  tree in a content-addressed store (`<state>/cas/`, one sha256-named file per
  blob), and the version, dist-tag, grant, and audit rows in SQLite
  (`<state>/registry.sqlite`). CAS writes precede the transaction that makes a
  version visible.
- **Serve** synthesizes full and abbreviated
  (`application/vnd.npm.install-v1+json`) packuments, version manifests,
  dist-tag maps, and tarballs. Every `dist.tarball` URL is rooted at the
  configured public origin.
- **Read-through**: when an upstream registry is configured, a package not
  staged locally is fetched from that single pinned origin, its tarball is
  verified against the upstream integrity, retained, extracted, and
  re-served. One global registry override therefore installs a whole graph.
  Cached metadata is served when the upstream is unreachable
  (stale-if-error); nothing ever redirects a client elsewhere.

## Running

```sh
REGISTRY_STATE_DIR=/var/lib/npm-minion-registry \
PUBLIC_REGISTRY_URL=https://npm.minion.town \
UPSTREAM_REGISTRY_URL=https://registry.npmjs.org \
HOST=127.0.0.1 PORT=3003 \
REGISTRY_PUBLISHER_GRANT_ID=garden-llm-publisher-1 \
REGISTRY_PUBLISHER_TOKEN=... \
REGISTRY_PUBLISHER_PACKAGES='@endo/*' \
REGISTRY_PUBLISHER_EXPIRES=2027-01-01T00:00:00Z \
npm-registry-server
```

The publisher grant variables are optional; when present, the server records
the grant (storing only the token's SHA-256) and removes the token from its
environment. `REGISTRY_PUBLISHER_SUBJECT` names the grant's subject (default
`garden-llm-publisher`). A grant the store refuses, such as a revoked id, is
logged and the server keeps serving reads. An empty `UPSTREAM_REGISTRY_URL`
makes a local-only registry, and `UPSTREAM_TTL_SECONDS` sets how long cached
upstream metadata is fresh.

`REGISTRY_STATE_DIR` is persistent deployment state, not part of the source
tree: the operator backs it up and never discards it, since it holds the only
copy of every staged development release.
The server verifies that every stored version's tarball and tree are present
before it binds its socket, and checkpoints SQLite on `SIGTERM`.

`npm-registry-admin` manages grants (`grants list|issue|revoke`) and runs the
same store verification (`verify`) against `REGISTRY_STATE_DIR`.

## Publishing

```sh
echo "//npm.minion.town/:_authToken=$TOKEN" > .npmrc
npm publish --registry https://npm.minion.town --tag dev-2026-09-28
npm view @endo/patterns@dev-2026-09-28 version --registry https://npm.minion.town
```

## Installing

```sh
npm_config_registry=https://npm.minion.town/ npm install @endo/patterns@dev-2026-09-28
```

With Yarn, set `npmRegistryServer: "https://npm.minion.town"`.

## Not yet

- The HTTP adapter reads exact versions through its own tables rather than
  the `npm-registry-as-directory-tree` interface, which has not landed; the
  design permits this compatibility adapter until the tree does.
- Tarballs containing hard links or symbolic links are refused, including
  upstream ones; such a dependency returns `502` rather than installing.
