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
