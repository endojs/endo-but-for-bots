# @endo/cockpit

The garden cockpit — a harness-host web application that operates the garden
under capability-confined agent threads. It implements
[`designs/garden-cockpit.md`](../../designs/garden-cockpit.md).

> **Codify authority in the harness, not the prompt.**

A thread is a running agent that holds only the Endo capabilities bound to it.
A builder thread that was never handed a writable `git` cap cannot push — not
because its prompt forbids it, but because there is no `git` object in its
scope that can.

## Run it

No LLM, no monorepo install required: the default engine is a deterministic
mock.

```sh
node bin/cockpit.js      # → http://localhost:7610
```

Open the page, select the **tracer** thread, and ask it `what branch?`. The
agent runs `execute → E(git).currentBranch()` and the answer streams back. Then
open the cap view, **revoke** the thread's `git` cap, and ask it to `push` — it
becomes literally unable to, because the cap left its scope.

## The spine

| Garden concept | Cockpit concept | Code |
| --- | --- | --- |
| a **role** | a **template** (powerless `define` output) | `src/backend/templates.js` |
| a **dispatch** | a **thread** (powered `make` instance) | `src/backend/thread.js` |
| **authority by prose** | **caps in lexical scope** | `src/backend/caps.js` |
| delegation | subset-attenuated child threads | `src/backend/registry.js` |

## Layout

- `src/backend/caps.js` — the capability model; subset attenuation (no minting).
- `src/backend/engine.js` — per-thread engine: a mock plus an `@endo/agentry` adapter.
- `src/backend/thread.js` — a running thread, its scope, transcript, and o11y.
- `src/backend/registry.js` — the thread tree, `delegateCodeMode`, revoke propagation.
- `src/backend/templates.js` — the Builder-Mode template store.
- `src/backend/o11y.js` — token / turn / cost aggregation.
- `src/backend/steward.js` — the steward-view surface.
- `src/backend/server.js` / `ws.js` — http + a dependency-free websocket front end.
- `public/` — the boring no-build SPA.

## Milestones

- **M0** tracer — websocket, one thread, read-only git, the `what branch?` demo.
- **M1** thread registry — N threads, switch / steer / spawn-child via delegation.
- **M2** cap view — see / grant / revoke caps, the new-thread form.
- **M3** Builder Mode template editor, observability, steward view, journal export.

## Status

Private to the endo monorepo, pre-1.0, single-user / localhost. The mock engine
is the default; the `@endo/agentry` engine (real code-mode runtime) loads when a
provider is configured. `pi`-confined hosting follows the code-mode plan's
confinement milestone 2.
