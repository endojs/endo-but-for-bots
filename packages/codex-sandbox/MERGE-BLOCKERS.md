# Merge blockers and follow-up dependencies

This branch deliberately extracts the protocol core without cherry-picking the
large hosted-management stack from exploratory PR #994. The following work must
land, receive its own review, and be rebased under any hosted deployment:

1. **Session provisioning and teardown.** Create one slice, workspace mount,
   disposable Codex home, process, and revocation context per Floot session.
   Failure at every intermediate step must unwind already-created resources.
2. **Credential broker.** Keep reusable credentials outside the slice and mint
   revocable, least-lived authority through a broker or API proxy in a separate
   protection boundary. A file mount is insufficient because Codex-launched
   commands share the app-server UID and can read `CODEX_HOME` by absolute path.
   Do not put tokens in the shared filesystem, environment, or process domain,
   and do not copy or bind a machine-wide `CODEX_HOME`.
3. **Sandbox guarantees.** Verify and test private-network policy (including
   loopback, link-local, RFC1918, IPv6, and DNS rebinding), cgroup/resource
   limits, process containment, and kill/reap behavior for the selected backend.
   Give tool subprocesses an egress policy distinct from Codex's brokered API
   channel, with negative tests proving tools cannot read credentials or reach
   disallowed Internet destinations.
   Define and test background-terminal cleanup between turns. App-server's
   `turn/interrupt` explicitly leaves background terminals running; the current
   client does not enable the experimental cleanup endpoint.
4. **Durable audit journal.** Record tool intent, approval decisions, results,
   cancellation, and failure append-only outside the editable conversation
   tree. Failed turns may have side effects and must remain observable.
5. **Explicit approval capabilities.** The core currently rejects every
   app-server request. Any UI or policy reviewer must be separately endowed and
   must not turn approval into a model-callable tool.
6. **Runtime mounts and MCP.** Projecting Endo capabilities or an MCP bridge into
   Codex expands authority and depends on the runtime-mount/MCP work from the
   exploratory branch. Review and land those independently before integration.
7. **Factory lifecycle and dynamic model UI.** Floot has a generic hosted-turn
   seam, but the factory must not advertise Codex until it can own teardown and
   obtain concrete model/reasoning choices from `CodexClient.models()` instead
   of static catalog entries.
8. **Failed-turn history reconciliation.** Codex keeps failed and cancelled
   turns in its stateful thread even when Floot does not commit them to its
   user-visible conversation tree. A hosted integration must either checkpoint
   and roll back the backend, or persist an explicit failed-turn record and
   reconcile both histories before the next prompt. Until then the generic seam
   is injection-only and the factory must not expose it.
9. **Reproducible image.** Codex CLI is version-pinned, but the base image must
   be digest-pinned and the resulting image identified by digest in deployment.

Relevant functionality already on `llm` and therefore not duplicated here:
FAE exec robustness, FAE compartment rules and sleep, reviewed-change
workflows, and mount-path documentation.
