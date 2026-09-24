# A stdio MCP server scoped to one guest's tool-call surface

| | |
|---|---|
| **Created** | 2026-09-08 |
| **Updated** | 2026-09-24 |
| **Author** | endolinbot (prompted) |
| **Status** | Not Started |

## Status

Not started. A single stdio MCP server, spawned by `claude` from `--mcp-config`,
that speaks for exactly one Endo guest: it receives the guest's 64-hex formula id
out of band, resolves that one guest's facet through a daemon connection, and
serves **all** `tools/list`/`tools/call` traffic against that facet and no other.
Its tool catalog is the static guest-agent interface, declared in code as Lal's
catalog is today; the server does not discover an interface by inspecting a guest.
Where the daemon connection lives — a harness-owned process outside the confined
tree, or the claude-spawned server itself — depends on the confinement posture
(§ *Scoping*). The broker model is the multi-tenant hardening path (§ *Design
Decisions*, item 1) for structural cross-guest isolation before ocapn's
domain-socket transport lands.

## What is the Problem Being Solved?

A confined `claude -p` running as the inference engine for one Endo guest
([endo-claude](endo-claude.md), arc item 4) has every built-in tool denied
(`--tools ""`) and reaches the world only through the Model Context Protocol
surface named in its generated `--mcp-config`. That surface has to be a real MCP
server, speaking MCP over **stdio**, that projects exactly **one guest's**
tool-call surface and no other's, with the guest denoted by its 64-hex formula
identifier. This document specifies that server: how the formula id is threaded
from the configuration into the server process, how the server reaches the guest
capability through the ordinary daemon client, how the static guest-agent tool
catalog is served and enforced, what happens when the child dies, how the tool names survive the denied
built-in set without colliding with the reconciled reserved names, and which
confinement properties are structural under this transport and which become
runtime.

### Why this is its own document, not an extension of an existing one

Every neighboring design describes the **HTTP-plus-bearer** surface and stops
short of stdio. [endo-gateway-mcp](endo-gateway-mcp.md) Design Decision 6 puts
stdio explicitly **out of scope** ("Streamable HTTP only; no stdio"); that surface
terminates JSON-RPC over a listening port authenticated by an `Authorization:
Bearer` header. [daemon-agent-tools](daemon-agent-tools.md) owns the *capabilities* the
tools project, not any transport. The three minion.town companions
(`mcp-daemon-guest-tools`, `mcp-endo-guest`, `mcp-oauth`) are the browser-facing
OAuth 2.1 deployment. And [endo-claude](endo-claude.md) is the **client** side: it
names the stdio server as an "adapter-implementation prerequisite ... rather than
in scope of this design."

What is genuinely net-new here, and the reason for a separate document, is the
part endo-claude leaves as a bare prerequisite: **how the formula id is threaded
from an MCP configuration entry into the spawned server** (§ *Threading the formula
id from configuration*), **how that server reaches the one guest through the
ordinary daemon client and what authority that hands it** (§ *Scoping*), the
**server half** of the static catalog and dispatch check (*Static tool catalog*),
the request- and construction-time **error-code taxonomy**
(§ *Fail-closed behavior*), and the **naming** rules. This document composes with
the [endo-agent-tools](endo-agent-tools.md) MCP-adapter projection rather than
reinventing it, and does not re-derive endo-claude's client flags.

**A cross-document note.** [endo-claude](endo-claude.md)'s *Local deployment* and
*Multiplexing by guest identifier* sections describe the two-process adapter/broker
split with an fd never inherited into the confined tree. That split is **not** to be
consolidated away (maintainer, PR #1226: "there is more than one way to use Claude
and we expect to use them"): it is the **confined, structural** topology, in which
the harness owns the daemon connection outside the slice. This document adds a
**second, coexisting** topology — a server-held connection for the single-tenant,
non-adversarial deployment that does not confine `claude` against the socket — and
§ *Scoping* carries both. The two documents therefore agree: endo-claude owns the
harness-owned-broker shape, this document owns the server half of the contract common
to both shapes plus the smaller single-tenant shape. No reconciliation-by-consolidation
is owed.

## Division of labor with the neighboring designs

The diagram below names four terms. A one-line gloss up front (define-before-
diagram): a **guest** is a confined counterparty the Endo daemon grants an
attenuated set of capabilities to; the **harness** is the arc-item-4 `@endo/claude`
caplet that spawns and supervises that guest's confined `claude -p`; a **formula
id** is Endo's stable 64-hex identifier for the persistent recipe that instantiated
a guest; and a **facet** is the attenuated capability handle the daemon resolves
for one guest's daemon-side object surface.

```mermaid
flowchart LR
  subgraph claude["@endo/claude (arc item 4): the client + harness"]
    HARNESS["harness: generates --mcp-config<br/>(env carries the guest formula id)<br/>and --allowedTools from the static catalog"]
    CLAUDE["claude -p (confined): MCP client<br/>spawns the server named in --mcp-config"]
  end
  subgraph thisdoc["THIS design: the stdio MCP server (one process)"]
    SERVER["stdio MCP server (claude-spawned, per call)<br/>reads formula id from env<br/>connects via the daemon client<br/>resolves the one facet; serves static catalog<br/>MCP framing + dispatch check"]
  end
  subgraph proj["@endo/agent-tools: the projection"]
    ADP["MCP adapter: static ToolRecord -> MCP Tool<br/>tools/call -> guest-bound operation"]
  end
  DAEMON["Endo daemon<br/>bootstrap root host resolves formula id -> guest facet"]
  HARNESS -->|"1. spawns with --mcp-config (env: formula id)"| CLAUDE
  CLAUDE -->|"2. spawns as its MCP stdio server"| SERVER
  SERVER -->|uses| ADP
  SERVER -->|"3. daemon connection; resolve to the one guest facet<br/>(edge 3 lives outside the confined tree in the confined shape)"| DAEMON
```

The diagram shows the **single-tenant** shape, where the claude-spawned server holds
the daemon connection itself (edge 3). In the **confined** shape the confinement
premise moves edge 3 **out** of the `claude` subgraph: a harness-owned process (a
broker, or a daemon-issued guest-scoped bootstrap) holds the daemon connection
outside the slice, and the claude-spawned server speaks MCP over a channel it is
given rather than opening the socket — because the sandbox denies the confined
`claude` tree the daemon socket (§ *Scoping*). The server-side contract (resolve to
one facet, serve the static catalog, dispatch check) is identical either way.

[endo-claude](endo-claude.md) decides **when** to spawn, **with what flags**, and
generates `--allowedTools` from the same static catalog this server serves.
[endo-agent-tools](endo-agent-tools.md) owns the **projection** (mapping the fixed
guest-agent interface to an MCP `tools/list` catalog, and an MCP `tools/call` to
the corresponding operation bound to one guest facet), present today as a declared stub at
`packages/agent-tools/src/adapters/mcp.js`. This document owns the **server** that
hosts that projection over stdio: how it is told which guest, how it reaches that
one guest's facet, the static catalog and server-side dispatch
check, the fail-closed rules, and the naming.

## Scoping by formula identifier (the confinement boundary)

This is the centerpiece. The server must speak for exactly one guest. The mechanism
common to every topology is: the server is told the guest's formula id out of band,
the one guest's facet is resolved through a daemon connection, and **all** traffic is
served against that one facet and no other. What varies — and what the confinement
premise decides — is **where the daemon connection lives**: held by a harness-owned
process outside the confined tree in the confined shape, or by the claude-spawned
server itself in the single-tenant shape (*How the confinement properties change*,
below). The one-guest resolution and the always-dispatch-through-that-guest contract
are identical across both.

**The server is told which guest once, at startup, out of band from the MCP
client.** The 64-hex formula id is delivered through the server process's
**environment**, populated by the harness-generated `--mcp-config` (§ *Threading
the formula id from configuration*). It is validated against `/^[0-9a-f]{64}$/` (the
same boundary [endo-claude](endo-claude.md) asserts in `makeGuestInference`), and
it is **never accepted from the MCP client over the wire**: no `tools/call`, no
`initialize` param, no JSON-RPC field carries or overrides it. So "which guest" is
a property of the server's configured environment, not a value the confined client
can name, forge, or vary per call.

**How the server reaches the guest capability (checked against the daemon client
API).** The server uses the usual Endo daemon client, exactly as
`packages/cli/src/context.js` does: `makeEndoClient` (`@endo/daemon`,
`packages/daemon/src/client.js`) over the socket path
`whereEndoSock(process.platform, process.env, info)` (`@endo/where`,
`packages/where/index.js`) returns a `getBootstrap`, and `E(getBootstrap()).host()`
yields the **bootstrap root host**. That host resolves the configured formula id to
the one guest's value by the agent-only registry method
**`E(host).lookupById(formulaId)`** — guarded as
`lookupById: M.call(IdShape).returns(M.promise())` on `HostInterface`
(`packages/daemon/src/interfaces.js`), where `IdShape` is the formula-identifier
string. This is the concrete daemon-client form of "the root that resolves *any*
formula id against ambient daemon powers" that [endo-claude](endo-claude.md) Design
Decision 8 names, and `lookupById` already exists on the host the ordinary client
reaches, so no new daemon surface is required to reach one guest. Once the one
guest's facet is resolved, **all** subsequent `tools/list` / `tools/call` traffic is
served against **that one facet and no other**: the server drills down to the guest
facet and always dispatches through that guest (maintainer, PR #1226). The confined
`claude` is then free to use whatever authority the guest itself holds — the guest
facet *is* the ceiling, and the MCP surface never widens past it.

**Where the daemon connection lives depends on the confinement posture** (developed
fully in *How the confinement properties change*, below). The socket reach the
resolution above needs is **not** unconditionally granted to the claude-spawned
server: in the confined, potentially-adversarial deployment the sandbox denies
`claude`'s whole tree the daemon socket, so a **harness-owned** process outside the
slice holds the connection and the claude-spawned side speaks MCP over a channel it
is given; only in a single-tenant, non-adversarial deployment does the claude-spawned
server itself open the ordinary client over a socket the slice exposes. Either way
the client can never name a different guest: no other guest's connection, no bearer,
no listening port.

**The ocapn framing.** Over an ocapn session the same operation is a **delivery to
the bootstrap nonce locator (the "gateway") at export offset 0**: the connection's
offset-0 export is the object you deliver the formula-id lookup to, and the daemon
publishes a per-session bootstrap there. ocapn is **not yet ready to use a domain-
socket network transport layer**, so today the server uses the ordinary daemon
client and the root-host resolution above rather than an ocapn offset-0 delivery.
When ocapn's domain-socket transport lands, the offset-0 gateway is the path to a
**scoped** bootstrap (below), and the resolution moves from the root host to that
gateway with no change to this server's catalog, dispatch, or naming contracts.

### How the confinement properties change under this transport

Structural cross-guest isolation means the raw daemon connection lives outside the
confined tree — in a harness-owned process whose fd is never inherited into `claude`'s
slice — so a compromised `claude` has no descriptor on which to speak to the daemon
and no socket path in reach. That is the required posture wherever the sandbox
confines `claude` against the socket; the smaller server-held-connection shape is
available only where it is not. Stated honestly, per property:

- **Formula id never on the MCP wire — preserved.** The id arrives through the
  server's environment from the harness-generated config, never through the MCP
  protocol, and is never read from a client request. What *changes* is that the id
  is now present **inside the confined tree** — in the MCP server's environment (and
  in the `--mcp-config` `claude` reads to spawn it) — where the broker model kept it
  entirely outside. This is acceptable because a formula id is **not a secret
  bearer**: it is content-derived, it names the guest's *own* recipe, and possessing
  it grants nothing without a daemon connection *and* the authority to resolve it.
- **Per-process isolation — preserved.** Each inference is a fresh `claude -p` that
  spawns its own MCP server process (§ *The stdio transport*); each inference has its
  own daemon connection — held by the claude-spawned server in the single-tenant
  shape, or by a per-inference harness-owned broker in the confined shape — and its
  own binding of the static catalog to that guest. There is **no shared multi-guest
  server** (that is the HTTP shape) and no long-lived multiplexed connection across
  guests. Isolation is per process, not per bearer, exactly as
  [endo-claude](endo-claude.md) names.
- **Fail-closed construction: preserved.** An unresolvable formula id, an
  unreachable daemon, or an invalid static guest-agent declaration is a construction
  throw before any tool is served (*Fail-closed behavior*).
- **Cross-guest isolation — where the daemon connection lives is the boundary, and
  it is not negotiable.** The confinement premise ([endo-posix-sandbox](endo-posix-sandbox.md),
  [endo-claude](endo-claude.md) Design Decision 6) is that the sandbox slice denies
  the confined `claude` — **and its whole spawned process tree** — direct access to
  every system resource, the daemon's Unix domain socket included; the confined agent
  reaches all authority **only** through the MCP surface. **If `claude` can open an
  arbitrary domain socket on the shared host, this design is forfeit** (maintainer,
  PR #1226): a `claude` that can reach the daemon socket itself is not confined at
  all. So the socket must be **structurally out of the slice's reach**, not merely
  "present but relied on not to be misused." This has a direct consequence for a
  claude-**spawned**, in-slice stdio server: because that server lives inside
  `claude`'s slice, a server that itself opened the daemon connection would require
  the socket to be mounted **into** the slice — which grants `claude` the same reach
  and forfeits confinement. **The daemon connection must therefore be held outside
  the confined tree.** That is exactly [endo-claude](endo-claude.md)'s topology: a
  **harness-owned** process (the facet broker) holds the raw connected fd, resolves
  the one guest's facet, and hands the claude-spawned side only MCP over a channel it
  is given; the raw fd is never inherited into the `claude` tree, and the socket path
  is never inside the slice. Cross-guest isolation is then **structural**: the
  confined process has no descriptor and no socket path on which to speak to the
  daemon, so it cannot resolve *any* guest — its own or another — except by asking
  the harness-held connection, which is pinned to its one facet.

**How this constrains where the connection-holding process may live.** A single
claude-spawned process that both serves MCP and holds the daemon connection is
only sound under the confinement premise above where `claude` is **not** being confined against the daemon
socket — a single-tenant, non-adversarial deployment where the guest resolving its
own id over a reachable socket is acceptable and there is no sibling to reach. It is
**not** sound for the confined, potentially-adversarial case, where the socket must
be denied to `claude`: there, a claude-spawned in-slice server cannot be the process
that opens the connection, and the connection lives in a harness-owned process
outside the slice. Both shapes are legitimate and expected — there is more than one
way to run this (maintainer, PR #1226) — so this document keeps **both** rather than
electing one as canonical:

1. **Harness-owned connection (the confined, structural case).** The daemon
   connection is held by a harness-owned process outside the confined tree — either
   a two-process broker, or, better, a daemon that hands that
   process a bootstrap **already scoped to the one guest** (the ocapn offset-0
   gateway brought forward over the daemon UDS: a guest-scoped agent rather than the
   host root, so the connection resolves only this guest and exposes no enumeration
   or host authority). The claude-spawned stdio side speaks MCP over its given
   channel and never holds the raw fd. This is the shape a shared or adversarial host
   **requires**, and it is what makes cross-guest isolation structural.
2. **Server-held connection (the single-tenant, non-confined-against-the-socket
   case).** Where the deployment does not need `claude` denied the socket — one
   guest's own `claude` on a host it already trusts — the claude-spawned stdio server
   may itself open the ordinary daemon client and resolve its one guest. This is the
   smaller shape; it does **not** provide structural cross-guest isolation (the
   connection is inside the confined tree), and it must not be used where the
   confinement premise applies.

Naming the boundary is the point: structural cross-guest isolation is a property of
**where the daemon connection lives** — outside the confined tree — never of formula-id
secrecy. Formula ids are content-derived, not bearer secrets; the design does not lean
on their secrecy for confinement.

## Threading the formula id from configuration

The formula id must reach the server process from the harness's configuration
without ever passing through the MCP client. Two carriers were considered — an
**environment variable** and an **initial stdin handshake message** — and this
design recommends the environment variable.

**Recommended: an environment variable, `ENDO_GUEST_FORMULA_ID`.** Claude Code's
`--mcp-config` entry for a stdio server carries a `command`, `args`, and an `env`
map; the harness populates `env.ENDO_GUEST_FORMULA_ID` with the 64-hex id (and, if
the daemon socket is not at the default `whereEndoSock(...)` path, `env.ENDO_SOCK`).
The server reads the variable once at startup, validates it as 64-hex, resolves the
facet, and never reads it again. This is the natural carrier, needs no protocol
phase, and works regardless of how the server is spawned.

**Rejected in the stdio topology: an initial stdin handshake message.** Under stdio
MCP the server's **stdin is the MCP client's channel** — it is `claude` that writes
the server's stdin, frame by frame, starting with `initialize`. A "handshake
message on stdin" would therefore have to come **from the confined `claude`
itself**, which is exactly the thing this design must not do (the client naming its
own guest is the forgery vector § *Scoping* forecloses). The only way to make a
trusted party write the server's stdin is to interpose a trusted process between
`claude` and the server — which *is* the broker this simplification removes. So in
the stdio topology the stdin handshake is either unsafe (client-supplied) or
self-defeating (reintroduces the broker); the environment variable has neither
problem. (An stdin handshake is the right carrier for a *different* topology — one
where the harness, not the client, owns the server's stdin — but that is not stdio
MCP.)

**The MCP configuration entry.** The generated config names one server:

```json
{
  "mcpServers": {
    "endo": {
      "command": "endo-mcp-stdio",
      "args": [],
      "env": { "ENDO_GUEST_FORMULA_ID": "<64-hex>" }
    }
  }
}
```

The formula id and (when non-default) the daemon socket path ride in `env`. The
catalog is **not** in the config. The server and harness import the same static
guest-agent interface declaration (*Static tool catalog*); the harness renders
its names into `--allowedTools`, and the server renders its schemas in `tools/list`.
`--strict-mcp-config` pins `claude` to exactly this one server.

**Avoiding a temporary config file — decided, not left open.** The maintainer asked
to prefer process substitution over a temp config file and, in PR #1226, to pin the
carrier down now rather than defer it. It is already pinned, by the sibling harness
design: [endo-claude](endo-claude.md)'s `--mcp-config` contract (its argv table and
§ *Argv length is an operational ceiling*) records that `claude`'s `--mcp-config` is
**variadic and accepts a JSON file path *or* an inline JSON string**, and that the
harness **always renders it as a file path, never inline JSON** — because an inline
JSON value rides argv and a large catalog would hit `spawn E2BIG`, and because a
positional landing after a variadic `--mcp-config` is an argv-injection sink. This
document adopts that same decision, so the two harness surfaces stay identical:

- **The config is passed as a file *path*, backed by an anonymous pipe or `memfd` —
  no on-disk file.** The harness opens a pipe/`memfd`, writes the JSON, and passes the
  `/dev/fd/NN` (or `/proc/self/fd/NN`) path on argv. There is no temporary file on
  disk to create, secure, or unlink, and the config value never rides argv. This is
  the "avoid a temp file" goal met without inline JSON.
- **Not shell process substitution `<(…)`.** `<(…)` is a *shell* construct, and both
  this server's harness and `claude` are spawned **directly, never through a shell**
  (endo-claude § *Argv order is a confinement boundary*), so `<(…)` cannot be
  expanded; the harness performs the equivalent pipe/`memfd` plumbing itself. The
  fd-based path is read once at startup, so the non-seekable-pipe hazard that would
  break a re-`stat`/re-open consumer does not arise for a single startup read; if a
  future pinned `claude` re-reads config mid-session, back the fd with a `memfd`
  (seekable) rather than a pipe.
- **The formula id never touches a file at all.** It rides in the config's `env` map
  (§ above), delivered to the server process's environment, so even the pipe/`memfd`-
  backed config carries only a non-secret, content-derived id (§ *Scoping*), never a
  bearer.

No `0600` on-disk fallback is needed on the pinned platform (Linux, `memfd`/`/dev/fd`
available); it survives only as the degenerate carrier for a platform without an
fd-path form, and even there the id itself stays in `env`.

## Static tool catalog

The MCP tool surface is **static and corresponds to the guest-agent interface**.
It follows the pattern already used by Lal: `packages/lal/tools/index.js` aggregates
hardened declarative tool records from fixed family modules, and
`packages/lal/tool-dispatch.js` binds the fixed names to operations over one guest's
powers. This server similarly imports one hardened declaration of names,
descriptions, parameter schemas, and dispatch keys. It does not call a guest to
infer, enumerate, or synthesize the catalog.

- **One declaration drives both sides.** The harness renders
  `mcp__endo__<tool>` allow-list entries from the static declaration. The server
  renders `tools/list` from it and rejects any `tools/call` whose name is absent.
  There is no duplicated list and no client/server discovery race.
- **Guest authority remains dynamic; interface shape does not.** A server instance
  binds the fixed dispatcher to exactly one resolved guest facet. A tool whose
  operation needs a capability the guest lacks fails through that guest interface;
  its absence does not reshape `tools/list`. Grant changes therefore affect what a
  call can do, not which method names exist.
- **The declaration contains no ambient escape tools.** Code-evaluation operations
  such as `evaluate`, `eval`, and `define` are not members of this interface. Names
  containing `__`, dunder/reserved-property names (`__proto__`, `constructor`,
  `prototype`, `__getMethodNames__`), malformed names, and duplicate or
  case-confusable names are rejected when the declaration is loaded. This is a
  build-time/interface invariant, not pruning of a guest-shaped value.
- **Arguments remain scoped by the guest interface.** Petname-designating
  operations resolve petnames through the bound guest's own fail-closed petstore,
  and path operations rely on the bound mount or git capability. An out-of-scope
  designation returns the visible `-32001` `tool-not-permitted` error with
  `data.reason = argument-scope`; it is never silently narrowed.

`tools.listChanged` is **false** and the server emits no
`notifications/tools/list_changed`: the interface is versioned with the package,
so changing it requires a package release and a corresponding harness update, not a
mid-session discovery event.

## The stdio transport

**Framing.** The server speaks the MCP stdio transport: JSON-RPC 2.0 messages on
stdout, one message per line, delimited by `\n` **only**, each line a single UTF-8
JSON object with **no embedded newline**. stdin carries the client's requests in the
same framing. **stderr is never protocol**: it carries logs and diagnostics out of
band, read by the harness, never by the peer parser. The server splits strictly on
`\n` (it does not also split on `\r`, `U+2028`, or `U+2029`; Node's `readline` is
non-compliant here, as [endopi-stdio-rpc-bridge](endopi-stdio-rpc-bridge.md)
records). This is the transport MCP clients reach when they "run a local shim
subprocess," the pattern [endo-gateway-mcp](endo-gateway-mcp.md) names for stdio
clients.

**`initialize`.** The server answers with `serverInfo: { name: "endo", version }`
(the fixed `mcp__endo__` label of § *Naming*) and the same self-identifying
`initialize` **response shape** [endo-gateway-mcp](endo-gateway-mcp.md) uses. The
two sibling transports share the handshake *shape*, not the label *string*: each
pins its own `serverInfo.name` (`endo` here, `endo-gateway` there). It further sets
`tools: { listChanged: false }` (reflecting the static interface) and advertises
`logging: {}` so facet diagnostics ship back as `notifications/message`. A **logging
facet is exposed** (maintainer, PR #1226); *how* the logs are obtained is immaterial,
so the server is free to source them from stderr, from the facet's own diagnostics,
or both, and to forward whichever the consumer wants over the in-band `logging`
channel — the exposed facet is the contract, the plumbing behind it is not.
`resources` and `prompts` are omitted, as in [endo-gateway-mcp](endo-gateway-mcp.md).

**Process lifetime and topology.** The server is a **single process, spawned per
call.** `claude` spawns it as the command its `--mcp-config` names; it lives for the
one `claude -p` process's lifetime and exits on EOF when `claude` closes its stdin
or exits. Because [endo-claude](endo-claude.md) spawns a fresh `claude -p` per
inference, there is one server process per inference, each with its own daemon
connection and fresh binding of the static catalog. Concurrent inferences for the same guest are
**separate processes**, each with its own connection — no shared, long-lived,
multiplexed server. So the answer to "spawned per agent or shared" is: **spawned per
call**, one guest per process, never a shared multi-guest server (that is the HTTP
shape).

**When the child dies.**

- **`claude` dies** (crash, timeout kill, cancel): its stdin closes, the server
  reads EOF, tears down its daemon connection, and exits. Because the process is
  per-call, cancellation is just process exit; there is no cross-call state on this
  process to protect, and no sibling call multiplexed onto it.
- **The daemon connection drops** (daemon restart, socket gone): the in-flight
  `tools/call` returns an MCP JSON-RPC **error** (`-32010` `bridge-down`, below),
  never a fabricated success. The harness observes the failure and settles the
  inference to `{type: 'bridge-down', detail}` ([endo-claude](endo-claude.md) Design
  Decision 8). The server **fails closed**: a lost facet connection serves errors,
  never an ambient or re-widened surface, and the next inference's fresh process
  re-establishes the connection.

### Structured signals from the `claude` child

The MCP server's stdout belongs to MCP and is consumed by `claude`. Separately, the
`@endo/claude` harness consumes the stdout of the `claude -p` child. That invocation
uses `--output-format stream-json --verbose`, so the harness receives a
newline-delimited JSON event stream instead of treating exit status or human-readable
text as the only signal.

The harness validates every line and requires exactly one terminal `result` event
for its prompt. A `result` whose `origin.kind` is `task-notification` belongs to a
background-task notification and is excluded from that terminal count. A malformed
line, a truncated stream, no terminal result, or multiple terminal results is a
`parse-error`/transient failure, never a successful inference.

The terminal event supplies the inference text plus structured status and accounting:
`is_error`, `subtype`, `api_error_status`, `stop_reason`, `terminal_reason`,
`permission_denials`, `num_turns`, `duration_ms`, `duration_api_ms`, `ttft_ms`,
`usage`, `total_cost_usd`, `subagent_stats`, `queued_turn_count`, and
`fast_mode_state` when present. The harness copies primitives into the hardened
result record. It classifies a non-error terminal event as `ok`; HTTP 429 or an
explicit rate/usage-limit terminal reason as `rate-limited`; permission denials as a
policy refusal; and other API statuses or explicit overload, connection, or timeout
reasons as typed API/availability failures. Classification uses these fields before any
compatibility text match.

The stream can also contain `rate_limit_event`. The harness retains
`rate_limit_info.status`, `rateLimitType`, `resetsAt`, overage status, and the
`unifiedWindows.five_hour` and `unifiedWindows.seven_day` utilization/reset records.
These are the deterministic quota and retry inputs for pool admission. Absence of a
rate-limit event means quota telemetry is unknown; it does not mean zero utilization.
This parsing contract is part of the harness/server integration test even though the
events are emitted by the `claude` child rather than by the MCP server.

## Fail-closed behavior

The server **refuses to construct** (throws before answering `initialize`) when:

- the formula id is missing or not 64-hex, or does not resolve to a guest facet;
- the daemon is unreachable (the client cannot open a session); or
- the static guest-agent declaration is empty or violates its name invariants.

**A discriminated construction throw, matching the request-time shape.** The
construction throw carries the same `reason`-style discriminant the request-time
table below models, so an operator or harness reading a construction failure gets
the same "why, and what to do about it" clarity a request-time failure gives, and
can branch on configuration versus deployment versus implementation bugs. The
discriminant values are `invalid-formula-id` (missing, not 64-hex, or unresolvable),
`daemon-unreachable` (the daemon client could not open a session),
`empty-interface` (the static declaration contains no tools), and, for the two
well-formedness failure classes of *Naming*, `malformed-name` (a declared name
that is structurally invalid, `__`-containing, dunder/reserved, or code-eval) and
`catalog-name-conflict` (two declared names that are duplicate or case-confusable
twins). These are kept distinct on
purpose: collapsing them would defeat the discriminant's stated goal of letting the
reader branch on why the catalog is bad. Both surfaces use the same compound
hyphenated-kebab grammar (`name-scope`/`argument-scope` at request time; the values
above at construction), so a single harness parser reads the same string shape on
both.

A zero-tool interface that "passes confinement by exposing nothing" is the exact
anti-pattern this rule rejects: confinement must be demonstrated positively (the
guest's real tools can be invoked), not by an empty surface. At **request** time the
same posture holds: an unknown
`tools/call` name is a JSON-RPC error, a malformed frame is an error, and the server
never falls back to an unscoped surface on any error path.

**Distinct wire-visible error shapes per failure class.** The model must be able to
tell "you're not allowed to call this" from "the backend just died," a distinction
that decides whether to retry, rephrase, or give up. So each request-time failure
class carries its own JSON-RPC error, not one undifferentiated error:

| Failure class | JSON-RPC error | Retry? |
|---|---|---|
| Malformed frame / not valid JSON-RPC | `-32700` parse error / `-32600` invalid request | client bug: fix and resend |
| Unknown method (not `tools/list`/`tools/call`) | `-32601` method not found | no |
| Policy rejection (name outside the static interface or arguments outside the facet scope) | application code `-32001` `tool-not-permitted`, `data.reason` = `name-scope` \| `argument-scope` | no (the surface will not widen) |
| Daemon connection down (the harness-side `bridge-down`) | application code `-32010` `bridge-down`, `data.detail` mirroring the harness's `{type: 'bridge-down', detail}` | transient (the harness may respawn on the next call) |
| **Facet method threw** (an in-catalog, in-scope `tools/call` that *reached* the facet and the target application code raised, for example `readText` on a missing path) | **not** a JSON-RPC error: a successful `tools/call` **result** with `isError: true` and the failure in the result `content`, the standard MCP "the tool ran and failed" shape; the harness settles it to `{type: 'facet-threw', method, error}` ([endo-claude](endo-claude.md) Design Decision 8), carrying `error: toPassableError(caught)` | application-level: up to the model, given the surfaced error |

The first four rows are **protocol** failures (the request was refused *before or
instead of* invoking the facet method): the wire carries a JSON-RPC **error**
response. The last row is an **application** failure (the request was in-catalog,
in-scope, dispatched, and the facet method itself threw): the tool *ran*, so per the
MCP tool-call contract the wire carries a successful JSON-RPC **result** with
`isError: true`, never a JSON-RPC transport error. Collapsing the two would defeat
the very distinction this section exists to preserve. A policy rejection is never
reported as a transport error, `bridge-down` is never reported as a policy
rejection, and a facet-method throw is never reported as either.

The `-3200x`/`-3201x` application codes sit in JSON-RPC's implementation-defined
server-error range and are the wire counterpart of the harness-side typed outcomes,
so the two consumers (the MCP client and the harness) see the same failure at
matching specificity.

## Naming

Claude Code presents an MCP tool to the model as **`mcp__<server>__<tool>`**. That
prefix is exactly what survives the denied built-in set: `--tools ""` empties the
*built-in* tools, while `mcp__<server>__<tool>` names arrive through `--mcp-config`
plus the generated `--allowedTools` ([endo-claude](endo-claude.md) *The tool
baseline is fail-closed*). Two naming obligations follow.

- **The server label is a fixed harness literal**, `endo`, so every tool lands as
  `mcp__endo__<tool>` and the client's `--allowedTools` entries are computable from
  the static interface declaration. It is not guest-derived and cannot be influenced
  by the confined process.
- **The `<tool>` portion is the flat, interface-native name from the reconciled
  namespace**, carrying **no transport or category prefix** (never `endo_readText`,
  never `stdio__readText`). The `mcp__<server>__` prefix is added by Claude Code, not
  baked into the tool name, so the tool name itself stays in the bare camelCase
  grammar. The static declaration rejects `__`-containing names partly for this
  reason: a tool named `foo__bar` would render `mcp__endo__foo__bar` and parse
  ambiguously against the CLI's own `mcp__<server>__<tool>` grammar.

**Well-formed names, and no collision the server can actually cause.** The
construction guard enforces exactly the invariants this server *owns*: the declared
catalog must carry no `__`-containing name, no dunder/reserved-property name, no
code-eval name, no two names that duplicate or are
case-confusable twins of each other (`readtext` beside `readText`), and no malformed
name. A declaration that violates any of these **throws before the server ships**.
These are properties of the versioned interface itself and are testable without a
guest or daemon connection.

What the guard deliberately does **not** do is fail construction on a bare-name
collision against a *different* MCP server's reserved namespace. The flat naming
convention (interface-native camelCase, no transport/category prefix) is shared with
`kriscendobot/minion.town` PR
[#79](https://github.com/kriscendobot/minion.town/pull/79) (approved in PR
[#77](https://github.com/kriscendobot/minion.town/pull/77)), whose load-time guard
reserves names like `submit`, `invite`, `listReminders`, and `cancelReminder` ahead
of minion.town's *own* future facets. But this server's label is the fixed literal
`endo`, and Claude Code namespaces every tool as `mcp__endo__<tool>`, so a bare name
shared with minion.town's `endo`-**un**prefixed manifest cannot produce a wire-level
collision. Keying a **security-critical construction throw** on an **unmerged,
externally-owned** reservation list would let a new reserved name landed by
minion.town make an otherwise-correct Endo confinement server refuse to construct: an
availability failure whose root cause sits entirely outside this design's change
surface. So collision against minion.town's prospective reservations is demoted to a
**construction-time warning**, not a throw. The warning carries the **same
discriminated shape** as the construction throws — `{ reason:
'reserved-name-collision', level: 'warning', names: [...] }` — with the explicit
`level: 'warning'` marking it advisory rather than fatal, written to stderr where the
harness reads it. The convention is adopted; the foreign reservation list is
advisory, not a gate.

## Package shape and code home

The **projection** is the `@endo/agent-tools` MCP adapter (the declared stub at
`packages/agent-tools/src/adapters/mcp.js`); implementing it is the
adapter-implementation prerequisite [endo-claude](endo-claude.md) already names. The
**stdio server** (the claude-spawned command named by `--mcp-config`) is a single
process that, at startup: reads and validates `ENDO_GUEST_FORMULA_ID` from its
environment, opens a daemon session with the usual client, resolves the one guest's
facet at the bootstrap root host (`E(host).lookupById(formulaId)`), imports the
static guest-agent declaration, then runs the MCP framing loop: decoding
`tools/list`/`tools/call` frames off
stdin, applying the name- and argument-scope dispatch check, invoking the projection
through operations bound to that guest facet, and writing replies to stdout.

**Who holds the daemon connection depends on the confinement posture** (§ *Scoping*).
In the **single-tenant** shape the claude-spawned server itself resolves the facet and
holds the daemon reach; in the **confined** shape the connection is held by a
harness-owned process outside the slice (a broker, or a daemon-issued scoped
bootstrap) and the claude-spawned side holds only MCP over the channel it is given —
never the raw fd, never a socket path. Either way the server-side contract this
document owns is the same: resolve to **one** guest facet, serve the static catalog,
apply the name- and argument-scope dispatch check, and dispatch `tools/call` to that
one facet and no other. The exact split of the resolution-and-dispatch logic between
`@endo/agent-tools` (the projection), `@endo/claude` (the harness that generates the
config and, in the confined shape, owns the connection), and the claude-spawned stdio
process follows the ordinary module boundary and is settled at build time; this design
fixes the *contract* (one static guest-agent catalog, server-side dispatch check, one-guest
dispatch) and the *confinement invariant* (the daemon connection never inside the
confined tree when `claude` is confined against the socket), not the module boundary.

Until the `@endo/agent-tools` MCP adapter lands, [endo-claude](endo-claude.md)
carries a minimal stopgap stdio shim gated behind an explicit opt-in and marked for
deletion; this design is the specification that the stopgap and the real adapter both
implement.

## Test plan (acceptance criteria)

The confinement boundary is the centerpiece, so it is demonstrated **positively and
negatively**, mirroring [endo-claude](endo-claude.md) Design Decision 2's
positive-confinement test. An implementation is accepted only when these pass.

**Positive confinement (the surface actually works):**

- **Real tools invoke.** With a server started for a guest, `tools/list` returns
  exactly the static guest-agent interface, and a `tools/call` for a declared name
  reaches the corresponding operation bound to that guest facet and returns
  its result. Confinement is shown by real tools working, not by an empty surface.
- **Catalog parity.** The `tools/list` the server serves and the `--allowedTools`
  the harness generated come from the same static declaration: every name in one
  appears in the other. A simulated mid-session grant change does not reshape either
  list (`tools.listChanged` stays false and no
  `notifications/tools/list_changed` is emitted); it changes only whether the bound
  guest operation can fulfill a call.
- **Structured child signals.** A fixture stream containing ordinary events, one
  terminal `result`, and a `rate_limit_event` produces the expected tagged outcome,
  usage fields, and five-hour/seven-day quota record. Truncated, missing-result, and
  multiple-result streams fail closed. A task-notification result is ignored when
  counting the prompt's one terminal result.

**Negative confinement (the boundary holds):**

- **The MCP client cannot name a different guest.** No `tools/call`, `initialize`
  param, or other client-supplied field changes which guest the server speaks for; a
  request attempting to carry a formula id is ignored (the id comes only from the
  server's environment). A `tools/call` issued on the server only ever reaches the one
  configured guest's facet.
- **The formula id is not on the MCP wire.** Across a full session the id never
  appears in any request or response frame; it is read only from the environment at
  startup.
- **The daemon connection is not inside the confined tree (confined shape).** For the
  confined deployment the confinement premise is structural, and its test is
  structural: with the sandbox slice active, the confined `claude` tree has **no**
  daemon socket path in its filesystem namespace and **no** connected fd inherited, so
  an attempt from within the confined tree to open a daemon connection or reach the
  socket fails outright (`if claude can open an arbitrary domain socket the design is
  forfeit` — this test is the assertion that it cannot). The one guest's facet is
  reached only through the harness-owned connection (broker or scoped bootstrap), which
  is pinned to that guest. (The smaller **single-tenant** shape — server-held
  connection — does not claim this structural guarantee and is used only where the
  deployment does not confine `claude` against the socket; there the corresponding
  assertion is only that the server resolves solely its configured id, with no
  enumeration code path.)
- **Name-scope rejection.** A `tools/call` for a name not in the static interface
  (a code-eval name, a `__`-containing name, or an unknown name) returns the
  `-32001` `tool-not-permitted` error with `data.reason = name-scope`, and never
  reaches the facet.
- **Argument-scope rejection.** A `tools/call` for an in-catalog petname-designating
  tool whose *arguments* designate a petname/path outside the facet's own attenuated
  surface returns `-32001` with `data.reason = argument-scope`: a visible rejection,
  never a silently narrowed success.
- **Fail-closed construction.** Construction throws (the server never serves
  `initialize`) for: a missing/non-64-hex/unresolvable formula id
  (`invalid-formula-id`); an unreachable daemon (`daemon-unreachable`); an empty
  static declaration (`empty-interface`); a declared `__`-containing or otherwise
  malformed name (`malformed-name`); and a declaration carrying an internally
  duplicate or case-confusable name (`catalog-name-conflict`) — the two
  well-formedness classes asserted as **distinct** discriminant values, not one
  collapsed `malformed-catalog`. A bare-name collision against minion.town's reserved
  list produces a **warning** record (`{ reason: 'reserved-name-collision', level:
  'warning', names: [...] }`), not a throw, and construction still succeeds.
- **Fail-closed at request and on connection loss.** A malformed frame returns
  `-32700`/`-32600`; an unknown method returns `-32601`; a daemon connection drop
  returns `-32010` `bridge-down` for the in-flight call and never a fabricated success
  or a re-widened surface.
- **Facet-method throw is a result, not a protocol error.** An in-catalog, in-scope
  `tools/call` whose facet method raises (for example `readText` on a missing path)
  returns a **successful** `tools/call` result with `isError: true` and the error in
  `content` (not a JSON-RPC `-3200x`/`-3201x` error), and the harness settles it to
  `{type: 'facet-threw', method, error}`, distinct from both the `-32001` policy
  rejection and the `-32010` `bridge-down` paths.

## Dependencies

| Design | Relationship |
|---|---|
| [endo-claude](endo-claude.md) | **Consumer / harness.** Generates `--mcp-config` (with the guest formula id in `env`) and `--allowedTools` from the static guest-agent declaration, spawns the confined `claude -p` with structured stream output, and parses terminal, availability, usage, and quota events. Names this server as its "adapter-implementation prerequisite" and, in the confined shape, owns the harness-side connection process (broker) that holds the daemon reach outside the confined tree. **No consolidation owed** (PR #1226): endo-claude keeps its harness-owned broker (the confined, structural shape) and this document keeps the server-held connection (the single-tenant shape); both topologies stand, per the maintainer's "more than one way to use Claude" steer (Open Questions). |
| [endo-agent-tools](endo-agent-tools.md) | **Projection.** The MCP adapter (`packages/agent-tools/src/adapters/mcp.js`, a declared stub) that maps the static guest-agent `ToolRecord` declarations to MCP tools and binds `tools/call` dispatch to one guest facet. This server hosts it over stdio; it does not reinvent it. |
| [endo-gateway-mcp](endo-gateway-mcp.md) | **Sibling transport.** The HTTP-plus-bearer termination of the same projection; Design Decision 6 defers stdio to a local shim, which is this design. Shares the projection, the `initialize` response *shape*, and the `mcp__<server>__<tool>` naming *grammar* (each transport pins its own `serverInfo.name`, `endo` here vs `endo-gateway` there); differs in transport and isolation model (per-bearer on one endpoint there, per-process here). |
| [daemon-agent-tools](daemon-agent-tools.md) | **Guest-interface implementation.** Supplies operations over the guest's attenuated powers. It may change whether a declared operation succeeds, but it does not dynamically reshape the MCP catalog. |
| Endo daemon (`@endo/daemon`, `packages/where`) | **Session substrate.** Provides the client (`makeEndoClient` over `whereEndoSock(...)`, `getBootstrap`, `E(bootstrap).host()`) and the bootstrap root host against which `E(host).lookupById(formulaId)` (guarded `M.call(IdShape)` on `HostInterface`) resolves the formula id to a facet — the existing surface that reaches one guest with no new daemon method. A **daemon obligation for the confined shape** (direction set, PR #1226): publish a per-session, formula-id-scoped bootstrap (the ocapn offset-0 gateway brought forward) so the connection resolves only the one guest and carries no host authority into the confined tree; until then the confined shape rides the harness-owned broker narrowing a host-root connection (Open Questions). |
| [endo-posix-sandbox](endo-posix-sandbox.md) | **The confinement boundary (load-bearing).** Owns the per-spawn `bwrap` slice confining `claude`. The premise (PR #1226): the slice must **deny the confined `claude` tree the daemon socket and all system resources** — via the `none`/`private` network profile and filesystem-namespace isolation that keep the socket path out of the slice — forcing all authority through the MCP surface; **if `claude` can open an arbitrary domain socket, this design is forfeit**. Consequence: in the confined shape the daemon-connection process runs **outside** the slice (§ *Scoping*). This design carries no per-guest-socket re-mount or per-guest-uid `SO_PEERCRED` machinery; the remaining obligation is to confirm the slice denies `claude` the socket while the harness-owned connection process reaches it from outside. |
| [endopi-stdio-rpc-bridge](endopi-stdio-rpc-bridge.md) | **Framing precedent, not the same surface.** Its LF-delimited JSONL framing lesson (split on `\n` only) carries over; but it is a *drive-the-agent* RPC (prompt/steer/abort), not an MCP *tool-call* server, so it is prior art for framing only. |
| `kriscendobot/minion.town` PR [#79](https://github.com/kriscendobot/minion.town/pull/79) | **Naming convention, adopted (not a construction gate).** This server adopts its flat interface-native camelCase convention; it does **not** key any fail-closed construction throw on that PR's reserved-name list. A bare-name collision against its reservations is at most an advisory warning here. |

## Design Decisions

1. **Told its guest by env; always dispatch through that one guest facet and no
   other; where the daemon connection lives depends on the confinement posture.** The
   server reads the guest formula id from its environment (never from the MCP wire),
   resolves the one guest's facet, and serves **all** traffic against that one facet
   and no other — the confined `claude` is free to use whatever authority that guest
   holds, and nothing past it. The connection premise is not negotiable: the sandbox
   denies the confined `claude` (and its whole spawned tree) the daemon socket — **if
   `claude` can open an arbitrary domain socket the design is forfeit** (maintainer,
   PR #1226) — so a claude-spawned in-slice server cannot be the process that opens the
   connection in the confined case, because the socket it needs would then be
   `claude`'s too. Two legitimate, coexisting topologies follow, and this design keeps
   **both** rather than electing one (the maintainer's "more than one way to use
   Claude" steer, PR #1226): **(a) a harness-owned connection** — a broker outside the
   confined tree, or a daemon-issued **scoped bootstrap** (the ocapn offset-0 gateway
   brought forward) — for the confined, structural case; and **(b) a server-held
   connection** — the claude-spawned server opens the ordinary client itself — for the
   single-tenant deployment that does not confine `claude` against the socket. Structural
   cross-guest isolation is a property of the connection living outside the confined
   tree, never of formula-id secrecy (§ *Scoping*).
2. **The formula id is threaded from configuration through the environment, and
   never rides the MCP wire.** No bearer, no header, no port, no `initialize` param,
   no client-supplied field. An initial stdin handshake was considered and rejected
   for stdio MCP specifically, because the server's stdin is the *client's* channel, so
   a handshake would be either client-supplied (a forgery vector) or would require a
   trusted stdin intermediary (a broker-shaped process interposed on the server's
   stdin). The environment variable has neither problem, and the id can avoid an
   on-disk file entirely (§ *Threading the formula id from configuration*).
3. **One static guest-agent interface drives the server dispatch check (boundary)
   and the client allow-list (belt).** The harness and server import the same
   hardened declaration, following Lal's fixed tool records and bound dispatcher.
   The server rejects any `tools/call` outside it, names and arguments alike.
   `tools.listChanged` is false; grant changes affect the authority behind an
   operation, never the interface shape.
4. **Fail closed at construction and at request time.** A missing/unresolvable
   formula id, an unreachable daemon, or an empty static declaration is a
   construction throw (the server never serves `initialize`); a declared catalog
   whose own names are malformed, `__`-containing, or internally
   duplicate/case-confusable is likewise a construction throw; an unknown or malformed
   request is a JSON-RPC error. The construction throw keys only on properties of
   *this catalog against itself*, never on an unmerged, externally-owned reservation
   list. The server never exposes an empty surface as "confined" and never falls back
   to an unscoped one.
5. **Names are flat, interface-native, and reconciled.** The server label is the
   fixed literal `endo`; tool names follow the interface-native camelCase convention
   shared with the minion.town PR #79 manifest, with **no** transport/category prefix
   ever added. What is fixed here is the well-formedness the server enforces on its own
   declared catalog (no `__`, no dunder, no code-eval, no internal
   duplicate/case-confusable/malformed name); the shared *naming convention* is
   adopted while the foreign *reservation list* stays advisory.
6. **The harness consumes structured child-process signals.** It invokes
   `claude -p` with `--output-format stream-json --verbose`, validates the complete
   event stream and its single terminal prompt result, and retains structured usage,
   availability, and `rate_limit_event` quota fields. Missing telemetry remains
   unknown rather than being read as availability or zero quota use.

## Open Questions

- **Do NOT consolidate [endo-claude](endo-claude.md) onto a single topology
  (resolved, PR #1226).** An earlier revision proposed reconciling endo-claude's
  two-process adapter/broker split down to this document's single-process
  daemon-client model. The maintainer's steer is the opposite: *do not consolidate
  these yet — there is more than one way to use Claude and we expect to use them.*
  So both topologies stand as legitimate and expected, and neither document is
  "corrected" toward the other: endo-claude keeps its harness-owned broker (the
  structural, confined shape), this document keeps the server-held connection as the
  smaller single-tenant shape, and § *Scoping* now carries **both** explicitly rather
  than electing one. No cross-document reconciliation is owed; the remaining work is
  only to keep each document's confinement claims accurate to the shape it describes.
- **A per-session, formula-id-scoped bootstrap is the target for the confined shape
  (direction set, PR #1226).** The maintainer's model: the MCP server reaches the
  daemon through its Unix domain socket, **drills down to the guest facet, and always
  dispatches through that one guest and no other**; the confined `claude` is then free
  to use whatever authority that guest holds. The clean realization is a daemon that
  hands each session a bootstrap **already scoped to the one guest** (the ocapn
  offset-0 gateway brought forward over the daemon UDS: a guest-scoped agent rather
  than the host root), so the connection resolves only this guest and exposes no host
  authority. Remaining question: schedule — is this daemon obligation taken up now
  (the cleanest confined shape) or does the confined deployment first ride the
  harness-owned broker holding a host-root connection it narrows to one facet? Both
  keep the "always dispatch through the one guest" contract; they differ only in
  whether the narrowing is enforced by the daemon (scoped bootstrap) or by the
  harness (broker).
- **`claude`'s `--mcp-config` intake (resolved, PR #1226).** Pinned now, not
  deferred: `claude`'s `--mcp-config` is variadic and accepts a JSON file path or an
  inline JSON string, but the carrier is a **file *path* backed by an anonymous pipe /
  `memfd`** (no on-disk file, no inline JSON on argv, no shell process substitution),
  matching [endo-claude](endo-claude.md)'s already-pinned `--mcp-config` contract; the
  formula id rides in the config's `env` map and never touches a file
  (§ *Threading the formula id from configuration*). The only residual is re-checking
  the pinned CLI's config read pattern on each version bump (single startup read ⇒ a
  pipe is fine; a mid-session re-read ⇒ back the fd with a seekable `memfd`).
- **The daemon socket must NOT be reachable by `claude` from inside the slice
  (resolved, PR #1226).** Not an option to weigh: the confinement premise is that the
  sandbox denies the confined `claude` (and its whole spawned tree) access to all
  system resources, the daemon socket included, forcing it through the MCP surface —
  **if `claude` can open an arbitrary domain socket on the shared host, this design is
  forfeit** (maintainer). The "accept that `claude` can reach the socket and rely on
  formula-id secrecy" branch is struck. The engineering consequence is settled in
  § *Scoping*: because a claude-spawned in-slice server sharing the socket would grant
  `claude` the same reach, the daemon connection is held **outside** the confined tree
  (harness-owned broker, or a daemon-issued scoped bootstrap) in the confined shape.
  Remaining verification with [endo-posix-sandbox](endo-posix-sandbox.md): confirm the
  bwrap slice's `none`/`private` network profile plus filesystem-namespace isolation
  denies the socket path to the confined tree (the maintainer's "with sufficient flags"
  expectation), and that the harness-owned connection process runs *outside* that slice.
- **Logging (resolved, PR #1226).** The server **exposes a logging facet** and
  advertises the MCP `logging` capability; *how the logs are obtained is immaterial*
  (maintainer), so the source (stderr, facet diagnostics, or both) is an
  implementation choice behind the exposed facet, not a design fork
  (§ *The stdio transport*, `initialize`).

## Prompt

> Design a **stdio** MCP server such that a confined Claude has access to the
> tool-call surface **for a particular guest, denoted by formula identifier**.
> This is the surface the caplet of arc item 4 substitutes for Claude's built-in
> tools. Prior art (all HTTP-plus-OAuth): `endo-gateway-mcp`, `daemon-agent-tools`,
> `endo-agent-tools` (endojs/endo-but-for-bots); `mcp-daemon-guest-tools`,
> `mcp-endo-guest`, `mcp-oauth` (kriscendobot/minion.town). The arc needs the
> stdio one, for a process spawned as a child of the daemon on the same host,
> where OAuth is neither available nor meaningful. Decide whether an existing
> design extends cleanly to stdio or warrants its own document, and justify.
> Cover: scoping by formula identifier (the confinement boundary; the centerpiece);
> tool catalog derivation (pinned pre-pruned catalog driving both the allow-list
> and a server-side dispatch check, per `endo-claude`); the stdio transport
> (process lifetime, framing, child death, per-agent vs shared); fail-closed
> behavior (empty/underivable catalog is an error); naming (`mcp__<server>__<tool>`
> shape surviving a denied built-in set, no collision with the reconciled reserved
> names from kriscendobot/minion.town PR #79). Child of arc
> https://github.com/kriscendobot/garden/issues/89 (item 5). Deliverable: one
> design document, created or evolved. Do not build.
