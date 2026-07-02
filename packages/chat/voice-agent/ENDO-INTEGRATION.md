# Endo integration — the two worlds (what's real, what's in-process, what isn't connected)

Canonical, code-grounded reference for how the **Agent C / voice-agent** system actually uses
Endo — written to stop the ocap claims from drifting in the memories and docs. Audited
2026-06-16 against the live tree; **re-audited 2026-07-02** (World-B files consolidated onto the
Iroh transport — see the migration note below).

## TL;DR

There are **two parallel ocap worlds in this repo, and they are not yet connected:**

- **World A — the voice-agent harness** (`packages/chat/voice-agent/`, `ocapn-noise/tool-bridge.mjs`):
  an **in-process, single-vat ocap system on SES + `Far`, with a web-key edge** (an unguessable
  bearer "swissnum" carried in the URL fragment over plain HTTP+JSON). Real attenuation /
  revocation / POLA — *within one trusted process*. No marshaling crosses a vat boundary.
- **World B — the OCapN distributed stack** (`ocapn-noise/imagegen-server-iroh.mjs`,
  `iroh-root.mjs`/keystone): **genuine distributed ocap** — `Far` objects **marshaled (CBOR) over
  an OCapN netlayer**, revocable + rate-limited, proven end-to-end (GpuLease, image-gen-as-capability,
  the keystone root). The transport is now **Iroh QUIC (dial-by-pubkey, no open ports)**; the
  original noise-over-TCP exemplars (`gpu-lease-server.mjs`, `imagegen-server.mjs`,
  `paid-capability.mjs`, `noise-root.mjs`) have since been removed or migrated onto the Iroh
  netlayer — see `ocapn-noise/IROH-MIGRATION.md`. Everything **above** the transport (marshal,
  attenuation, revocation, swissnums) is unchanged by that swap.

Same object discipline (`Far`) in both. The difference is whether a **vat boundary is actually
crossed by a marshal codec + netlayer**. In World A it never is; in World B it is.

The voice agent's GPU image tool is the clean illustration: it lives in World A and calls the
GPU **directly over HTTP**, even though World B has a real marshaled `GpuLease` for exactly that
resource. They're two code paths to the same GPU box — unintegrated.

## World A — the voice-agent harness (in-process + web-key)

**What it imports from Endo** (audited — the package *declares* the whole `@endo/*` suite, but
the harness actually uses three):

| Used | Count | Role |
|---|---|---|
| `@endo/init` + `harden()` | 225× | SES lockdown: frozen intrinsics, tamper-proof cap objects |
| `Far()` from `@endo/marshal` | 27× | Tools/affordances/management surface are hardened Far remotables, one verb each |
| `E()` from `@endo/eventual-send` | 1× | Dispatches the management cap on `/rpc` |

**Not used:** `makeExo`/`M.interface` (bare `Far`, no interface guards), `@endo/captp`,
`@endo/daemon`, `@endo/ocapn`, netstring/CBOR marshal, petnames, formulas. (`makeExo`,
`M.interface`, `passStyle`, `makeCapTP`, `@endo/daemon`, `petname`, `formula`, `Passable` all
grep to **0** in the harness.)

**How the cap model really works** (`agent-caps.mjs`):

- A **swissnum is `crypto.randomBytes(16).toString('hex')`** (`agent-caps.mjs:67`) — a 128-bit
  bearer secret, **not** an Endo formula id / content-addressed web-key.
- `locator = new Map()` (`:350`) resolves `swissnum → node` **server-side**. A "node" holds a
  `Set` of power-name strings + bindings.
- `toolboxFor(powers)` builds an object of `Far` caps for exactly that node's powers. **The
  confinement is this**: the LLM emits a tool name; the dispatcher does `toolbox[name]`; only
  names present resolve, everything else is denied. The model can emit any string, but its
  *authority* is bounded by object reference, not by prompt. This is the one genuinely strong,
  genuinely-Endo claim, and it holds.
- `share()` mints a new swissnum + a child node with a **subset** of powers (real attenuation);
  `revoke()` drops it from the registry (real revocation); delegation is **intersection-only,
  META_POWERS stripped, one level deep** (real monotonic attenuation). All in-process node
  objects in a `Map`, addressed by a bearer hex over HTTP.
- SES is load-bearing, not decorative: `harden`/lockdown make the cap objects tamper-proof, so
  "the toolbox is the authority" survives hostile tool *inputs* (a tool result can't monkeypatch
  a shared intrinsic to escalate).

**The honest caveat:** the tools are **marshal-ready `Far` objects that never get marshaled.**
The browser holds a bearer *string*, not a live presence; the server re-resolves it to an
in-process object per request. This is Waterken-style **web-keys on a hardened-JS substrate**,
not CapTP/OCapN. The confinement is enforced by JS lexical scope + a `Map` in one trusted
process — sound for the threat model (bound a probabilistic model's tool reach), but it is not a
membrane between mutually-suspicious vats.

**Where Endo is absent entirely in World A:**
- The **voice pipeline** (mic → VAD → `/stt` whisper → agent → `SpeechSynthesis` TTS): plain
  WebAudio + HTTP. The swissnum gates `/chat`; the audio path is not ocap. "Barge-in as
  retraction" is an `AbortController`.
- **Garden skills:** not integrated (no `skills/` library yet; roadmap #4).
- The **Blacksmith** (`claude -p` dev-agent): bwrap filesystem + a token; **no caps cross** the
  boundary (the `@endo/genie` "endow a spawned tool" seam is the gap — see `ENDO-GIT-REMOTE.md`).

## World B — the OCapN/Noise stack (real marshaled objects)

`ocapn-noise/imagegen-server-iroh.mjs` / `iroh-root.mjs` (and their migration templates) import the
real wire:

```js
import { makeOcapn } from '@endo/ocapn';
import { cborCodec } from '@endo/ocapn/cbor';                  // the marshal codec
import { makeOcapnNoiseNetwork } from '@endo/ocapn-noise';     // the netlayer
import { makeIrohTransport } from '@endo/ocapn-noise/transport/iroh';  // dial-by-pubkey QUIC
```

So the vended facets are `Far` objects **marshaled with CBOR and transmitted over an OCapN netlayer
between vats**, with revocation + rate-limiting. This is a genuine cross-vat marshal boundary —
capability objects passing over the network. Proven end-to-end: GpuLease
(time-boxed/rate-limited/revocable GPU render), image-gen-as-capability (`imagegen-server-iroh.mjs`),
and the keystone root (`iroh-root.mjs`). The transport is **Iroh QUIC**: `iroh-root.mjs` is a
deployable root node with **zero TCP listeners** (asserted via `ss` in `test/iroh-root.test.js`),
and `test/iroh-captp.test.js` round-trips a real `@endo/ocapn` `E(greeter).hello()` over it through
the **unchanged** `makeOcapnNoiseNetwork`+`makeOcapn` stack. QUIC also dissolves the 65519-byte Noise
message ceiling (a 200 KB single frame round-trips), so the chunked bytes-reader workaround is no
longer required on iroh-backed caps. *(The prior noise-over-TCP files — `gpu-lease*.mjs`,
`imagegen-server.mjs`/`-dial.mjs`, `paid-capability.mjs`, `noise-root.mjs` — are no longer in the
tree; the GpuLease/paid-capability designs were proven on that substrate and have since been
consolidated. See `ocapn-noise/IROH-MIGRATION.md`.)*

> Footnote on terminology: this is `@endo/ocapn` — the **newer** OCapN stack (CBOR) — not the
> classic `@endo/captp`/netstring **daemon** stack (which the project also doesn't run). "CapTP"
> in loose speech means the OCapN protocol here.

## The two-worlds map

| | World A — voice-agent harness | World B — OCapN/Noise stack |
|---|---|---|
| Lives in | `packages/chat/voice-agent/`, `tool-bridge.mjs` | `packages/ocapn-noise/` |
| Endo libs | `@endo/init`, `Far`, `E` (1×) | `@endo/ocapn`, `@endo/ocapn/cbor`, `@endo/ocapn-noise` |
| Object discipline | `Far` remotables, `harden` | `Far` remotables, `harden` |
| Vat boundary crossed? | **No** — single process | **Yes** — between vats over the wire |
| Marshal codec | none (objects never serialized) | **CBOR** (`@endo/ocapn/cbor`) |
| Transport | HTTP+JSON (browser ↔ server) | **OCapN netlayer — Iroh QUIC** (dial-by-pubkey; formerly Noise/TCP) |
| The "cap" on the wire | a **bearer swissnum** (random hex), re-resolved server-side | a **live remote presence** (a real reference) |
| Identity | random-hex web-key in a `Map` | OCapN keyId / sturdyref |
| Attenuation / revocation | real, in-process | real, across the boundary |
| Proven examples | notes/web/images/HA/agents tools, share/revoke | GpuLease, imagegen, paid-capability, keystone |

## The gap (and the proof)

The two worlds are **now partially bridged** — one power crosses, most do not:

- **Bridged (2026-07-02):** the voice agent's `objects` power holds real remote presences —
  `iroh-objects.mjs` (in `voice-agent/`, so the harness now *does* import from `ocapn-noise/`
  beyond `tool-bridge.mjs`) **dials endo-iroh refs over the Iroh transport** (`src/iroh-dialer.js`),
  lazy-loaded so the native binding can't crash server boot. This is the harness genuinely holding a
  marshaled cross-vat cap — the first realized "Bridge" below (`objects`, not yet `images`).
- **Still in-process:** the `images` power (`Far('Images', …)` in `agent-caps.mjs`) calls
  `generate()` imported from `GPU_IMG_GEN` (defaults to `/home/dan/gpu-img/gen.mjs`), which just
  `fetch`es ComfyUI at `http://192.168.50.226:8188`. **In-process Far facet → direct HTTP. No
  lease, no OCapN, no marshal.** Migrating this to a dialed GpuLease-style cap over iroh is Bridge #1.

So: the project *does* marshal capability objects over the boundary, and the harness now consumes
**some** of them over the wire (`objects`); the GPU-image path specifically still runs in-process.

## Bridges — how World A joins World B (the integration roadmap)

Each bridge turns an in-process World-A facet into a real marshaled World-B capability:

1. **`images` → dialed `GpuLease` over OCapN** (the first, cleanest bridge). The `images` power
   stops calling `gen.mjs` directly and instead **holds a `GpuLease` presence dialed over
   Noise** — so the agent's GPU authority becomes an actual time-boxed, rate-limited, revocable,
   *marshaled* cap. Proves the harness can hold a remote cap end-to-end.
2. **Toll-bridge purse → marshaled `paid-capability`** (exact parallel). The in-process stub
   ledger (`purse.mjs`, Inc 1) becomes a `paid-capability.mjs` purse vended over the wire —
   `charge({amount,payee})` behind the same interface (see `SELF-IMPROVEMENT-ROADMAP.md` D1/D5).
3. **Blacksmith → cap-endowed** via the `@endo/genie` seam, so a spawned dev-agent *holds a cap*
   (e.g. a git-remote `contributor` facet) instead of a filesystem + token (see
   `ENDO-GIT-REMOTE.md`).
4. **Endo git-remote object over OCapN** — git/PR rights as a passable, attenuable cap
   (submitPR-but-not-merge), the GitHub-like API with no GitHub.
5. **Iroh transport under all of it** — **LANDED (2026-07-02).** `@endo/ocapn-noise/transport/iroh`
   (`src/transports/iroh.js`) is a real, proven transport plugin: dial-by-EndpointId QUIC bidi stream,
   **no host:port**, stable EndpointId from a persisted 32-byte seed, `@number0/iroh` as an
   optionalDependency. Real ocap round-trips over it (`test/iroh-captp.test.js`), `iroh-root.mjs`
   listens with **zero TCP ports**, and the live voice-agent `objects` power already dials endo-iroh
   refs (`iroh-objects.mjs`, lazy-loaded). Sits **beneath** the OCapN/ocap layer (marshal/attenuation/
   revocation unchanged); removes open ports → confined-slice egress safe. What remains is operational
   rollout of the rest of the fleet services. (memo `iroh_v1_service_transport`; `IROH-MIGRATION.md`.)

## Claims hygiene (how to describe this accurately)

- ✅ "The voice agent is an **in-process ocap system on SES + `Far`, with a web-key (bearer
  swissnum over HTTP) edge**. Attenuation/revocation are real within one process."
- ✅ "The project has a **real distributed-ocap stack** (`ocapn-noise/`): `Far` objects marshaled
  over OCapN/Noise — GpuLease, imagegen, paid-capability, keystone."
- ❌ "The voice agent passes capabilities over CapTP / the marshal boundary." — it does **not**;
  its tools (incl. `images`) run in-process and the wire is HTTP+JSON.
- ❌ "Runs on the Endo daemon / petnames / formula graph." — none of those are used anywhere.
