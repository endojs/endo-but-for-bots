# @endo/fetch

The unconfined base plugin for outbound HTTP. It adapts the worker's ambient
`fetch` into a passable `Fetch` capability with **no** allowlist, rate cap, byte
cap, policy, persistence, or revival. Holding `Fetch` is holding direct network
authority.

`Fetch` is not for guests. An integration retains it and endows it, together
with a private state directory, to
[`@endo/confined-fetch`](../confined-fetch), which attenuates it into the
policy-bound `HttpClient` a guest may hold
([design](../../designs/endo-fetch.md)).

```mermaid
flowchart LR
    U["@endo/fetch"] -->|unfettered Fetch| I[integration]
    I -->|Fetch + fetch-store| C["@endo/confined-fetch"]
    C -->|HttpClient only| G[guest]
```

## Provisioning

```js
const fetch = await E(host).makeUnconfined(workerName, '@endo/fetch', {
  powersName, // unused; the plugin needs no powers
  resultName: ['@pins', 'fetch-base'],
});
```

`make(powers, context, { env })` ignores its powers and `env`; the authority it
exposes is the worker's own `fetch`.

## Surface

- `fetch(url, options?)` resolves to a passable record
  `{ status, statusText, ok, headers, url, body }`. `headers` is a record with
  lowercased names. `body` is a `CloseablePassableBytesReader`
  ([`@endo/exo-stream`](../exo-stream)), or `null` for a null-body response.
  `options` accepts `method`, `headers`, a string `body`, `redirect`
  (`'manual'`, `'follow'`, or `'error'`), and `cancelled`, an
  [`@endo/cancel`](../cancel) token whose rejection aborts the request and its
  body.
- `help()`.

## Bugs

See https://github.com/endojs/endo/issues.
