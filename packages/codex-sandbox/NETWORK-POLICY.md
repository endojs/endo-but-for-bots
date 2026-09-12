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
The inference listener and public proxy bind `127.0.0.1` on separate ports.
The public DNS adapter binds `127.0.0.53`.
These listeners do not create a route to the host or the public network.
Public traffic crosses the private capability pipe to the host-side filtered
transport; subscription credentials never enter the listener or model container.

Codex and its native commands share the outer container's authority, including
access to the inference listener, public proxy, and writable native state.
The pinned 0.152.0 process/thread configuration uses `danger-full-access` because
those interfaces have no external-sandbox mode.
Every turn supplies `externalSandbox` with `networkAccess` set to `enabled` for
admitted public networking or `restricted` otherwise.
Codex's managed proxy is disabled; the outer namespace and host egress service
apply the network policy.
These settings are appropriate only inside the verified outer sandbox.
The listener and model containers retain dropped capabilities, including later
exec operations; public networking needs no privileged setup helper.
A generated, read-only `/etc/resolv.conf` contains only the isolated DNS listener
address and bounded resolver timeouts, not the host's resolver configuration.
The DNS adapter forwards validated A/AAAA hostname requests through a constrained
host capability rather than forwarding arbitrary DNS packets.

Runtime admission must verify the pinned images, namespace ownership and routes,
effective mounts, capabilities, exact merged Codex configuration, and guest child
access to the granted writable mounts before advertising a usable session.
Unit fixtures are not evidence that a kernel applied these boundaries.
The runtime preflight executes Python children; it does not establish how the
pinned Codex app-server executes native commands.
The public-network acceptance command similarly probes the outer container,
including direct guest listener access and proxy rejection of private destinations.
Live app-server acceptance covering thread start, resume, and multiple turns with
native commands remains outstanding.

## Operator configuration

The subscription configuration accepts `publicInternet: true` to make the
public policy available; it defaults to false.
Each session must still receive a separate public-egress capability to activate
its listeners.
No public bind address or helper image is configured.
The `listenerImageRef` uses the shared hosted-agent worker, which combines the
inference listener with optional public proxy and DNS adapters.
The host must explicitly supply and activate public network authority; the same
image serves sessions whose public network policy is off.
Build the listener with the explicit operator command
`node packages/hosted-agent/test/build-provider-image.js localhost/endo-provider`.
Keep images pinned by digest and validate the complete production composition
before enabling the policy.
