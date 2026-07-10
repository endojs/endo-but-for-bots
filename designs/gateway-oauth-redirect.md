# Gateway OAuth Redirect Relay

| | |
|---|---|
| **Created** | 2026-07-10 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |
| **Parent** | [endoclaw-oauth](endoclaw-oauth.md) |

## Summary

[endoclaw-oauth](endoclaw-oauth.md) settles the first-mint OAuth flow
as authorization-code with PKCE (RFC 7636) against a loopback redirect
(RFC 8252 § 7.3). Its Open Question 1 asks how a **remote, headless
daemon** runs that flow: the provider's redirect is a navigation of the
*user's browser*, so it can only land on a URL that browser can reach,
and a loopback listener on a remote host is not one.

The answer is a **redirect relay**: a public HTTPS route that receives
the provider's callback and conveys its two query parameters, `code`
and `state`, to the daemon. Everything else about the mint is
unchanged. This document pins the contract every relay obeys; the
mechanics of standing the route up are **specific to the cloud
provider that hosts the Endo Gateway**, so three sibling narratives
each instantiate the contract on one provider:

- [gateway-oauth-aws](gateway-oauth-aws.md): direct ingress on the
  AWS-deployed gateway.
- [gateway-oauth-cloudflare](gateway-oauth-cloudflare.md): tunneled
  ingress through the CloudFlare edge, with a Worker mailbox variant.
- [gateway-oauth-netlify](gateway-oauth-netlify.md): a dead-drop
  mailbox on Netlify Functions and Blobs.

Ground for this split was broken in the maintainer's `minion.town`
experiment (`kriscendobot/minion.town`, `designs/mcp-oauth.md`), whose
finding carries over: the server-side contract can be provider-neutral,
but hosting, routing, TLS, and state mechanics do not generalize
across providers and deserve separate narratives.

## What is the Problem Being Solved?

Three parties stand in three places:

- The **user's browser** is wherever the user is. The consent page and
  the redirect that follows it happen here.
- The **authorization server** (Google, GitHub, Microsoft) is public.
- The **daemon** is remote and headless: a VPS, an AWS instance, a
  machine behind NAT. It holds the PKCE `code_verifier` and the
  provider profile, and it must end up holding the token.

The loopback flow collapses the first and third party onto one machine.
When they separate, the redirect URI must name a public HTTPS route,
and that route must hand `code` and `state` back to the daemon. The
route is infrastructure the gateway hosting arrangement provides, so
its shape follows the cloud provider's shape.

This is **not** [gateway-oauth-bonding](README.md) (the M5 design gap):
that work bonds a user's OAuth *login identity* to a public-key
identity so the user can sign in to a hosted gateway. This work routes
the mint of a credential an *agent* uses without holding
([endoclaw-oauth](endoclaw-oauth.md)). The two share nothing but the
protocol family.

## The Contract

Every relay, on every provider, obeys the same contract. A narrative
that cannot satisfy a clause must say so explicitly.

### 1. The redirect URI is a stable, exact-match-registered HTTPS URL

The canonical shape is `https://<gateway-host>/oauth/callback`. It is
registered with the provider once, on the OAuth client, and providers
match it exactly (no wildcards, no path variance). Per-mint variance
therefore lives in `state`, never in the URI.

Moving off the loopback changes the **client type**: providers
classify a public HTTPS redirect URI as a *web application* client,
which carries a confidential `client_secret`. The
`OAuthProviderProfile` of [endoclaw-oauth](endoclaw-oauth.md) already
has the optional `clientSecret` field; in the gateway flow it is
load-bearing, and it lives **only in the daemon's encrypted formula
store**, never in relay infrastructure. Who performs the registration
remains endoclaw-oauth Open Question 2 (the registrar capability);
this design consumes a registration, it does not create one.

### 2. `state` is a single-use claim ticket

At flow start the daemon mints a 256-bit random `state` (the same
entropy discipline as
[daemon-256-bit-identifiers](daemon-256-bit-identifiers.md)) and files
a **pending-mint record** under it: provider profile reference, PKCE
verifier, requested scopes, creation time. The `state` is:

- **The correlator.** The callback carries it back; the daemon matches
  it to the pending record. An unrecognized `state` is dropped.
- **The CSRF binding** (RFC 6749 § 10.12). A callback an attacker
  forges without a live `state` does nothing.
- **The claim capability** in mailbox-shaped relays: whoever presents
  the `state` collects the parked `code`. It is unguessable, known
  only to the daemon, the user's browser, and the provider, and it is
  consumed on first use.
- **Expiring.** Pending records live ten minutes, matching typical
  provider authorization-code lifetimes, then cancel.

### 3. Custody invariants

1. The PKCE `code_verifier` never leaves the daemon.
2. The `client_secret` is never deployed to relay infrastructure.
3. The token exchange (RFC 6749 § 4.1.3) is always an **outbound**
   HTTPS request from the daemon to the provider's token endpoint.
   Every hosting shape below preserves this; only the inbound leg
   varies.
4. The relay sees at most `{ code, state }`. A stolen `code` is inert:
   redeeming it requires the verifier (invariant 1) and the client
   secret (invariant 2). A compromised relay can deny service and can
   observe that a mint happened; it cannot mint.
5. The minted token lands in the daemon's encrypted token record
   exactly as in [endoclaw-oauth](endoclaw-oauth.md) § Token, Facets,
   and Refresh. Nothing downstream of the token record changes.

### 4. The `RedirectRelay` seam

The daemon-side mint procedure gains one narrow seam where the
loopback listener used to be:

```ts
interface RedirectRelay {
  // What the authorization request's redirect_uri parameter carries,
  // and what the client registration must list, exact-match.
  redirectUri(): string;
  // Resolves when the callback for this state arrives, rejects on
  // timeout or cancel. Implementations deliver by direct route,
  // tunnel, or mailbox poll; the caller cannot tell which.
  awaitCallback(state: string): Promise<RedirectCallback>;
  cancel(state: string): void;
}

type RedirectCallback =
  | { ok: true, code: string }
  | { ok: false, error: string, errorDescription?: string };
```

The existing loopback listener becomes the first implementation. The
provider narratives supply the others: a route on the daemon's own
[web gateway](daemon-web-gateway.md) reached directly (AWS) or through
a tunnel (CloudFlare), and a mailbox poller (Netlify, and the
CloudFlare Worker variant). Which relay a host uses is deployment
configuration, chosen alongside the gateway hosting itself.

Above the seam, nothing moves: the mint sequence of
[endoclaw-oauth](endoclaw-oauth.md) § First Mint, the form-request
approval path, and the token record are identical. Design Decision 2
of that document (the flow is invisible to consumers) extends one
step: **the relay is invisible too**. A token minted through a Netlify
dead drop is indistinguishable, on every consumer surface, from one
minted on a loopback.

### 5. Delivery taxonomy

The three narratives are three answers to "how do `code` and `state`
cross from the public route to the daemon":

| Shape | The callback lands on | It reaches the daemon by | Narrative |
|---|---|---|---|
| **Direct ingress** | the daemon's own gateway HTTP listener, behind the provider's load balancer | the load balancer forwards inbound | [AWS](gateway-oauth-aws.md) |
| **Tunneled ingress** | the provider's edge | an outbound tunnel the daemon's host maintains | [CloudFlare](gateway-oauth-cloudflare.md) |
| **Dead-drop mailbox** | a stateless edge function that parks it in provider storage | the daemon polls, presenting `state` as the claim ticket | [Netlify](gateway-oauth-netlify.md) (CloudFlare Worker variant) |

```mermaid
sequenceDiagram
  participant B as User's browser
  participant P as Provider (accounts.google.com)
  participant R as Relay (public HTTPS route)
  participant D as Daemon (remote, headless)
  D->>D: mint state, verifier; file pending record
  D->>B: authorization URL (via Chat / CLI / form-request)
  B->>P: sign in, consent
  P->>B: 302 to https://gateway/oauth/callback?code&state
  B->>R: GET /oauth/callback?code&state
  R-->>D: deliver { code, state } (forward, tunnel, or parked claim)
  R->>B: static completion page
  D->>P: exchange code + verifier (+ client secret), outbound
  D->>D: store token record; mint facets per endoclaw-oauth
```

### 6. Completion page

The route answers the browser with a small static page: consent
received (or the provider's error, human-readable), return to your
Chat or terminal. It sets no cookies and follows no further redirects;
a fixed terminal page cannot be turned into an open redirector. A
deep link back into the requesting Chat session is a nicety deferred
to an open question.

## Threat Notes

- **Code interception at the relay.** Inert by custody invariants 1
  and 2; single-use and short-lived besides.
- **Forged or replayed callbacks.** Bound by `state`: unrecognized is
  dropped, recognized is consumed on first delivery, expired is
  dropped.
- **Authorization-server mix-up** (one callback route serving several
  providers). The pending record pins the provider; where the provider
  supports the `iss` authorization-response parameter (RFC 9207), the
  daemon verifies it against the profile's issuer before exchanging.
- **Query strings in edge logs.** Every hosting provider's access or
  function logs can capture the callback URL, `code` included. The
  code's inertness is the primary defense; each narrative also notes
  the provider-specific log hygiene, and where the authorization
  server supports the form-post response mode (OAuth 2.0 Form Post
  Response Mode, § 2), the profile may prefer it so the code travels
  in a POST body rather than the query string.
- **Relay availability.** A dead relay fails the mint loudly at the
  `awaitCallback` timeout; the flow is interactive, so the user sees
  the failure and retries. No token or consent is at risk.

## Dependencies

| Design | Relationship |
|--------|-------------|
| [endoclaw-oauth](endoclaw-oauth.md) | **Parent.** Resolves its Open Question 1; consumes its mint procedure, profile record, and token store unchanged. |
| [daemon-web-gateway](daemon-web-gateway.md) / [gateway-package](gateway-package.md) | **Substrate.** The ingress shapes mount `/oauth/callback` as a gateway route; TLS and header trust per gateway-package Feature 9. |
| [gateway-bearer-token-auth](gateway-bearer-token-auth.md) | **Precedent.** The loopback listener this generalizes, and the 256-bit bearer discipline `state` reuses. |
| [endopi-provider-registry-and-oauth](endopi-provider-registry-and-oauth.md) | **Beneficiary.** LLM-provider subscription mints share the first-mint plumbing, so they gain the relay seam for free. |
| [gateway-oauth-aws](gateway-oauth-aws.md), [gateway-oauth-cloudflare](gateway-oauth-cloudflare.md), [gateway-oauth-netlify](gateway-oauth-netlify.md) | **Instantiations.** One per hosting provider. |

## Implementation Phases

1. **The seam (S).** Extract `RedirectRelay`, re-express the loopback
   listener as its first implementation, thread it through
   `mintOAuthToken`. No behavior change for co-located hosts.
2. **The mailbox poller (S).** The provider-neutral client half of the
   dead-drop shape: poll a claim URL with `state`, back off, time out.
   Used by Netlify and the CloudFlare Worker variant.
3. **Per-provider routes.** Per the sibling narratives, each gated on
   its hosting substrate (M5 public hosting for the AWS shape).

## Design Decisions

1. **The relay relays; the daemon exchanges.** Every shape delivers
   `{ code, state }` and nothing else; the token exchange never moves
   off the daemon. Considered and rejected: exchanging at the edge and
   forwarding the token inward. Reason: it puts the client secret and
   a live token in relay infrastructure, violating the custody
   invariants for no latency the interactive flow can feel.
2. **One registered callback URL per client; per-mint variance rides
   `state`.** Providers exact-match redirect URIs, so the URI is
   configuration and the nonce does the work.
3. **The relay is invisible above the `RedirectRelay` seam.** Extends
   endoclaw-oauth Design Decision 2 to hosting: consumers, connectors,
   and the token record cannot observe which relay minted.
4. **Provider narratives are separate documents.** The maintainer's
   minion.town finding: hosting mechanics do not generalize. Each
   narrative must stand alone as a build foundation, sharing only this
   contract.

## Open Questions

1. **Multi-tenant client registration.** A hosted gateway serving many
   tenant daemons wants per-tenant redirect URIs, but registration
   effort and provider verification programs push toward one shared
   client. A shared client's secret cannot be distributed to tenant
   daemons without breaking custody invariant 2 across tenants. The
   registrar capability (endoclaw-oauth Open Question 2) is where the
   resolution lives; [gateway-oauth-aws](gateway-oauth-aws.md)
   § Multi-tenancy carries the concrete options.
2. **Should the completion page deep-link back into Chat?** A return
   link needs to know the requesting session without becoming a
   redirect vector. Deferred until the Chat-side mint UX exists.
3. **Form-post response mode per provider.** Worth adopting wherever
   supported to keep codes out of query-string logs; needs a
   per-provider capability check before it can be a profile default.

## Prompt

Origin: kriskowal review directive on endojs/endo-but-for-bots#621
(inline comment on `designs/endoclaw-oauth.md` Open Question 1,
2026-07-10):

> Please post a job to plan the gateway OAuth flow. We have broken
> ground on a potential design direction in minion.town. We find that
> the solution is very specific to the cloud provider, so we will
> likely want AWS Endo Gateway, CloudFlare Endo Gateway, and Netlify
> Endo Gateway designs, as separate but coherent narratives.
