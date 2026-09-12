# Sandbox network policy

Floot exposes operator-selected `off` and `public-internet` policies only when
the selected backend advertises enforcement support.
The Codex subscription backend defaults to `off`; public support requires an
explicit operator configuration and a compatible, pinned listener image.
Unsupported backends are not described as enforcing either policy.

An agent can inspect its policy or request a change with a reason.
A request does not grant access.
Only the operator session facet can apply a policy or approve the exact pending
request identifier; the model does not receive that facet.
Changes require settled turns, replace the runtime generation, and take effect
for the next turn.
An uncertain or incomplete change blocks further turns until explicitly retried.
The private policy journal reserves capacity for completing a later revocation.

## Scope and limits

`off` denies external sandbox networking.
Inference through the separately authorized broker and authority already granted
through Endo capability tools are outside this policy.

`public-internet` supplies an HTTP proxy to public port 80 and an opaque CONNECT
proxy to public port 443.
It permits uploads of workspace-accessible data to arbitrary public servers.
It does not grant direct sockets, UDP access, or standard SSH port 22.
CONNECT payloads are not inspected: this is not a guarantee that traffic on port
443 is HTTP, and it is not a data-loss-prevention system.

The host checks every DNS answer and rejects the whole result if any address is
private, loopback, link-local, metadata, reserved, or assigned to the host itself.
IPv4-mapped IPv6 and transition address ranges are also rejected.
Each connection resolves and pins an allowed literal address, without a second
implicit lookup.
Redirects return to the client and their subsequent proxy requests undergo the
same checks; the proxy does not follow redirects itself.
The classification intentionally excludes some special-use global exceptions.

The defaults bound concurrent host connections/resolutions to 8, admissions to
1,024, aggregate traffic to 2 GiB, DNS lookup time to 5 seconds, and connection
lifetime to 10 minutes.
These are resource ceilings per broker lease, not durable account or session
usage budgets; a replacement lease has fresh counters.
Revocation closes existing connections as well as rejecting new ones.
Uncancellable host DNS work retains its admission slot until it settles, even
after the caller's deadline expires.

## Broker separation

The outer listener namespace has only loopback and no external route.
The inference listener binds loopback, while the command proxy binds an
operator-owned public IPv4 address assigned as an isolated loopback `/32`.
That address does not create a route to the host or the public network.
Public traffic crosses the private capability pipe to the host-side filtered
transport; subscription credentials never enter the listener or model container.

Codex's managed proxy keeps local-address access disabled.
Its tool commands run in an inner network namespace with only the managed proxy
relay reachable; they cannot directly reach either outer listener.
Using a loopback upstream with local-address access enabled is unsafe: testing
found that an IPv4-mapped IPv6 target could bypass the intended upstream and
reach the inference listener.
The public profile must not reintroduce that exception.

A separate, bounded, one-shot helper configures the isolated namespace using
`NET_ADMIN` and then exits.
The listener and model containers retain dropped capabilities, including later
exec operations.
A generated, read-only `/etc/resolv.conf` contains only the isolated DNS listener
address and bounded resolver timeouts, not the host's resolver configuration.
The DNS adapter forwards validated A/AAAA hostname requests through a constrained
host capability rather than forwarding arbitrary DNS packets.

Runtime admission must verify the pinned images, namespace ownership and routes,
effective mounts, capabilities, exact merged Codex configuration, and live tool
isolation before advertising a usable session.
Unit fixtures are not evidence that a kernel applied these boundaries.

## Operator configuration

The subscription configuration accepts `publicInternet` with an operator-owned
IPv4 `address` and immutable `bootstrapImageRef`.
The existing `listenerImageRef` must be built from the Codex-specific
`src/provider-worker-entry.js`, which combines the inference listener with the
public proxy and DNS adapters.
The ordinary inference-only worker does not supply public networking.
Build the public listener with the explicit operator command
`node packages/hosted-agent/test/build-provider-image.js localhost/endo-codex-public --codex-public-network`.
Keep images pinned by digest and validate the complete production composition
before enabling the policy.
