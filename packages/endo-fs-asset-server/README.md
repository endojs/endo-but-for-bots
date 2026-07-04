# @endo/endo-fs-asset-server

Serve an [`@endo/platform/fs/extended`](../platform) `Filesystem` cap
over HTTP from a static asset server.

The server is built on the platform-agnostic HTTP server interface
[`@endo/platform/http/server`](../platform/src/http/server.js): this
package owns only the request *handler* (a pure `(request) => response`
function), while all socket I/O and response streaming live behind an
injected `backend`. The Node backend is
[`@endo/platform/http/node`](../platform/src/http-node/server.js)
(`makeNodeHttpBackend({ http })`); a non-Node embedder supplies its own
and the same handler runs unchanged.

The server is instantiated as an **unconfined formula** so it can hold a
real listening socket. Its formula value is an `AssetServer` exo. Each
`serve(filesystem)` call mints a fresh, unguessable **capability path**,
registers the Filesystem under it, and returns `{ path, url, revoke }`.
The mount serves **persistently until revoked** — the path keeps
resolving across any number of requests until you call `revoke.revoke()`
(or the server stops).

The token embedded in the URL path *is* the capability: there is no
other authorization check, so the path must stay secret.

## Shape

```js
const { path, url, revoke } = await E(server).serve(filesystem, {
  // optional: rebase the served root inside the Filesystem
  subPath: 'dist',
  // optional: directory index file name, defaults to 'index.html'
  index: 'index.html',
});

// GET ${url}style.css       -> 200, the file's bytes
// GET ${url}                -> 200, the index file
// GET ${url}missing         -> 404
// ... persists across requests ...

await E(revoke).revoke();
// GET ${url}style.css       -> 404
```

`E(server).getAddress()` reports `{ host, port, origin }` (useful when
the server was started on the OS-assigned port `0`).

## Instantiating the server

The unconfined entry point is `src/asset-server-module.js`. Configure it
through `makeUnconfined`'s per-formula `env`:

| env var | meaning |
| --- | --- |
| `ENDO_FS_ASSET_SERVER_PORT` | Port to listen on. `0`/unset asks the OS to assign one. |
| `ENDO_FS_ASSET_SERVER_HOST` | Interface to bind. Defaults to `127.0.0.1` (loopback). |
| `ENDO_FS_ASSET_SERVER_PUBLIC_BASE` | Origin to advertise in returned URLs when behind a proxy. |

```sh
# 1. Mount a host directory as a read-only Filesystem cap.
endo make --UNCONFINED \
  packages/platform/src/fs/extended/node-fs-module.js \
  --name site-fs --workerName @node \
  --env ENDO_FS_ROOT=/path/to/site --env ENDO_FS_READ_ONLY=1

# 2. Start the asset server.
endo make --UNCONFINED \
  packages/endo-fs-asset-server/src/asset-server-module.js \
  --name assets --workerName @node \
  --env ENDO_FS_ASSET_SERVER_PORT=8080

# 3. From a guest: E(assets).serve(siteFs) -> { path, url, revoke }
```

## Embedding the library directly

`makeAssetServer` takes a platform HTTP `backend` and randomness as
injected powers, so it can be unit-tested with fakes and reused outside a
daemon:

```js
import http from 'node:http';
import { makeNodeHttpBackend } from '@endo/platform/http/node';
import { makeAssetServer } from '@endo/endo-fs-asset-server';

const server = await makeAssetServer({
  backend: makeNodeHttpBackend({ http }),
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
- Wrap the Filesystem with `@endo/platform/fs/extended`'s `readOnly` attenuator (or
  mount it with `ENDO_FS_READ_ONLY=1`) so the server cannot be tricked
  into mutating the backing store. A read-only mount also avoids the
  `Content-Length`-vs-body race that a file mutated between stat and
  read would otherwise cause (the server aborts such a response rather
  than sending a truncated body).
