# Claude hosted backend operator runbook

Use the daemon-owned hosted backend, not the removed inbox-form or peer credential factory.
The current architecture is described in [DESIGN.md](./DESIGN.md).

## Prepare the host

Use a Linux host with rootless Podman, the configured 9P mount helper, and the deployment's
pinned Claude and provider-listener images.
Configure the private sandbox runtime root and generated-file budgets before provisioning.
Configure Claude state, workspace and MCP roots under the deployment's owned data directory.
The exact accepted environment fields and validation are documented at the top of
[setup-host.js](./setup-host.js) and [setup-hosted.js](./setup-hosted.js).

Provision Floot's controller profile before binding the Claude backend.
Run the two setup entrypoints with the deployment environment and intended host powers:

```sh
endo run --UNCONFINED packages/claude-sandbox/setup-host.js --powers @agent
endo run --UNCONFINED packages/claude-sandbox/setup-hosted.js --powers @agent
```

A deployment may invoke these through its normal bootstrap instead.
Do not run both bootstrap and manual setup concurrently.
No `setup-peer.js`, form submission, credential sidecar, or generic factory step is needed.

## Configure credentials

Use the Secrets manager and the deployment's configured Claude credential names.
Do not paste credentials into chat, commit them, or store them in the model workspace.
Existing managed secrets are not overwritten by stale setup seed variables.
Subscription renewal and account selection belong to the provider broker; the CLI sees
only a placeholder and the broker's loopback endpoint.

Retained services keep their recorded identity and configuration.
Changing an environment variable is not a safe substitute for explicit reconfiguration
or credential-owner retirement.
Preserve a single renewal owner per subscription.

## Exercise a session

Create a Floot session using the Claude backend and a supported model.
Select a supported thinking level and an advertised network policy.
Ask it to write and read a small workspace file, then inspect the tool result in history.
Cancel a running turn and verify a subsequent turn can proceed.
Restart through the normal deployment lifecycle and verify transcript/workspace continuity.
Remove the test session and verify its native resources stop.

Arbitrary `/mnt` container attachments are currently unsupported by the Claude backend.
A refused attachment must not be treated as a successful bind.
Public-internet policy is proxy-mediated; tools must use the provided proxy/resolver.

## Retire the legacy topology before upgrading

Follow [legacy-retirement.md](./docs/legacy-retirement.md).
Stop old native work while its release is still available, verify cleanup, then retire
the old formulas or reset disposable daemon state.
Do not remove Secrets, current renewal owners, or retained workspaces during this cleanup.
Deleting an old entrypoint in Git does not prove its retained resources have stopped.

## Tests versus deployment acceptance

Run package unit tests and the platform-appropriate integration/9P suites.
Keep the required-integration switch enabled when using integration results as a gate;
an unavailable Podman image or mount prerequisite must not count as live acceptance.
Record the deployed revisions and actual create/tool/cancel/restart/remove results.
No deployment acceptance is implied by this documentation refresh.
