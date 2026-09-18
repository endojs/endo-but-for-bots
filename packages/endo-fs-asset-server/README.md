# @endo/endo-fs-asset-server

Serve an [`@endo/platform/fs/extended`](../platform) `Filesystem` cap
over HTTP from a static asset server.

The server is built on the platform-agnostic HTTP server interface
[`@endo/platform/http/server`](../platform/src/http/server.js): this
package owns only the request *handler* (a pure `(request) => response`
function), while all socket I/O and response streaming live behind an
injected `backend`. The Node backend is
[`@endo/platform/http/node`](../platform/src/http-node/index.js)
(`makeNodeHttpBackend()`); a non-Node embedder supplies its own
and the same handler runs unchanged.

The server is instantiated as an **unconfined formula** so it can hold a
real listening socket. Each `serve(target)` call mints a fresh,
unguessable **capability path**, registers the target under it, and
returns `{ id, path, url, revoke }`. `target` is a `Filesystem`, a daemon
`Mount`, or an `@endo/exo-git` workspace (served through its worktree, so
what is served is the files as they are, not the last commit).

The token embedded in the URL path *is* the capability: there is no
other authorization check, so the path must stay secret.

## The server is the retention root for what it serves

A route is not a favour the publisher keeps doing. On receipt, `serve`
takes a **read-only facet** of the capability and that facet is all the
server keeps. Made with a host agent of its own as `powersName`, it keeps
the facet and the route's record in that agent's pet store, so:

- the daemon retains the facet's formula, and what it depends on, for as
  long as the route stands — nothing else has to hold the asset alive;
- the next incarnation of the server **restores every route by itself**,
  before its listener opens: a published URL survives a daemon restart
  and a deploy, with nobody publishing again;
- a route whose target cannot be revived is kept, listed as
  `unavailable`, and answered `503` (retried on the next request) rather
  than dropped — **only a revocation ends a route**;
- a capability the daemon did not mint (a view built in some worker) has
  no formula and cannot be retained, so it is **refused** instead of
  served until the next restart. Hand over the daemon-minted capability
  itself; the server takes its own read-only facet.

For a Mount or a Git worktree the read-only facet is a read-only
sub-mount formula the daemon mints (`provideSubMount(mountCap, [], name,
{ readOnly: true })`) and will not let widen. A `Filesystem` has no
daemon-side attenuator: it is retained as given and only ever reached
through the read-only attenuator, so pass one that is already read-only
when the difference matters.

Made without powers the server still runs, retains in memory, loses every
route on restart, and says so once at startup. Powers that are not a host
agent (a handle in place of its agent, a guest) are refused.

## Facets

The formula value is the **`AssetServerAdmin`**:

| method | |
| --- | --- |
| `list()` | every served item: `{ id, path, url, kind, subPath, index, label, createdAt, status, error? }` |
| `getTarget(id)` | the retained read-only facet of an item, for looking at what a route serves |
| `revoke(id)` | drop a route and release what was retained for it |
| `publisher()` | the serve-only facet, below |
| `getAddress()` / `stop()` | `stop()` closes the listener and releases nothing |

The administrator reads and removes. It has no `serve` and no way to
change what a route points at.

`publisher()` is the **`AssetPublisher`**, the facet to hand to anything
that has a tree to publish: `serve(target, opts)`, `describe(id)`,
`release(id)`, `getAddress()`. It cannot list, and `describe`/`release`
answer only for an `id` that `serve` returned (128 random bits, never
part of a URL).

## Shape

```js
const { id, path, url, revoke } = await E(publisher).serve(target, {
  // optional: rebase the served root inside the target
  subPath: 'dist',
  // optional: directory index file name, defaults to 'index.html'
  index: 'index.html',
  // optional: free text the administrator sees in list()
  label: 'docs site',
});

// GET ${url}style.css       -> 200, the file's bytes
// GET ${url}                -> 200, the index file
// GET ${url}missing         -> 404
// ... across requests, restarts and deploys ...

await E(revoke).revoke(); // or, later and from anywhere: E(publisher).release(id)
// GET ${url}style.css       -> 404
```

`getAddress()` reports `{ host, port, origin }` (useful when the server
was started on the OS-assigned port `0`).

## Instantiating the server

The unconfined entry point is `src/asset-server-module.js`. Configure it
through `makeUnconfined`'s per-formula `env`:

| env var | meaning |
| --- | --- |
| `ENDO_FS_ASSET_SERVER_PORT` | Port to listen on. `0`/unset asks the OS to assign one. |
| `ENDO_FS_ASSET_SERVER_HOST` | Interface to bind. Defaults to `127.0.0.1` (loopback). |
| `ENDO_FS_ASSET_SERVER_PUBLIC_BASE` | Origin to advertise in returned URLs when behind a proxy. |

```js
// 1. A host agent that belongs to the server: its pet store is where the
//    server retains what it serves. The agent, not its handle, is the powers.
await E(host).provideHost('assets-host-handle', { agentName: 'assets-host' });

// 2. The server. Its value is the administrator.
await E(host).makeUnconfined('@main', assetServerModuleUrl, {
  powersName: 'assets-host',
  resultName: 'assets-admin',
  env: { ENDO_FS_ASSET_SERVER_PORT: '8080' },
});

// 3. The serve-only facet as a formula of its own, so it is durable and can
//    be handed out by name.
await E(host).evaluate('@main', 'E(admin).publisher()', ['admin'], ['assets-admin'], 'assets');

// 4. Pin all three so they revive at boot and the routes come back before
//    anyone asks.
// 5. From anywhere holding `assets`: E(assets).serve(mountOrGitOrFilesystem)
```

## Embedding the library directly

`makeAssetServer` takes a platform HTTP `backend` and randomness as
injected powers, so it can be unit-tested with fakes and reused outside a
daemon. It is the whole server as one facet, retaining in memory;
`makeAssetServerKit` returns `{ admin, publisher, server }` and takes a
`store` (`retain`, `record`, `load`, `recall`, `release`) for an embedder
with somewhere durable to keep things — `makeEndoAssetStore(powers)` is the
one the daemon module uses:

```js
import { makeNodeHttpBackend } from '@endo/platform/http/node';
import { makeAssetServer } from '@endo/endo-fs-asset-server';

const server = await makeAssetServer({
  backend: makeNodeHttpBackend(),
  getRandomValues: bytes => globalThis.crypto.getRandomValues(bytes),
  port: 0,
});
```

## Security

- Capability paths carry 192 bits of entropy by default and are
  URL-safe base64 without padding.
- Request paths are rejected if they contain `.`/`..` traversal
  segments or NUL bytes, so a request can never escape the mount root.
  The lookup also walks strictly downward from the Filesystem root, and
  endo-fs's own `Directory.lookup` independently rejects traversal
  segments — defense in depth.
- **The capability lives in the URL path.** URLs leak through proxy and
  access logs, browser history, and the `Referer` header. Responses are
  sent with `Referrer-Policy: no-referrer` so a served page does not
  forward its capability path to third-party origins, but you should
  still treat the URL itself as a secret and avoid logging it.
- Responses carry `X-Content-Type-Options: nosniff`, and unknown
  extensions fall back to `application/octet-stream`. Even so, serving
  **untrusted** content means that content runs in the server's origin
  (`http://host:port`) — prefer a dedicated origin per trust domain and
  consider a reverse proxy that adds a `Content-Security-Policy`.
- The server binds to loopback by default. Exposing it on other
  interfaces (`ENDO_FS_ASSET_SERVER_HOST=0.0.0.0`) means the capability
  paths are the only thing standing between a client and the served
  bytes. Because the default origin is plaintext `http://`, the token
  would transit the network in the clear — only expose a non-loopback
  bind behind TLS-terminating infrastructure, and set
  `ENDO_FS_ASSET_SERVER_PUBLIC_BASE` to the public `https://` origin.
- The server keeps, uses and hands out (`getTarget`) only a read-only
  facet of what it serves, so neither a request nor an administrator can
  write through a route. For a Mount or a Git worktree that facet is a
  read-only formula the daemon enforces. A `Filesystem` is retained as
  given and wrapped in `@endo/platform/fs/extended`'s `readOnly`
  attenuator at every use, so mount it with `ENDO_FS_READ_ONLY=1` when the
  retained capability itself must not write. A read-only tree also avoids
  the `Content-Length`-vs-body race that a file mutated between stat and
  read would otherwise cause (the server aborts such a response rather
  than sending a truncated body).
- **At rest.** A route's token is stored in the record the server keeps in
  its own host agent's pet store, so the administrator can be shown a URL
  again. Whoever can read that store can already reach the retained
  capabilities themselves. The `id` that revokes a route is 128 random
  bits, is never part of a URL, and is known only to the publisher that
  was handed it and to the administrator.
- **Facets.** Hand out `publisher()`, never the administrator. A publisher
  cannot list, and cannot release or describe a route it was not given the
  `id` of. The administrator cannot serve or repoint; its one mutation is
  removal.
