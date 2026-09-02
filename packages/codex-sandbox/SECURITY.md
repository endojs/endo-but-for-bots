# Security model

The trusted computing base includes the host provisioner, credential broker,
audit anchor, and digest-pinned Codex CLI/app-server runtime.
Prompts, workspace data, dynamic-tool arguments, and model-launched commands
are untrusted.
App-server must write its credential-free state volume and is trusted to apply
the pinned per-turn `workspaceWrite` sandbox; compromise of that runtime is
outside the inner command-boundary threat model and requires revoking the image
digest.

`@endo/codex-sandbox` trusts only the digest-pinned Codex app-server component
described above, not the model or the commands that app-server launches on its
behalf.
The outer Endo slice is the host and cross-session authority boundary; the
pinned app-server's inner sandbox is the boundary between its own control state
and model-launched commands.
Codex's approval UI is not an authority boundary.

The lifecycle owner refuses to start a session unless the sandbox returns the
machine-checkable `HostedAgentPolicyV1` attestation specified in
[SANDBOX-CONTRACT.md](./SANDBOX-CONTRACT.md).
Inside that exact envelope, shell-command and file-change operation prompts are
automatically approved.
Permission-profile expansion is authority creation and is denied.
The outer kernel policy still denies every operation outside the endowed
workspace, process, network, mount, and resource boundaries.

Endo dynamic tools are capabilities, not ambient integrations.
Only the immutable catalog supplied at thread creation is callable.
Unknown tools, uncorrelated calls, account-token refresh, login, other-session,
remote-control, and every unknown app-server request are denied.
The model receives the run facet; the factory alone retains lifecycle
administration, the audit reader, and credential-broker administration.

`auth.json` and OAuth refresh tokens are password-equivalent.
They must never enter the session filesystem, environment, process namespace,
image, audit payload, or writable `CODEX_HOME`.
The per-session provider broker described in
[SUBSCRIPTION-AUTH.md](./SUBSCRIPTION-AUTH.md) is the only allowed model API
channel.

The durable audit journal is outside the workspace and slice.
Every append advances a head checkpoint through independently protected anchor
powers, so rolling back or deleting a valid suffix in the mutable entry store is
detectable on recovery.
The client awaits journal durability before dispatching a prompt, answering an
approval or Endo tool call, or reporting a terminal result.
Complete operation payloads are retained within the explicit audit-entry bound;
an oversized successful dynamic result quarantines the session instead of being
truncated or returned as an ordinary retryable tool error.
Built-in Codex item notifications are forensic: app-server may emit them only
after execution starts.
No code here claims write-ahead audit for built-in shell or file activity.

Failed and cancelled hosted turns remain security-relevant because their tools
may have produced side effects.
The client write-ahead journals the previous and current turn IDs, then rolls
an unacknowledged turn out of Codex's conversation history before the next
prompt.
Floot acknowledges a successful turn only after the corresponding conversation
node and usage total are durable.
Rollback does not undo filesystem, process, remote-capability, or network side
effects; those remain in the workspace and audit record.

For private vulnerability reports, follow the repository-level Endo security
policy.
