# @endo/cockpit

The garden cockpit — a harness-host web application that operates the garden
under capability-confined agent threads. It implements
[`designs/garden-cockpit.md`](../../designs/garden-cockpit.md).

> **Codify authority in the harness, not the prompt.**

A thread is a running agent that holds only the Endo capabilities bound to it.
A builder thread that was never handed a writable `git` cap cannot push — not
because its prompt forbids it, but because there is no `git` object in its
scope that can.

## Run it (offline, mock engine)

No LLM, no daemon required: when no Endo daemon is reachable the cockpit runs
OFFLINE on a deterministic mock engine.

```sh
node bin/cockpit.js      # → http://localhost:7610
```

Open the page, select the **tracer** thread, and ask it `what branch?`. The
agent runs `execute → E(git).currentBranch()` and the answer streams back. Then
open the cap view, **revoke** the thread's `git` cap, and ask it to `push` — it
becomes literally unable to, because the cap left its scope.

## Run it for real (online, agentry engine)

When a live Endo daemon is reachable the cockpit goes ONLINE and can build real
`@endo/agentry` code-mode threads that run an LLM against live Endo
capabilities. This needs three things outside the cockpit:

1. **A running Endo daemon.** Start one with `endo start` (or let any `endo`
   command start it). The cockpit attaches to the same socket the CLI uses
   (`whereEndoSock`, honoring `ENDO_SOCK`); it never starts the daemon itself.
2. **Workspace and git caps already in the petstore, by pet name.** The agentry
   engine resolves a `workspace` (an `@endo/endo-fs` Filesystem) and a `git`
   (an `@endo/exo-git` Git capability) by the pet names you give the thread
   (default `workspace` / `git`). Provision them with the Endo CLI the usual
   way before creating a thread.
3. **A provider profile** — a `(provider, apiKey, baseUrl)` tuple. Add one
   either in **Builder Mode → Provider profiles** (the apiKey is stored in the
   daemon petstore and never echoed back to the UI), or with the CLI:

   ```sh
   endo store --json '{"name":"openai-main","provider":"openai","apiKey":"sk-…","baseUrl":"https://api.openai.com"}' \
     cockpit-profiles/openai-main
   ```

Then:

```sh
endo start           # bring up the daemon
node bin/cockpit.js  # prints "ONLINE — daemon at <sock>"
```

In the page, the header shows **● online**. Open **+ new thread**, pick a
provider profile, type a model name (e.g. `gpt-4o`), set the workspace and git
pet names and the git mode, give it a task, and create it. The thread runs a
real code-mode turn; tool-calls, tool-results, and tokens stream into the
transcript. This needs a live daemon **and** a real provider key — it is not
exercised by the test suite.

### Live-revoke limitation

For an **agentry** thread the workspace/git capabilities are resolved by pet
name and bound into the agent's Compartment at creation time. Revoking a cap
from a *running* agentry thread therefore cannot retract it mid-turn — the
revoke takes effect at (re-)creation, not mid-run. The **mock** engine, which
re-reads the live scope every turn, does honor mid-run revoke; that difference
is intrinsic to a real Compartment-bound runtime.

## The spine

| Garden concept | Cockpit concept | Code |
| --- | --- | --- |
| a **role** | a **template** (powerless `define` output) | `src/backend/templates.js` |
| a **dispatch** | a **thread** (powered `make` instance) | `src/backend/thread.js` |
| **authority by prose** | **caps in lexical scope** | `src/backend/caps.js` |
| delegation | subset-attenuated child threads | `src/backend/registry.js` |

## Layout

- `src/backend/caps.js` — the capability model; subset attenuation (no minting).
- `src/backend/daemon.js` — attach to a running Endo daemon; OFFLINE fallback.
- `src/backend/engine.js` — per-thread engine: a mock plus the real `@endo/agentry` code-mode adapter.
- `src/backend/profiles.js` — provider profiles in the petstore; masked reads (the apiKey never leaves the host).
- `src/backend/thread.js` — a running thread, its scope, transcript, and o11y.
- `src/backend/registry.js` — the thread tree, `delegateCodeMode`, revoke propagation, agentry-thread construction.
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
is the OFFLINE default; the `@endo/agentry` engine (real code-mode runtime)
becomes the default once a live daemon is reachable and an agentry thread names
a provider profile. `pi`-confined hosting follows the code-mode plan's
confinement milestone 2.
