# Gateway extensions

Later milestones extend the chat gateway by adding a file here, never by
editing an M3 file (`designs/m3-interfaces.md` D-M3-4, section 6.1). The
gateway (`../extensions.js` `loadGatewayExtensions`) loads every `*.js` in
this directory in name order when the agent-host adapter starts. Files are
loaded synchronously with `require`, so a file may not use top-level
await. A file that throws while loading, has no `gatewayExtension` export,
or exports one of the wrong shape is logged and skipped; the gateway still
serves.

A file is named for what it serves, not for the milestone that adds it.
The extension's `name` stays what it was (`m4-secrets`): renaming the file
(F2, HR-SYN-1) changed no name.

| file | serves |
|---|---|
| `secrets.js` | `SecretWriter.replace` as a large call (M4) |
| `speech.js` | the `speech` extras service (`Speech`, `AudioPort`), the `/audio` upgrade route, the capture worklet's `http` route and `Speech.replay` as a large call (M11, `designs/m11-interfaces.md` 3.2, 4); it receives `readGrant` |

## The export

```js
/** @type {import('../protocol.js').GatewayExtension} */
export const gatewayExtension = {
  name: 'm4-secrets',
  services: [{ label, make(context) }], // optional
  routes: [{ kind: 'http' | 'upgrade', path, handle }], // optional
  largeCalls: [{ target(context), methods }], // optional
  csp: { directive: [sources] }, // optional
};
```

- `services`: `make(context)` is called once per adapter incarnation and
  answers an exo with its own interface guard. Every signed-in page
  receives it in `GatewayPowers.extras` as `{ label, service }` (at most 32
  services in all; a label already taken is skipped). The bridge's frame and
  key guards apply to calls on it like on any other target.
- `routes`: exact paths. `/`, `/ws` and `/assets/*` are the gateway's own;
  a path an earlier file took makes the later file invalid. An `upgrade`
  route does its own authentication (M11's `/audio` uses a capability token
  minted through an extras service).
- `largeCalls`: `target(context)` is awaited once per incarnation, after
  `whenAttached`; the frame guard then lets the named methods of that very
  object (compared by identity) take arguments over `frameBytes`, up to
  `wsMessageBytes`. M4's `secrets.js` is
  `{ name: 'm4-secrets', largeCalls: [{ target: context => context.secretWriter(), methods: ['replace'] }] }`.
- `csp`: sources added per directive; nothing removes one.

## The `GatewayContext`

What `make` and `target` receive (`../protocol.js` `GatewayContext`),
objects of this adapter incarnation, none a vat facet:

| property | what it is |
|---|---|
| `live` | the incarnation's `Live` |
| `composer` | the incarnation's `Composer` |
| `content` | the incarnation's `Content` |
| `history()` | the incarnation's `History` |
| `whenAttached(callback)` | runs `callback` once the agent host is attached (blobs and secrets work from then on) |
| `secretWriter()` | the incarnation's one `SecretWriter`, the same object a page gets from `SecretsAdmin.openWriter()`; call it only after `whenAttached` (before, it rejects) |
| `stateDir` | the daemon's state directory (read only) |
| `log(event)` | a structured log line; never a message body, a secret or a URL fragment |
| `operator()` | the `Operator` presence the gateway was served with (`undefined` before `serve`); every extension |
| `readGrant(grant)` | reads a key through a `ReadGrant` in this process; only on the context of an extension listed by object in the gateway's `extensionPowers` (`AH/index.js`: `speech.js`, D-M11-22); every other extension's context has no `readGrant` |

Record keys a page sends to an extension service pass the gateway's key
guard only if they are in the vocabulary: a milestone admits its keys with
a table module listed in `guest/lib/vocabulary-tables.js` (HR-SYN-7;
`designs/m3-interfaces.md` section 6.3).
