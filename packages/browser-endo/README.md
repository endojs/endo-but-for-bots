# Browser Endo

A shared browser peer runtime for hosted Chat and capability-endowed applications.
It uses the existing Ed25519-authenticated WebSocket relay, netstring CapTP,
Greeter/Gateway handshake, Endo locators, remote-control arbitration, and exo-streams.
It can import daemon objects and export browser objects that daemons adopt with
`adoptFromLocator()`.
It does not run Node workers or persist a daemon database in the browser.

## Build and test

Run `corepack yarn workspace @endo/browser-endo build`.
The `dist/runtime.js` ES module includes SES initialization and exports the runtime,
application connector, `E`, `makeExo`, `M`, and exo-stream reader helpers.
Copy the entire distribution when hosting it; use relative module imports.

Run `corepack yarn workspace @endo/browser-endo exec playwright install chromium`
once, then `corepack yarn workspace @endo/browser-endo test`.
Tests exercise actual browser WebSockets, two synchronized browser pages, a real
Endo daemon, relay authentication, bidirectional object sharing, cancellation,
reconnect races, duplicate submissions, and authority boundaries.

## Explicit application endowments

```js
import { connectApplication, parseApplicationConfig, E } from './runtime.js';

const connection = connectApplication(parseApplicationConfig(location.hash));
const { counter } = await connection.endowments;
const snapshot = await E(counter).snapshot();
```

The URL fragment contains `relay`, `relayDomain`, and named `cap.NAME` locators,
encoded with `URLSearchParams`.
Chat expects `cap.agent`; the example expects `cap.counter`.
Fragments are not sent in HTTP requests.
Never place capability locators in published source, query strings, analytics,
console output, or findings documents.
Static publication distributes code; a separately supplied fragment grants access.
Use trusted application code: it can exercise and forward its endowments.

Existing `gateway`/`agent` fragments remain supported through the same connector
for local development, Electron, and existing Android links.
New hosted links should use peer endowments.
The connector closes when any imported peer disconnects, even if the relay socket
remains open.
Reconnect by constructing another connection and obtaining fresh capabilities.
It never replays application operations.
Authentication, channel opening, and initial capability acquisition have deadlines.
An import deadline ends the runtime; recovery starts a new one.

## Peer imports and exports

```js
import { makeBrowserEndo, makeExo, M } from './runtime.js';
const runtime = makeBrowserEndo({ relay, relayDomain });
const object = await runtime.import(locator);
const local = makeExo('Echo', M.interface('Echo', {
  echo: M.call(M.string()).returns(M.string()),
}), { echo: text => text });
const localLocator = await runtime.export(local);
// Deliver localLocator through an authorized sharing channel.
// A daemon can call adoptFromLocator(localLocator, 'browser-echo').
```

Each running runtime gets a fresh, non-extractable Ed25519 private key.
No credentials or objects are automatically recovered from origin-wide storage.
Browser exports and retained imports last until `runtime.close()` or page loss.
Opening another tab creates an independent peer; a browser reload invalidates its
previously exported locators.
Persistent/shared browser identities would require a single socket owner and
appropriate origin isolation, and are outside this implementation.
Retention streams are restricted to the authenticated peer and start with a full
snapshot, including an empty one.
Unregistered browser peers do not create durable daemon retention records.
Disconnected peer controllers are evicted; retained handles resolve the current
connection when reused. Durable, agent-rooted retention remains a daemon concern.

Relay configuration is explicit.
The relay must use TLS, except loopback development connections.
This relay protocol authenticates clients to the relay; it does **not** encrypt
CapTP end to end.
Use a relay you trust with capability traffic, preferably on the daemon's host.
The application does not silently dial relay hints from an imported locator.
On the explicitly configured relay, a locator can name a hosting daemon's
transport identity separately from the object's agent identity. The original
object identity is preserved when requesting it from that daemon. These route
hints are part of the supplied capability, not proof that the transport owns an
agent identity. Chat obtains its migration route from its authenticated agent.

## Shared counter

The `counter-app/` example uses the same connector as Chat.
Provision `src/counter.js` as a daemon unconfined worker at
`projects/shared-browser-counter/counter` and share its locator. Create the
project directory with `provideDirectory(['projects', 'shared-browser-counter'])`
and pass that full counter path as `resultName`; keep future project objects
inside the same directory. Existing objects can be copied there and their old
alias removed without replacing the formula or restarting its worker.
The counter lives in that worker, so page reloads preserve its value; worker or
daemon restart resets it.
This example does not claim durable application storage.

- `snapshot()` returns `{ value, revision }` as bigints.
- `follow()` returns a closeable exo-stream with the current snapshot and updates.
  Slow readers may skip intermediate revisions, but receive the latest state.
- `makeIncrementer()` creates a client capability accepting `increment(sequence)`.
  Start at `1n` and advance sequentially; resubmitting the last sequence on the
  same capability returns its original result without incrementing again.
- After losing a connection, fetch a fresh snapshot and incrementer.
  Do not replay an uncertain increment on a new incrementer.
- Close readers when no longer needed.
  Disconnect rejects the exo-stream synchronization chain and cancels pending reads.

For agent-built frontends, provide this API contract, the runtime distribution,
and a separately delivered counter endowment.
Test two actual browser contexts against the same object, reconnect one, and check
that updates remain synchronized without duplicating an increment.
