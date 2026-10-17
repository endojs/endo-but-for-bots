---
'@endo/ocapn': major
'@endo/thixotrope': patch
'@endo/goblin-chat': patch
'@endo/ocapn-iroh': patch
---

`@endo/ocapn` core no longer runs the `op:start-session` handshake.
The handshake moves to a network adapter, `makeStartSessionNetwork` from the new export `@endo/ocapn/netlayer/start-session`, which connect-style netlayers (`@endo/ocapn/netlayer/tcp-testing`, `@endo/ocapn/netlayer/ws`, iroh, the thixotrope durable netlayer) compose.
The same export provides `makeSelfIdentityFromPrivateKey`, which rebuilds a session's self identity from a persisted private key so a durable netlayer can resume sessions.

Breaking changes in `@endo/ocapn`:

- A network factory now receives `SessionHandlers` (`adoptSession`) instead of `NetlayerHandlers`.
- The `captpVersion` option moves from `makeOcapn` to the adapter; passing it to `makeOcapn` throws.
- `makeOcapn` refuses a `connect`-only network at construction.
- A `provideSession` that resolves `undefined` now rejects instead of falling back to a plaintext hello.
- `OcapnNetwork` loses `connect`, `sendSessionHandshake`, and `handleSessionHandshake`, and `ClientDebug` loses `captpVersion`.
- `SessionManager` loses its connection-tracking methods (`getOutgoingConnection`, `getPendingSessionPromise`, `getSessionForConnection`, `makePendingSession`, `deleteConnection`, `rejectPendingSessionForConnection`), and `resolveSession` now takes `(locationId, session)`.

To migrate, wrap the existing netlayer factory: `makeOcapn({ codec, network: makeStartSessionNetwork(factory, { codec, captpVersion }) })`.
The wire is unchanged.

`@endo/goblin-chat` and `@endo/thixotrope` compose the adapter internally; their public APIs, including goblin-chat's `captpVersion` option, are unchanged.
Callers passing `makeIrohNetlayer` from `@endo/ocapn-iroh` to `makeOcapn` must now wrap it in `makeStartSessionNetwork`.
