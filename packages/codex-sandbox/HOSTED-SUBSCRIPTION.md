# Experimental hosted Codex subscription

Codex now uses the shared native sandbox service, session owner, broker scopes,
and session supervisor.
The app-server protocol and subscription adaptation remain Codex-specific.
Existing volume-based deployments require explicit retirement, not in-place migration.

## Provisioning

Run `setup-host.js` and then `setup-hosted.js` through Endo with host powers.
Both can run in `ENDO_EXTRA`; hosted setup requires `ENDO_CODEX_ENABLE=1`.
The first retains native runtime and state-provider formulas.
The second retains broker and session-storage services and publishes a replaceable
backend to Floot only after construction succeeds.
Retained services must match entrypoint, environment, and immutable powers identity;
changing these requires deliberate retirement.

The backend records plans and dependency identities before native startup.
The shared supervisor owns partial acquisitions and cleanup retry.
Stop fences inference immediately, then removes the broker namespace and 9P
projection only after sandbox closure.

## Authentication

Import a fresh, complete renewal-bearing Codex login into general Secrets at
`secrets/codex-subscription-auth`, or the configured Secrets name.
Normalize it to `BrokerOAuthStateV1` before setup.
Do not paste credentials into chat, command arguments, repositories, or logs.
Setup validates the format and pins the account rather than converting credentials
on each daemon start.
The retained broker owns refresh and compare-and-swap rotation.
Its grant attests the shared `oauth` mechanism and the pinned ChatGPT origin and
account; subscription routing is supplied by Codex's fixed host-side provider
adapter, not by a special authentication mode in the shared broker.
The adapter permits only non-stored streaming Responses requests and supplies
the account header after guest headers have been screened.
An access token alone is insufficient; neither access nor refresh tokens enter
the model sandbox.
Changing accounts requires deliberate service retirement.

## Several subscriptions

One Codex backend can spend several ChatGPT subscriptions.
Set `ENDO_CODEX_SUBSCRIPTIONS` to a JSON list, one entry per subscription:

```json
[
  { "id": "work", "label": "Work Pro", "weight": 20, "credsName": "codex-work-auth" },
  { "id": "home", "label": "Home Plus", "credsName": "codex-home-auth" }
]
```

- `id` names the subscription everywhere: in the picker, in a session's
  record, in the account oracle's name (`codex-account-<id>`).
- `credsName` is the Secrets name of that subscription's imported, normalized
  `BrokerOAuthStateV1` credential, as for a single subscription.
  Each entry needs its own, and no two may name the same account.
- `label` defaults to the id; `weight` (the relative size of the plan, used to
  show comparable capacity) defaults to 1.
- `accountRef` may be given; by default it is the account the credential
  itself names. It is checked against every credential read, as before.
- `ENDO_CODEX_CACHE_LIFETIME_SECONDS` (default 300) is how long a session stays
  on the subscription that last served it, which is how long the provider
  keeps its prompt cache warm.

In this mode `ENDO_CODEX_CREDS_NAME` and `ENDO_CODEX_ACCOUNT_REF` are not read.

Setup mints a managed renewable credential per subscription
(`codex-sandbox/credential-<id>`) and a namespace, `codex-sandbox/broker-powers`,
which holds each credential under `secret-<id>`, the declared set as the
stored value `subscriptions`, and what the pool keeps between restarts
(`pool-state-v1-*`: which members refused and until when, and where each
session was last served). The broker's powers are that namespace.

**Choosing.** A session is created with `subscription: "auto"` (the default) or
an id. `auto` spends from the subscription whose weekly window resets soonest,
stays on the one that last served the session while the cache is warm, and
hands a request to the next subscription when one refuses it as used up; the
CLI sees one response. A pinned session uses its subscription and no other.
See [`designs/hosted-agent-subscriptions.md`](../../designs/hosted-agent-subscriptions.md).

**Adding a subscription** is an edit of the list and a new credential in
Secrets; the next daemon start stores the new set, and sessions opened after
that can use it. Nothing is retired. Sessions already open keep the set they
started with until their next incarnation.

**Changing the account of an existing id is refused.** A different account is
a different subscription: add it under a new id. Removing an id leaves its
credential formula and oracle behind, unused; a session that was pinned to it
runs on `auto` from then on, and says so in the daemon's log.

**Moving a deployment from one subscription to several is a retirement.**
The broker then holds a namespace instead of a credential, so setup refuses
until `codex-sandbox/broker-service` has been retired deliberately, and it
refuses before it mints anything.
Existing Codex sessions do not carry over: a session's plan records the
account its broker was bound to, that record cannot change, and a pooled
broker's is the label `pool`. Their transcripts stay in Floot.
Use a `credsName` other than the single subscription's, so that two credential
formulas never renew one secret record.

## Sharing the subscription

A **share** is this subscription within limits you choose, as a capability you
can hand to somebody else: metered inference against your account, with no
path to the credential, the accounts, their windows or the reset credits.
Whoever holds it can call it from any client, and you can read every request
sent through it.

Setup keeps `codex-sandbox/subscription`, the broker as a `Subscription`,
whole and unmetered. It is what shares are made over and is given to nothing
else. A share is made by the operator's provisioning step
`provideSubscriptionShare` (`@endo/hosted-agent/hosted-setup.js`), since only
a host can mint a formula:

```js
await provideSubscriptionShare(host, {
  label: 'Codex',
  dir: 'codex-sandbox',
  shareId: 'alice',
  limits: {
    budget: { tokens: 2_000_000, periodSeconds: 86_400 }, // weighted tokens a day
    reserve: 0.25, // refuse while under a quarter of the window is left
    models: ['gpt-5.2-codex'],
    maxConcurrentRequests: 2,
    expiresAt: '2026-12-31T00:00:00Z',
  },
});
```

It makes three names under `codex-sandbox`:

| Name | What it is |
| --- | --- |
| `share-alice` | the share. **This is the name to hand over.** |
| `share-alice-kit` | yours: `revoke()`, `getStatus()`. Never handed out. |
| `share-alice-powers` | its namespace: the limits, the meter, the revocation. |

Calling it again with other limits rewrites them and nothing else; the share
reads them for every request. The budget's periods are anchored at the
share's creation and do not move.

**Metering.** A request reserves an estimate (its size plus the output it
asks for, or `outputEstimate`, 8192 by default) and is refused with
`Provider share exhausted` if that does not fit. At the end of the response
the reservation is replaced by what the response cost, cached input at a
tenth. A response that was cut short, timed out, or never said what it cost
is charged its reservation, or its size if that is more, never less. A
restart does not refill a budget, and a revoked share revives revoked.

**A share in your own pool.** A member of `ENDO_CODEX_SUBSCRIPTIONS` may be
somebody else's subscription that they handed you: store their share under a
pet name and declare `{ "id": "friend", "shareName": "from-carol" }` in place
of `credsName`. It has no credential or account of yours. It is ranked by the
budget its grantor gave it, shown in the Subscriptions panel as a window, and
a request it refuses as used up goes on to your next subscription. A listener
image from before the bytes stream is never served by such a member.

Nothing here has run against a peer connection yet: see "Known Gaps" in
[`designs/hosted-agent-subscriptions.md`](../../designs/hosted-agent-subscriptions.md).

## Lending the machine

A **delegated runner** is this backend within limits you choose, as a
capability you can hand to somebody else: they add it to their own Floot as a
backend, and their sessions are harnesses on your machine, working on their
project with their own tools. Their Floot and its transcripts stay with them.
That is not confidentiality from you: you can read everything a harness on
your machine does.

A runner's sessions spend one subscription that you name, and it should be a
lane set aside for them: a share, held in the broker's pool and marked
`pinnedOnly`, so your own sessions never drain it and its limits meter them.

1. Make the share (`provideSubscriptionShare`, above), of your own
   subscription or one they handed you. Give it its own `expiresAt` and
   `models`: a request finally passes the share, not the runner.
2. Declare it as a lane in `ENDO_CODEX_SUBSCRIPTIONS`:
   `{ "id": "lane-alice", "shareName": "alice-share", "pinnedOnly": true }`,
   where `alice-share` is a pet name you copied `codex-sandbox/share-alice`
   to. Restart.
3. Make the runner, and hand over `codex-sandbox/runner-alice`:

```js
await provideDelegatedRunner(host, {
  label: 'Codex',
  dir: 'codex-sandbox',
  runnerId: 'alice',
  limits: {
    subscription: 'lane-alice',
    maxSessions: 2,
    networkPolicies: ['off'], // the default: a harness reaches nothing
    models: ['gpt-5.2-codex'],
    storage: 'unbounded', // no adapter bounds a session's directory yet
    expiresAt: '2026-12-31T00:00:00Z',
  },
});
```

`codex-sandbox/runner-alice-kit` is yours: `revoke()` takes effect at once,
refuses every further turn and new session, durably, stops its sessions and
answers which could not be stopped; it destroys nothing. A holder can create, stop and
destroy only sessions of that runner, and a session's spec may not name a
host path, a container mount, a subscription or a working directory.

A runner's id has letters, digits and `_`, and no `-`. It must spend a lane
set aside (a share, `pinnedOnly`); `unmetered: true` is your explicit word
that it may spend an account whole. A holder's Floot cannot use presets that
declare a workspace object or container mounts with it: those name a path on
their machine, which the runner refuses.

Moving a deployment to a pool is a retirement of its broker (see "Several
subscriptions"), so a lane needs a pooled broker to begin with.

## Operator settings

Required hosted settings are `ENDO_CODEX_ENABLE=1`, `ENDO_CODEX_HOST_DIR`,
`ENDO_CODEX_SANDBOX_IMAGE`, `ENDO_CODEX_BROKER_LISTENER_IMAGE`,
`ENDO_CODEX_NATIVE_PROFILE` (JSON), and `ENDO_CODEX_MODELS` (nonempty JSON array).
The runtime image is resolved to a digest; the listener reference must be immutable.

Optional `ENDO_CODEX_WORKSPACE_DIR` and `ENDO_CODEX_PRIVATE_DIR` default to
`workspaces` and `sessions` beneath the host directory.
The broker uses its `broker` subdirectory.
Guest roots, including external workspaces, must not overlap protected state,
native runtime, or broker storage, including through symlinks.

Other options include `ENDO_CODEX_CREDS_NAME`, `ENDO_CODEX_ACCOUNT_REF`,
`ENDO_CODEX_SUBSCRIPTIONS`, `ENDO_CODEX_CACHE_LIFETIME_SECONDS`,
`ENDO_CODEX_MAX_SESSIONS`, `ENDO_CODEX_PUBLIC_INTERNET=1`, and
`ENDO_CODEX_DIAGNOSTICS=1`.
Projection settings accept `NINEP_MOUNT_PROGRAM`, `NINEP_UMOUNT_PROGRAM`,
and `NINEP_SUDO=1`.
See the setup scripts for native service settings and exact validation.
No volume registry, project-ID range, storage lease, or quota helper is required.
Persistent directories currently have no per-session kernel disk quota;
tmpfs limits do not bound workspace or CLI-home growth.

## State and continuity

Host records and guest-writable CLI home occupy separate owned directories.
Only the CLI-home leaf is mounted into the guest.
After native cleanup, session deletion removes owned workspace, private projection
directories, CLI home, and records; an external workspace is preserved.

Floot stack records are authoritative across controller incarnations.
Codex reconciles an inherited thread's write-ahead marker before superseding it
and restoring the conversation into the new thread as Responses API items through
`thread/inject_items`, built from the stack's transcript records
(`@endo/hosted-agent/transcript-records.js`): a tool call arrives as a
`function_call` with its output, never as text about one, and nothing is
redispatched.
Successive turns within an incarnation retain their app-server and thread.
Tool-catalog changes also require rotation.
A thread that cannot take the records fails the turn visibly instead of
answering without them; there is no size at which the stack declines to restore.

## Evidence and limits

Earlier Tokyo tests established subscription renewal, Floot inference, Endo tool
calls, durable replies, and stack-authoritative restoration.
They used the retired volume implementation and do not certify this migration.
Its fresh lifecycle and restart gate remains pending.
See [deployment acceptance](./DEPLOYMENT-ACCEPTANCE.md).

Session grants have no cumulative request-count or one-hour lifetime budget.
Concurrent-request and per-message bounds remain.
Transport and journal bounds still require the remaining design audit.
The subscription route is empirically tested, not asserted to be a stable vendor
contract; pin and revalidate the runtime before upgrades.
