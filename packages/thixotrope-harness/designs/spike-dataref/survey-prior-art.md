# Spike S4: prior art and the security model for references to unread data

Research spike, lane `claude/thix-dataref`, unit S4. Not product code. Written 2026-11-18.

The question (owner, 2026-11-18): how can a Thixotrope vat hold, pass on, store and hand out a
reference to data (a secret, a large text, a file) without the bytes ever entering its heap, its
frames, its snapshot or its journal, with reading as the rare and possibly dearer case; and at which
layer (harness, hub and OCapN, Ironhorse engine and worker) does that belong.

This survey covers how other capability systems reference bulk or sensitive data, then states a
security model for our case and the principles the three designs (S1-S3 lanes) should satisfy.

**Evidence tags.** Every claim carries one:

- **[F]** read from a source fetched for this survey (listed in section 9 with its URL);
- **[C]** read from code or design files in this repository (file and function named);
- **[J]** a measurement recorded by the harness work (journal or design entry id given), not
  re-measured here;
- **[M]** recalled from memory; the source is named but was not fetched or not readable here;
- **[I]** my inference.

Nothing was measured in this unit.

---

## 1. Where we start: what the harness already does

The harness already follows "vats hold handles; adapters hold bytes" (architecture section 0, last
paragraph [C]). What exists, read from code:

| Object | Identity lives in | Bytes live in | How the adapter maps handle to bytes | Source |
|---|---|---|---|---|
| `Blob` (staged text over `inlineBytes`) | a durable exo minted by the agent-host **manager vat**, in batches of 32 (`AgentHostSink.mintBlobs`) | adapter file `<dir>/b<n>` | per incarnation a `WeakMap` presence -> `{ key, bytes, owner }`; after a restart `sink.resolveBlobs([blob])`, one manager crank per batch | `resources/agent-host/impl/blobs.js` header and `known`/`pending` maps [C]; architecture D-15 [C] |
| `Content` (reader for blobs) | adapter-local exo, one per incarnation | - | `read(blob, range)` -> `store.readPage` | `resources/agent-host/impl/content.js` `makeContent` [C] |
| `Secret`, `ReadGrant` | durable exos in the manager vat, each mapped to a store key `k<n>` in a manager `WeakMap` | the adapter's encrypted store | per incarnation `WeakMap` presence -> key, filled by `sink.resolveSecrets` / `sink.resolveGrants` | `resources/agent-host/impl/secrets/manager.js` `makeSecretsOps`, `keyOf`, `readKey` [C] |
| `SecretWriter` | adapter-local exo, one per incarnation | - | `replace(secret, value or sealed box, generation)`, resolves the `Secret` by the same amplification | `resources/agent-host/impl/secrets/writer.js` header [C] |
| `Backend` with `keyGrant` | manager vat | credential read by provider code in the adapter each round | `readKey(grant)` | m2-interfaces `BackendSpec` and `makeBackend` rows [C] |

Three properties of this arrangement matter for everything below:

1. **Passing a handle already copies no bytes.** The hub is a forwarding node that transcodes every
   frame and rewrites each embedded reference through per-session c-lists; it "holds no presences,
   no promises" and positions "are rows, not objects" (`packages/thixotrope/src/net/hub.js`, module
   comment [C]). A handle crossing the hub costs a c-list row, not its content. The cost of a
   reference is per reference (hub row, an import in the receiving vat's heap, a manager crank to
   mint or to re-resolve after restart), never per byte [C, I].
2. **Reading is rights amplification.** A `Blob` alone reads nothing; `Content` plus a `Blob`
   reads. A `ReadGrant` alone reveals nothing; provider code in the adapter, which holds the sink,
   turns it into a value. This is the E sealer/unsealer and KeyKOS brand pattern (section 2.5, 2.4)
   implemented with a `WeakMap` in the manager vat [C, I].
3. **Bytes that do enter a frame are copied many times.** An inbound frame is base64 in JSON on the
   duct and journaled as base64 (survey `core.md` 3.8 [C]); hardened at about 10 us per byte with a
   halt above 94,208 bytes at 50 M computrons (architecture fact 2 [J J-0190, J-0194]); frames bound
   for an adapter are written to the hub log in clear while queued (core candidate C-1 [J J-0164]);
   anything a vat keeps grows its snapshot about 3.3 bytes per character (architecture section 5
   [J]). `Uint8Array` and the emulated immutable `ArrayBuffer` are not passable into guests in this
   build (survey `reuse.md` [J]), although `byteArray` is a pass style the OCapN codec encodes as a
   Syrup bytestring (`packages/ocapn/src/codecs/passable.js` line 74 [C]).

So the owner's wish is not "invent references"; it is: make the reference the **cheap, uniform,
protocol-level** way to carry data, remove the per-handle crank and per-restart re-resolution costs,
and give it the security properties (attenuation, revocation, audit, comparison) in one place
instead of per resource. The prior art below is read with that in mind.

---

## 2. Prior art

### 2.1 Cap'n Proto RPC

- Capabilities are per-connection ids: a host gives a capability "an ID specific to the connection
  over which it was sent" [F capnp-rpc]. Same shape as our hub's c-list positions [C, I].
- Protocol levels: 1 references and pipelining; 2 persistent capabilities ("save" and "restore",
  only if the host supports saving); 3 three-party handoff; 4 reference equality ("join") [F
  capnp-rpc].
- Level 3: `Provide` makes a capability available to a third party, `Accept` picks it up, and a
  `ThirdPartyCapDescriptor` carries a `vineId`, "a proxy for the third-party object exported by the
  sender", so a simple implementation can keep forwarding through the sender until the direct path
  exists [F capnp-schema].
- Level 4 `Join` checks that several capabilities designate the same object and connects directly,
  bypassing proxies; it fails if they differ [F capnp-schema].
- **File descriptors ride beside messages.** `CapDescriptor.attachedFd` is an index into the file
  descriptors attached to the RPC message (0xff means none), mainly for `senderHosted`
  capabilities, for example to pass an open file to a sandboxed process; each descriptor may be used
  by at most one `CapDescriptor` and receivers should cap how many they accept [F capnp-schema].
- **Byte streams are an RPC pattern, not a data type.** `-> stream` methods are wire-compatible
  with `-> ()`; flow control is client side, using the socket send buffer as the window [F
  capnp-0.8]. Bulk data is moved by calling `write(chunk)` on a capability, not by a bytes
  descriptor.

**Lesson.** The protocol carries *references*; bulk bytes either move through calls on a stream
capability or, on one host, out of band as a kernel object (an fd) attached to a capability
descriptor. The attachment is the precedent for "bytes beside the frame, a position inside it" [I].
`Join` is the precedent for comparing two references without trusting the proxies they came
through.

### 2.2 Fuchsia Zircon handles and VMOs

- A handle is "a session or connection to a particular kernel object"; in the kernel it has three
  fields: object, rights, and the process it is bound to. Its number means nothing outside its
  process [F zx-handles].
- **Rights are on the handle, not the object**: one process can hold two handles to one object
  with different rights [F zx-handles].
- `zx_handle_duplicate` may keep the same rights or request a strict subset; asking for rights the
  source lacks is `ZX_ERR_INVALID_ARGS`; the source must hold `ZX_RIGHT_DUPLICATE` [F
  zx-duplicate]. `zx_handle_replace` makes an equivalent (possibly weaker) handle and invalidates the
  original [F zx-handles].
- **Transfer moves.** `channel_write` puts the handle "in transit", bound to the kernel; the reader
  binds it to its process; the sender loses it; a handle in transit when the channel dies is closed
  [F zx-handles].
- A VMO is the standard way to share memory between processes; `zx_vmo_read`/`write` or map it [F
  zx-vmo]. `zx_vmo_create_child` makes a snapshot (copy-on-write), a slice (a sub-range with direct
  access) or a reference child; `ZX_VMO_CHILD_NO_WRITE` drops the write right; creating a child
  requires `ZX_RIGHT_DUPLICATE` and `ZX_RIGHT_READ` on the source [F zx-vmo-child].

**Lesson.** Rights masks on the *handle* give attenuation without minting a new object, enforced by
the one party that maps handles (the kernel). Our hub is in the kernel's position: every reference
into or out of a vat is a hub row [C]. A rights field on a hub row (say `read`, `use`, `transfer`)
would be Zircon's model; a slice child is "read a range"; NO_WRITE is "read-only". Move-only
transfer is a property we do not have and probably do not want for data (sharing is the point), but
it is the right model for read-once grants [I].

### 2.3 Unix: SCM_RIGHTS and memfd sealing; Mach out-of-line memory

- `SCM_RIGHTS` passes "a reference to an open file description", much like `dup` into the
  receiver's table; the receiver gets a different number; at most 253 per message (`SCM_MAX_FD`);
  descriptors beyond the receiver's limit are closed [F unix7].
- `memfd_create` makes an anonymous RAM file; with `MFD_ALLOW_SEALING`, `F_SEAL_WRITE`,
  `F_SEAL_SHRINK`, `F_SEAL_GROW` and `F_SEAL_SEAL` let a receiver check (`F_GET_SEALS`) that the
  peer cannot change or shrink it, so it need not copy defensively against time-of-check-to-
  time-of-use changes [F memfd].
- Mach messages carry out-of-line memory as a logical copy that the kernel may share copy-on-write
  with no physical copy unless a side writes; the sender may ask for the region to be deallocated on
  send (a move); destroying a port destroys queued messages and their out-of-line memory [F mach]
  (search summary of Apple and GNU Mach documentation; the descriptor struct was not read).

**Lesson.** Two separate properties: *designation without copying* (fd, OOL region) and
*immutability the receiver can verify* (seals). For us, immutability is what makes a content digest
meaningful and lets any holder cache; a blob that can change behind its handle is a different,
weaker thing (a `Secret` with generations is deliberately mutable) [I]. The fd is also a reminder
that ambient numbering (the fd number) is safe because it is per process, exactly as our hub
positions are per session [I].

### 2.4 KeyKOS and EROS

From Hardy, "The KeyKOS Architecture" (text extracted from the fetched PDF) [F keykos]:

- **Number keys** "designate numbers and are convenient for keeping a few bytes of data in a slot.
  ... In fact the number (data) is in the key." This is the "data key" of the request: data carried
  inside a capability, unforgeable because only the number key creator makes one.
- **Sense keys**: a weaker key to a node such that any key fetched through it is the *sensory
  version* of that key: a node key becomes a sense key, a page key becomes the read-only page key,
  a segment key loses its keeper. "The holder of the sense key can browse through the structure but
  is unable to affect it." Read-only is transitive by construction.
- **Discrim** "compares two keys for equality": comparison is a capability in its own right, not
  ambient.
- **Brands**: a domain creator returns a domain's service key only for a domain it created "as
  determined by the brand"; the paper calls this "the primitive KeyKOS rights amplification
  mechanism".
- **Factories** create compartments that "collectively hold no unaudited, non-sensory keys that
  designate objects outside the compartment"; a factory can certify the discretion of another;
  this lets one run code that cannot disclose one's data.
- EROS generalises the sense key as the *weak* attribute: capabilities returned through a weak
  capability are reduced to read-only and weak, transitively [F eros-weak] (search summary of
  a Yale EROS verification paper and Shapiro's slides).

**Lesson.** (a) A reference to data can be a *sensory* reference: it lets the holder do things that
convey no authority to change or reveal more than permitted, and that property is transitive. "Can
reference but not read" is a further weakening below sensory (designate only). (b) Comparison
(Discrim) and amplification (brands) are explicit authorities. (c) Confinement (factory) is how a
system lets untrusted code *use* data without leaking it: the relevant question for an exec vat
that is given a secret to use [I].

### 2.5 E and Waterken

- E's sealer/unsealer pair: the sealer wraps a value in a box; only the matching unsealer opens it;
  holding a box conveys nothing; bringing box and unsealer together is rights amplification [M
  Miller 2006, "Robust Composition", chapter on rights amplification; the erights.org pages could
  not be fetched (certificate error)]. A community write-up confirms the shape: the sealer seals, only
  the unsealer unseals, and the term "rights amplification" is contested ("authority amplification"
  preferred by some) [F spritely-amp] [F c2-amp].
- Waterken's web-key: an https URL whose unguessable random part *is* the permission; the paper
  puts it in the URL fragment so browsers do not leak it in the Referer header; possession is
  access, and the link can be passed on as a bookmark [F webkey].
- Horton ("who done it"): wrap each grant so the receiver of a request learns which principal is
  responsible, giving audit and per-party revocation over plain ocap messages [M Miller, Karp,
  Donnelley, HotSec 2007, not fetched].

**Lesson.** The box/unsealer split is exactly our `Blob` + `Content` and `ReadGrant` + provider read
(section 1). It decouples *who may hold* from *who may open*, and the opener can live where the
bytes are. Web-keys show both the power and the risk of putting authority into a string: the
string must never travel where strings travel (logs, Referer, prompts) [I].

### 2.6 Agoric (ERTP, SwingSet virtual and durable objects, pass-style bytes)

- ERTP: a payment is an *object* that carries a right, not data; amounts describe assets but "are
  not assets"; a deposit consumes the payment ("deleted from its issuer's records"); a failed
  deposit changes nothing; mint, brand and issuer are fixed one-to-one [F ertp]. The issuer is the
  source of truth; a holder proves a payment is genuine by asking the issuer, not by inspecting it
  [F ertp, I].
- Virtual and durable objects: state is "backed up in secondary storage"; an idle object "need not
  occupy any memory within the executing vat"; state values must be serializable and are hardened
  when assigned; references to other virtual objects are persisted separately and loaded only when
  needed [F agoric-vo]. Virtual collections (`@agoric/vat-data`) are virtual by default and durable
  on request; durable kinds survive vat upgrade [F agoric-vatdata-search] (search summary; the npm
  page refused the fetch).
- Pass-style `byteArray` is an immutable `ArrayBuffer`, a pass style in this repository's
  `@endo/pass-style` (`packages/pass-style/src/byteArray.js`, `CHANGELOG.md` "Introduces support for
  `byteArray`" [C]). I recall earlier Agoric discussions naming a `copyBytes` pass style; this
  repository has no `copyBytes` (grep [C]); treat the name as historical [M].

**Lesson.** (a) "Rights not data" (ERTP) is the right frame for secrets: a vat holds a right to have
something done with a value, and the issuer (our store) is the source of truth. (b) Agoric moved
*object state* out of the heap into a syscall-backed store while keeping object *identity* in the
vat. That is the inverse of what we need for bulk data (identity cheap, bytes elsewhere), but it is
the precedent for "the vat holds an identity whose state the kernel stores" and for paging that
identity in only when used [I]. (c) Passable bytes solve *carrying* bytes, not *not carrying* them:
a `byteArray` in a message is still copied into the receiver's heap and journal [I].

### 2.7 Spritely Goblins and the OCapN drafts

- OCapN references are `desc:import-object`, `desc:import-promise`, `desc:export` and `desc:answer`
  positions per session; `desc:sig-envelope` wraps a signed object [F ocapn-captp].
- Third-party handoff: the gifter deposits the gift with the exporter's bootstrap under a random
  32-byte gift id; sends the receiver a signed `desc:handoff-give` (receiver key, exporter locator,
  gifter-exporter session id, gifter id, gift id); the receiver sends a signed
  `desc:handoff-receive` with a `handoff-count` to `withdraw-gift`; the exporter checks both
  signatures and that the count is fresh (replay); only the designated receiver should withdraw [F
  ocapn-captp]. Our hub uses these codecs and does handoffs "in the exporter role" (`hub.js` imports
  and module comment [C]).
- Release: `op:gc-exports` lists positions with a wire delta; the receiver decrements and may
  collect at zero [F ocapn-captp].
- **The drafts say nothing about bulk data**, size limits or streaming [F ocapn-captp, F
  ocapn-model]. `ByteArray` is an atom ("an array of 8-bit bytes", represented in JS as an
  `ArrayBuffer`, possibly immutable) with no maximum length [F ocapn-model].
- Open issues relevant here: #241 "Senders can impose large storage obligations upon receivers"
  (answer positions, gift ids and handoff counts of unbounded size) [F gh-241]; #20 backpressure
  (closed; no protocol way to state limits; Cap'n Proto's client-side flow control cited) [F
  gh-20]; #300 a per-pair symbol table (`op:register-symbol`, `desc:symbol n`) [F gh-300], which is
  the protocol-level relative of our 57,000-name table problem; #218 sturdyrefs in the model [F
  gh-218].
- Sturdyrefs: an `ocapn-sturdyref` is a peer locator plus a swiss number, and "should be
  considered a capability"; the information alone suffices to obtain a reference [F
  ocapn-locators]. That is a bearer token (inference from the text; the page avoids the word) [I].
  Our hub's bootstrap `fetch(swissnum)` answers from a publications table (`hub.js` `swissnumHex`,
  `publications` [C]).

**Lesson.** OCapN gives us exactly two kinds of reference: session-bound positions (not bearer) and
swiss numbers (bearer). There is no "reference to data" and no "bytes beside the frame". A protocol
extension here would be new ground, not adoption [F, I]. #241 and #300 show the working group
already treats receiver-side storage obligations and table growth as protocol concerns, which is
the framing our proposal would use [I].

### 2.8 Content-addressed references

- An IPFS CID "forms a kind of address based on the content itself", says nothing about where the
  content is, and any change yields a different CID [F ipfs]. The page does not discuss access
  control [F ipfs].
- Tahoe-LAFS: an immutable file's capability is derived from its content; for mutable files a
  read-write cap embeds a hash of the private key and a read-only cap a hash of the public key; a
  "validate" (verify) capability is strictly weaker than read; a repairer capability omits the
  decryption key; read-only directories are transitively read-only; delegation by passing the
  secret is irrevocable; servers store shares under a storage index that is a hash of the
  encryption key [F tahoe].

**Lesson.** A hash *names* content; it *authorises* nothing unless a store answers anyone who
presents it, at which point it is a bearer token with a twist: anyone who has or guesses the content
can compute it. For low-entropy secrets a digest is a **confirmation oracle**: holding
`sha256(secret)` lets a holder test guesses offline [I]. Tahoe shows how to derive a chain of
strictly weaker capabilities (write > read > verify > repair) by one-way functions, so attenuation
can be computed by the holder without asking the store; the price is irrevocability [F tahoe, I].

### 2.9 Macaroons and bearer tokens (the contrast)

- Macaroons are "bearer credentials" built from "nested, chained MACs" whose caveats "attenuate and
  contextually confine" when, where, by whom and for what purpose a request is authorised [F
  macaroons]. From memory: any holder can add a first-party caveat by extending the HMAC chain
  without contacting the issuer, and third-party caveats require a discharge from another service
  [M Birgisson et al., NDSS 2014; the abstract page did not state these].

**Lesson.** Holder-side attenuation without a round trip is what macaroons buy, and it is attractive
for "read a range" or "expires at". But a macaroon is a string: it leaks through logs, prompts,
error texts and the hub log (C-1) like any bearer token, and revocation needs issuer state anyway.
Inside one object system, an attenuated *object* is strictly better; bearer tokens belong only
where a reference leaves the object system (a URL for a browser, a credential sent to a provider)
[I].

### 2.10 Summary table

| System | What the holder has | Who can dereference | Attenuate | Pass on | Compare | Revoke | Bytes copied when passing |
|---|---|---|---|---|---|---|---|
| Cap'n Proto | per-connection cap id; optional attached fd | the host | new capability object | yes; level 3 direct | level 4 `Join` | host drops the export | none for caps; fd by kernel |
| Zircon | handle (object, rights, process) | the kernel on the holder's request, per rights | duplicate with fewer rights; VMO slice/NO_WRITE child | move through channel | koid (not fetched) [M] | close handles; no general revoke [M] | none (VMO shared or COW) |
| SCM_RIGHTS / memfd | fd (open file description) | the kernel | seals (on the object, not the fd) | dup into receiver | none built in | none once passed | none |
| Mach OOL | logical copy of a region | the receiver owns its copy | - | in message | - | - | COW, physical copy only on write |
| KeyKOS / EROS | key: number key holds data; page/node/sense keys | the kernel | sensory / weak versions, transitive | yes | `Discrim` | via indirection (not fetched) [M] | none |
| E / Waterken | sealed box; web-key URL | unsealer holder; anyone with the URL | wrapper objects | yes | sealer brand; URL equality | caretaker; server-side key table | none |
| Agoric ERTP | payment / purse object | issuer | split payments | yes; deposit consumes | issuer `isLive` [M] | issuer | none |
| OCapN | session position; swiss number | the exporter | wrapper objects | handoff (signed) | none in the drafts | export dropped | none for refs; inline `ByteArray` copied |
| CID / Tahoe | hash; derived cap strings | the store (anyone who presents it) | one-way derivation (Tahoe) | as text | equality of strings | none (Tahoe: irrevocable) | none |
| Macaroon | HMAC-chained string | the issuer, checking caveats | holder adds caveats | as text | string equality | issuer-side state | none |
| Harness today | durable exo minted by manager vat | adapter, after amplification through the manager | mint a new exo (grant) | as a presence via hub rows | presence identity within one session | store flag per secret | none; per-handle crank costs |

---

## 3. A taxonomy for our case

All the systems above reference data in one of three ways [I]:

1. **Designation in a mediated table** (fd, Zircon handle, KeyKOS key, OCapN position, our hub row):
   the holder has a number meaningful only in its own table; a trusted mediator maps it; transfer
   goes through the mediator. Unforgeable, holder-bound, not bearer.
2. **Authority in a string** (swiss number, web-key, macaroon, readable hash): transferable as
   text, anywhere; bearer; leaks wherever strings go.
3. **Data in the reference** (KeyKOS number key, inline `ByteArray`): the bytes travel; no store.

For a vat, (1) is what we want, the mediator is the hub, and the store is an adapter. Our current
handles are (1) built from *two* mediators (hub rows plus a manager-vat `WeakMap`), which is where
the per-handle manager cranks and the restart re-resolution come from (D-15 [C]). The design space
for the three lanes is roughly where the second mediator lives [I]:

- **In a vat** (today): durable, costs a crank to mint and after each restart to resolve.
- **In the adapter** with durable adapter exports: no vat crank; needs adapter-hosted references that
  survive an adapter restart, which Thixotrope does not have (adapter answers and imports break at
  restart, architecture fact 5 [C]).
- **In the hub** as a new kind of row ("data row": owner adapter, store key, rights, generation):
  the hub already persists rows and rewrites positions; a vat would hold a position to a data row
  exactly as it holds one to an object. This is the protocol-level option.

---

## 4. Security model: "can reference but not read"

### 4.1 Whose property is it?

It should be a property of the **reference's interface plus the absence of an amplifier**, enforced
by the **store**, and never a property of the holder's identity [I]:

- The reference (handle) designates. Its interface offers at most `describe()` (size, label,
  generation, kind) and nothing that returns content. `ReadGrant.describe` already follows this [C
  m2-interfaces].
- Reading needs a second authority, the reader (unsealer, `Content`, the provider's `readKey`
  path), that only the store can honour. Holding both reads; holding one does not. The store checks
  the pair; nothing checks *who* is asking.
- Holder-identity rules ("vat X may not read") are ACLs and reintroduce ambient authority. The
  blob provenance check (`owner`, `texts.blobNotOwned`, `blobs.js` header [C]) is such a rule; it is
  sound as defence in depth only while blobs are never shared across sessions on purpose. Once a
  design lets a session hand a blob to a subagent session, provenance must become "the reader was
  given this blob", which the pair model already gives [I].

Consequences: a vat can *store* and *pass on* a handle because it has no reader; giving a vat a
reader is a deliberate act (the exec vat gets `Content` per call, architecture D-11 [C]); a secret
reader never goes to any vat.

### 4.2 Passing on

Passing is passing the presence. Required: the hub moves a position, never bytes, and the receiving
vat gets a new import row. Costs per pass are per reference (hub commit growth, a row per exported
exo, architecture fact 9 [J]). Design consequences [I]:

- A design that mints one handle per use (per round, per page) makes the hub grow per use; prefer
  one handle per datum and attenuated children only when the rights differ.
- Passing to an adapter that then dereferences must not need a vat crank: today it does, once per
  handle per adapter incarnation (`keyOf` cache in `manager.js` [C]).

### 4.3 Attenuation

| Attenuation | Prior art | Object pattern that works today | What protocol or hub support would add |
|---|---|---|---|
| read-only / designate-only | KeyKOS sense key, Zircon rights, Tahoe read/verify | a handle with no read method; the reader is a separate object | a rights field on the data row, checked by the hub or store without a crank |
| read a range | Zircon slice child, Tahoe immutable cap per file | store mints a child handle bound to `{ parent, offset, length }` | same, as a row derived from a row |
| read once | Zircon move-only transfer, ERTP payment consumed on deposit | store marks the grant spent on first read; journal it before answering (intent before effect, architecture 4.3) | move semantics in the hub (the sender loses the row) |
| use but do not reveal (credential injected into a request) | KeyKOS factory confinement; ERTP "rights not data" | a `Backend` or `Requester` capability that was *bound at creation* to a grant and a destination; the vat calls `use(request)`; the adapter injects | none needed; the binding is the point |
| expires / caveats | macaroons | store-side check of a deadline recorded with the grant | nothing; the store is the issuer |
| verify only (equality, integrity) | Tahoe verify cap | a `Verifier` with `matches(otherHandle)` | `Join`-like equality in the hub |

Use-but-not-reveal is the important one for secrets, and it is a *binding* problem, not a
protocol problem (section 4.7) [I].

### 4.4 Comparing two references

Three different questions, and each has its own answer [I]:

1. *Same handle?* Within one holder, two presences of one exported object are the same JS object
   (the c-list maps a position to one import), so `===` and `WeakMap` keys work; the adapter caches
   rely on this (`keyOf` [C]). Across holders there is no comparison without a third party
   (Cap'n Proto level 4 `Join` [F], KeyKOS `Discrim` [F]).
2. *Same datum?* Two handles minted for the same file are different objects. If equality matters,
   the store answers it (`store.same(a, b)`), i.e. comparison is an authority.
3. *Same content?* A content digest answers it for anyone who holds the digest. Acceptable for
   non-secret staged text (`StagedText.digest`, used for duplicate submission checks, J-9363 [C]).
   **Never for secrets**: a digest of a low-entropy secret is an offline guess oracle; any comparison
   of secret contents must be a store method taking two handles and answering a boolean, and should be
   audited [I].

### 4.5 Revocation

- Revocation needs indirection the revoker controls: the store's entry (a revoked flag, as today:
  "a revoked secret fails every grant's next read", m4-interfaces 4.1 [C]), a caretaker object, or a
  hub row the owner can kill. Bearer strings cannot be revoked without issuer state (macaroons,
  Tahoe irrevocable delegation [F]).
- Granularity: today grants share the secret's store key, so revocation is per secret, not per
  grant (m4-interfaces 4.1 [C]). Per-holder revocation needs per-grant entries [I].
- A caretaker in a vat costs a crank per use; a store-side flag costs nothing on the vat path. For
  data references the flag belongs with the bytes (adapter store or hub row), not in a vat [I].
- Revocation is checked **at dereference**, every time (R4-82 "value read again every round" [C]),
  never cached past the check.

### 4.6 Auditing uses

- An ocap store sees *which grant* was used, not *who* used it. Meaningful audit therefore needs
  one grant per holder (Horton's lesson [M]), and the audit record names the grant (and through it
  the label the operator gave the holder), never a vat id the store looked up [I].
- Audit must record the dereference by the adapter on the holder's behalf, including the purpose
  (which round, which request), and must not record the value (today the store's audit file records
  read, replace, create, revoke, delete; m4-interfaces 3 [C]).
- If designs add `use` without `read` (injection), the audit event is the use, with destination.

### 4.7 Confused deputy risks when an adapter dereferences for a vat

Hardy's confused deputy: a program holding authority for its own purposes is induced to use it for
a caller's, because the caller *designated* the target by name and the deputy *authorised* the act
with its own rights [M Hardy 1988; the cap-lore.com page failed TLS verification]. Our adapters are
deputies: unconfined Node with the daemon user's authority (architecture section 6 [C]). Risks:

1. **Designation by name.** If any vat-reachable method accepts a store key (`k<n>`, `b<n>`), a
   file name, a label or a digest and the adapter resolves it with its own authority, any vat can
   read any datum. Today the keys travel only manager-to-adapter (`resolveSecrets` answers keys to
   the adapter; m4-interfaces rule 2 [C]) and `blobs.js` refuses any key not `^b[1-9][0-9]*$` [C].
   Rule: the vat designates by presenting the handle; the adapter never accepts a name from a vat.
2. **Caller-chosen destination.** "Use secret S in a request to URL U" with U from the vat (or the
   model) exfiltrates S to U. The destination must be bound when the use capability is minted
   (the `Backend` binds `baseUrl` and `keyGrant` at `makeBackend` [C]), not supplied per call.
3. **Values on the return path.** A deputy that returns the value, or an error quoting it, through
   the hub puts it in the hub log in clear (C-1 [J]) and in the vat journal. Dereferenced secret
   values must never be an answer to a vat-originated call; errors must name the grant, not echo
   content.
4. **Derived leaks.** Length, prefix, digest, timing, or "is this equal to X" answered for a secret
   are partial reads. `describe()` may expose bytes only for non-secrets; for secrets at most
   presence and generation [I].
5. **Cross-holder confusion.** An adapter that caches handle -> key per incarnation (`grantKeys`,
   `known`) must key the cache by presence, never by a value the vat chose, and must not let a
   handle minted for session A be dereferenced for session B *by B's request* unless B was given it.
   Under the pair model, B holding it means B was given it; the provenance check covers designs that
   do not yet trust that [I].
6. **Model-steered deputies.** The model can be prompt-injected. Whatever the model can name, it can
   be induced to use. The model's authority is therefore exactly the label map the session gives it
   (section 4.8); a secret reachable by label from the model is a secret any injected text can make
   the agent *use* (never read, if the rules above hold) [I].

### 4.8 Model-facing text labels

The owner's principle allows a name "where a human labels something, at a model's text boundary, or
where a reference leaves the object system" [request]. For a data reference the label is a
**petname**: meaningful to its holder, not authority by itself (Stiegler's petname systems, via
[F petname-wiki] and [F spritely-petnames]). Rules [I]:

- **May**: appear in the model's context; be chosen by a human; be resolved by the *session* through
  its own label map (the per-session table is the c-list analogue) to a handle the session already
  holds; differ between sessions for the same datum.
- **May not**: be resolvable by anyone else (no global label registry an adapter consults); be the
  store key, a digest, a path or a swiss number; carry the value or a prefix of it; be accepted by an
  adapter in place of a handle; be minted from content (a label derived from secret text leaks it).
- A label the model invents that is not in the map is an error, not a lookup elsewhere.
- Labels are text and may collide; the map is the authority, so a collision is resolved by the
  human who labels, never by "first match".

### 4.9 Persistence, restart, garbage collection and revocation

- **Identity must outlive the adapter incarnation**: vats persist across restarts; a handle in a
  vat heap must still designate the same datum after the adapter restarts. Today this is why handles
  are manager-vat exos, re-resolved after restart one manager crank per batch (D-15 [C]).
- **Keys must never be reused**: if a store key is reused after deletion, a stale handle in some
  vat's heap designates new data (ABA). Monotonic keys (`k<n>`, `b<n>`) with tombstones; a revoked
  or deleted entry stays as a tombstone so a later read answers "revoked" or "deleted", never
  "unknown" and never other data [I].
- **GC is late and must not be a security mechanism.** Finalizers and OCapN `gc-*` frames run at the
  next collection, up to 32 cranks later or at the first crank after a wake (architecture fact 1
  [J]); a sleeping vat that holds a handle may hold it for days. Deletion by GC is fine for
  reclaiming bytes of non-secret data; revocation and secret deletion must be explicit store
  operations, effective at the next dereference regardless of who still holds references [I].
- **Revocation must persist before it is acknowledged** (write the flag durably, then answer), and
  replay of a vat journal must not resurrect use: a vat's replayed send to "use grant G" reaches
  the store again only if the hub re-delivers it; the store must judge each use at the time it
  executes, so a replay after revocation fails [I].
- **Read-once grants and replay**: a vat may replay deliveries after a crash; the store's spent
  flag, not the vat's memory, is the truth. A read-once grant whose first read was answered but
  whose answer the vat never committed is spent; designs must say whether that is acceptable or make
  the read idempotent within a window [I].
- **Retired adapter incarnations**: a vat holding a handle into a dead adapter incarnation is not
  told (C-19 [J]). For data handles whose identity is durable (manager-minted or hub data rows) this
  does not matter; for adapter-local readers (`Content`, `SecretWriter`) it does, and holders must
  re-obtain them [C, I].

### 4.10 What needs protocol support, and what works with plain objects today

| Property | Plain object pattern today | Cost today | Needs core, hub or protocol work to improve |
|---|---|---|---|
| reference without bytes | exo handle; bytes in an adapter | a hub row per export; mint cranks (pre-minted 32 at a time) | no |
| read only with a second authority | amplifier `WeakMap` in the manager vat | one manager crank per handle per adapter incarnation | yes, to drop the crank: adapter-durable or hub-held identity |
| survive restart | manager-vat durable exo | re-resolve cranks after each restart | yes (same) |
| attenuation (range, read-only, once) | mint a child handle in the store | a crank and a hub row per child | optional: rights on hub rows (Zircon-like) |
| use-not-reveal | capability bound to grant and destination | none extra | no |
| compare | store method on two handles; digest for non-secret | an answered call | optional: hub-level `Join`/equality |
| revoke | store flag checked per dereference | none on the vat path | no |
| audit | store log per grant | none on the vat path | no |
| bytes beside a frame (bulk into an adapter-held store without a vat copy) | adapter writes the file and hands out the handle (D-15) | none in the vat; adapter-only path | yes, if a *vat* is to originate bulk bytes (exec results today go through `BlobWriter` in `frameBytes / 2` pieces, architecture section 6 [C]) |
| keep secrets out of the hub log | values never in frames to adapters; CLI seals to the adapter's key (D-6) | none | C-1 still open: any frame to an adapter is logged in clear while queued |
| tell a holder its reference died | none | - | yes (C-19) |

---

## 5. What the prior art suggests for each layer

- **Harness (objects only).** Everything in sections 4.1-4.8 except the crank and restart costs is
  achievable now: handle/reader split, bound use capabilities, store-side revocation, per-grant
  audit, child handles for ranges. The cost is the manager vat as the second mediator [C, I].
- **Hub and OCapN.** The hub is already a kernel-like mediator with durable rows (section 2.2
  lesson). A "data row" kind (owner session, store key, rights, generation) that the hub rewrites
  like any reference but that resolves to the owning adapter without a vat would remove the manager
  crank and the restart re-resolution. Toward non-Thixotrope OCapN peers it must look like an
  ordinary `desc:import-object` (the hub can export a data row as an object whose methods the owner
  adapter answers), so no wire change is needed between peers; the new thing is internal to the
  hub's tables and its adapter attach protocol [I]. A wire-level "bytes beside the frame" descriptor
  (Cap'n Proto `attachedFd`, Mach OOL [F]) is a separate, larger change and only matters if vats
  must originate bulk bytes [I].
- **Engine and worker.** The engine is where bytes cost most (per-byte `harden`, C-5 [J]). An
  engine-level opaque host object (a value the vat can hold, store in its heap and pass, whose
  payload lives in the worker or host and is not in the snapshot) is the KeyKOS number key or Zircon
  VMO in engine form. It would have to be passable (marshalled as a reference, not as bytes), and its
  persistence across snapshot and restart is exactly the problem the hub row solves one layer up
  [I]. The survey suggests the hub layer is the cheaper place for identity and the engine layer is
  only worth it if vats themselves must *read* bulk data often, which the request says is rare [I].

---

## 6. Design principles for the three designs

1. **Designate by object, authorise by object.** A datum is designated by a handle and read by
   presenting the handle to a reader the holder was separately given. No string, id, digest, path or
   label ever designates a datum to an adapter.
2. **No bytes in vat frames for data the vat does not read.** Passing, storing and handing out are
   reference operations: hub row in, hub row out.
3. **Reading is amplification in the store, never in the holder.** The store (adapter or hub row
   owner) decides; it checks revocation and records audit at each dereference.
4. **Use-not-reveal binds destination at mint time.** A capability that uses a secret is created with
   its grant and its destination; its per-call arguments cannot redirect it.
5. **Rights are on the reference, attenuation mints a weaker reference.** Read-only, range, once and
   expiry are properties of a grant the store issued; weakening never requires the bytes.
6. **Identity survives restart; keys are never reused.** Tombstones answer revoked or deleted
   handles for life.
7. **Revocation and deletion are explicit and durable before acknowledged; GC only reclaims.**
8. **Comparison is an authority.** Same-handle by identity; same-datum by the store; same-content by
   digest only for non-secrets.
9. **Labels are petnames.** Per holder, human-chosen, resolved only through the holder's own map,
   never carrying or derived from content.
10. **Dereferenced values never travel back toward a vat** (and so never through the hub log or a
    journal), including inside error texts.
11. **Every per-reference cost is bounded and per reference, not per use** (one handle per datum and
    rights set; no handle minted per round or page).

## 7. Anti-patterns to avoid

| Anti-pattern | Why it fails | Seen where |
|---|---|---|
| An id that is a bearer token by accident (a store key, row number or file name that some adapter method accepts) | any vat that learns or guesses it reads the datum; ids leak through logs, prompts, errors | risk if `k<n>`/`b<n>` ever reach a vat-callable method; today they do not [C] |
| Digest as a key into a store anyone can query | content addressing turns knowledge of content into authority; low-entropy secrets fall to guessing | IPFS-style stores [F]; `StagedText.digest` is safe only because nothing looks content up by it [C] |
| Swiss numbers or macaroons inside the object system | bearer strings leak via the hub log (C-1), journals and model context; revocation needs issuer state anyway | OCapN sturdyrefs are for leaving the system [F] |
| Destination or purpose supplied per call to a deputy that holds the secret | confused deputy; model-steered exfiltration | - |
| A reader handed to a vat "just for this call" that outlives the call | the vat can read later; the exec vat's per-call fences exist to stop exactly this (architecture D-11) [C] | - |
| Revocation by dropping references or waiting for GC | finalizers run late; sleeping vats hold references indefinitely | architecture fact 1 [J] |
| Reusing store keys after delete | stale handles designate new data | - |
| One handle minted per use | hub rows and commit size grow per use, not per datum | architecture fact 9 [J] |
| `describe()` that leaks content (preview, length, prefix) for secrets | partial read | - |
| Holder-identity ACLs as the main check ("session X owns blob B") | blocks legitimate delegation and reintroduces ambient authority; keep only as defence in depth | `blobs.js` provenance [C] |
| Labels resolved through a global registry | turns a petname into a bearer name | - |
| Carrying secret bytes through a vat "only once" (seeding, migration) | journal and snapshot keep them for life | D-6 [C] |

---

## 8. Open questions this survey cannot settle

- Whether the hub can host a "data row" kind whose owner is an adapter and which survives the
  owner's restart without a vat; needs reading `hub.js` and `hub-state.js` in depth (S-lane for the
  hub design).
- Whether rights checks belong in the hub (cheap, central, needs a rights vocabulary in hub rows)
  or in the store (no core change, one more hop).
- Whether read-once with crash replay should be at-most-once (spent on answer) or effectively-once
  (idempotent per delivery id); depends on what callers can tolerate.
- Zircon koids, EROS revocation and Agoric `isLive` are listed from memory only.

---

## 9. Sources

Fetched for this survey (2026-11-18):

- [capnp-rpc] Cap'n Proto, "RPC Protocol". https://capnproto.org/rpc.html
- [capnp-schema] Cap'n Proto, `rpc.capnp` (master). https://raw.githubusercontent.com/capnproto/capnproto/master/c%2B%2B/src/capnp/rpc.capnp
- [capnp-0.8] Cap'n Proto 0.8 release notes, 2020-04-23 (streaming). https://capnproto.org/news/2020-04-23-capnproto-0.8.html
- [zx-handles] Fuchsia, "Zircon handles". https://fuchsia.dev/fuchsia-src/concepts/kernel/handles
- [zx-duplicate] Fuchsia, `zx_handle_duplicate`. https://fuchsia.dev/fuchsia-src/reference/syscalls/handle_duplicate
- [zx-vmo] Fuchsia, "Virtual Memory Object". https://fuchsia.dev/fuchsia-src/reference/kernel_objects/vm_object
- [zx-vmo-child] Fuchsia, `zx_vmo_create_child`. https://fuchsia.dev/fuchsia-src/reference/syscalls/vmo_create_child
- [unix7] Linux man-pages, unix(7). https://man7.org/linux/man-pages/man7/unix.7.html
- [memfd] Linux man-pages, memfd_create(2). https://man7.org/linux/man-pages/man2/memfd_create.2.html
- [mach] Search summary of Mach documentation, chiefly the XNU `mach_msg` man page
  https://web.mit.edu/darwin/src/modules/xnu/osfmk/man/mach_msg.html and the GNU Mach manual
  https://ftp.fi.muni.cz/pub/gnu/old-gnu/Manuals/machinfo/html_chapter/mach_4.html (pages not read
  in full).
- [keykos] N. Hardy, "The KeyKOS Architecture", Operating Systems Review 1985 (Key Logic 8th ed.
  1990). https://pdos.csail.mit.edu/6.828/2009/readings/keykos-osr.pdf (text extracted locally from
  the PDF's compressed streams).
- [eros-weak] Search summary citing the EROS verification paper https://www.cs.yale.edu/flint/cs428/doc/eros-verify.pdf
  and Cambridge capability slides https://www.cl.cam.ac.uk/teaching/0304/AdvSysTop/Capabilities.pdf
- [spritely-amp] Spritely community, "Rights Amplification term alternate?" https://community.spritely.institute/t/rights-amplification-term-alternate/141
- [c2-amp] "Rights Amplification" (C2 wiki mirror). https://c2wiki.gothdyke.mom/RightsAmplification.html
- [webkey] T. Close, "Web-key: Mashing with Permission", W2SP 2008. https://waterken.sourceforge.net/web-key/
- [ertp] Agoric, "ERTP" guide. https://docs.agoric.com/guides/ertp/
- [agoric-vo] Agoric SwingSet, `docs/virtual-objects.md`. https://github.com/Agoric/agoric-sdk/blob/master/packages/SwingSet/docs/virtual-objects.md
- [agoric-vatdata-search] Search summary of `@agoric/vat-data` and zone docs, e.g.
  https://docs.agoric.com/guides/zoe/contract-upgrade
- [ocapn-captp] OCapN, "CapTP Specification" draft. https://github.com/ocapn/ocapn/blob/main/draft-specifications/CapTP%20Specification.md
- [ocapn-model] OCapN, "Model" draft. https://github.com/ocapn/ocapn/blob/main/draft-specifications/Model.md
- [ocapn-locators] OCapN, "Locators" draft. https://github.com/ocapn/ocapn/blob/main/draft-specifications/Locators.md
- [gh-241] OCapN issue 241, "Senders can impose large storage obligations upon receivers". https://github.com/ocapn/ocapn/issues/241
- [gh-20] OCapN issue 20, "Backpressure?". https://github.com/ocapn/ocapn/issues/20
- [gh-300] OCapN issue 300, "Symbol table optimization". https://github.com/ocapn/ocapn/issues/300
- [gh-218] OCapN issue 218, "Add sturdyrefs to model". https://github.com/ocapn/ocapn/issues/218
- [ipfs] IPFS docs, "Content addressing". https://docs.ipfs.tech/concepts/content-addressing/
- [tahoe] Tahoe-LAFS, "Architecture". https://tahoe-lafs.readthedocs.io/en/latest/architecture.html
- [macaroons] Birgisson et al., "Macaroons: Cookies with Contextual Caveats for Decentralized
  Authorization in the Cloud" (abstract page). https://research.google/pubs/macaroons-cookies-with-contextual-caveats-for-decentralized-authorization-in-the-cloud/
- [petname-wiki] "Petname", Wikipedia. https://en.wikipedia.org/wiki/Petname
- [spritely-petnames] Spritely, "Petnames: A humane approach to secure, decentralized naming". https://files.spritely.institute/papers/petnames.html (cited from a search result summary)

Recalled from memory, not fetched or not readable here:

- M. S. Miller, "Robust Composition: Towards a Unified Approach to Access Control and Concurrency
  Control", PhD thesis, Johns Hopkins, 2006 (sealer/unsealer pairs); the erights.org pages failed
  TLS verification from this machine.
- N. Hardy, "The Confused Deputy", Operating Systems Review 1988, http://cap-lore.com/CapTheory/ConfusedDeputy.html
  (fetch failed certificate verification).
- M. S. Miller, A. H. Karp, J. Donnelley, "Delegating Responsibility in Digital Systems: Horton's
  'Who Done It?'", HotSec 2007.
- Macaroon first-party and third-party caveat mechanics (the full NDSS 2014 paper).
- Zircon koids, EROS revocation details, Agoric issuer `isLive`, an Agoric `copyBytes` pass style.
