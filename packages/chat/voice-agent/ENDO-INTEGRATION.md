# Endo integration — the two worlds (what's real, what's in-process, what isn't connected)

Canonical, code-grounded reference for how the **Agent C / voice-agent** system actually uses
Endo — written to stop the ocap claims from drifting in the memories and docs. Audited
2026-06-16 against the live tree.

## TL;DR

There are **two parallel ocap worlds in this repo, and they are not yet connected:**

- **World A — the voice-agent harness** (`packages/chat/voice-agent/`, `ocapn-noise/tool-bridge.mjs`):
  an **in-process, single-vat ocap system on SES + `Far`, with a web-key edge** (an unguessable
  bearer "swissnum" carried in the URL fragment over plain HTTP+JSON). Real attenuation /
  revocation / POLA — *within one trusted process*. No marshaling crosses a vat boundary.
- **World B — the OCapN/Noise stack** (`ocapn-noise/gpu-lease*.mjs`, `imagegen-server.mjs`,
  `paid-capability.mjs`, `noise-root.mjs`/keystone): **genuine distributed ocap** — `Far`
  objects **marshaled (CBOR) over an OCapN/Noise netlayer**, revocable + rate-limited, proven
  end-to-end (GpuLease, image-gen-as-capability, the keystone noise root).

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

`ocapn-noise/gpu-lease-server.mjs` (and siblings) import the real wire:

```js
import { makeOcapn } from '@endo/ocapn';
import { cborCodec } from '@endo/ocapn/cbor';                 // the marshal codec
import { makeOcapnNoiseNetwork } from '@endo/ocapn-noise';    // the netlayer
import { makeTcpTransport } from '@endo/ocapn-noise/transport/tcp';
import { makeGpuLeaseController } from './gpu-lease.mjs';
```

So lease / controller / inventory facets are `Far` objects **marshaled with CBOR and transmitted
over an OCapN/Noise/TCP netlayer between vats**, with revocation + rate-limiting. This is a
genuine cross-vat marshal boundary — capability objects passing over the network. Proven:
GpuLease (time-boxed/rate-limited/revocable GPU render), image-gen-as-capability
(`imagegen-server.mjs`/`-dial.mjs`, with a chunked bytes-reader for the 65519-byte CapTP message
ceiling), the keystone noise root (`noise-root.mjs`), and the paid-capability synthesis
(`paid-capability.mjs`).

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
| Transport | HTTP+JSON (browser ↔ server) | **Noise/TCP netlayer** |
| The "cap" on the wire | a **bearer swissnum** (random hex), re-resolved server-side | a **live remote presence** (a real reference) |
| Identity | random-hex web-key in a `Map` | OCapN keyId / sturdyref |
| Attenuation / revocation | real, in-process | real, across the boundary |
| Proven examples | notes/web/images/HA/agents tools, share/revoke | GpuLease, imagegen, paid-capability, keystone |

## The gap (and the proof)

The two worlds **don't talk to each other**:

- The voice agent's `images` power is `Far('Images', …)` (`agent-caps.mjs:185`) whose `generate`
  calls `generate()` imported from `/home/dan/gpu-img/gen.mjs` (`:35`, `:190`) — which just
  `fetch`es ComfyUI at `http://192.168.50.226:8188`. **In-process Far facet → direct HTTP. No
  lease, no OCapN, no marshal.**
- World B has a real `GpuLease` for that exact resource — but **no voice-agent file imports from
  `ocapn-noise/` except `tool-bridge.mjs`** (the agent loop). The harness is not on the wire.

So: the project *does* marshal capability objects over the boundary (GpuLease et al.); the
**voice-agent harness specifically does not** — it consumes the GPU (and everything else) in-process.

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
5. **Iroh transport under all of it** — adopt upstream **draft PR #446** (`feat(daemon): iroh network
   transport — "dial keys, not IPs" + TLS`; branch `claude/iroh-endo-daemon-network-6xeoc1`): a daemon
   `EndoNetwork` transport (dial-by-NodeId QUIC+TLS, NAT traversal + relay) alongside TCP/libp2p/ws-relay,
   plus a CapTP write-serialization fix. Rebase/run it, then migrate GpuLease + the harness bridges onto
   it. Beneath the OCapN/ocap layer; removes open ports → confined-slice egress safe.
   (memo `iroh_v1_service_transport`.)

## Claims hygiene (how to describe this accurately)

- ✅ "The voice agent is an **in-process ocap system on SES + `Far`, with a web-key (bearer
  swissnum over HTTP) edge**. Attenuation/revocation are real within one process."
- ✅ "The project has a **real distributed-ocap stack** (`ocapn-noise/`): `Far` objects marshaled
  over OCapN/Noise — GpuLease, imagegen, paid-capability, keystone."
- ❌ "The voice agent passes capabilities over CapTP / the marshal boundary." — it does **not**;
  its tools (incl. `images`) run in-process and the wire is HTTP+JSON.
- ❌ "Runs on the Endo daemon / petnames / formula graph." — none of those are used anywhere.
