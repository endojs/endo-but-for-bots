# Fork patches

Changes the deployment needs that are not upstream in
`kumavis/opencode@build/v1.18.30-opencode-patched` yet. `Containerfile.source`
applies every `*.patch` here, in name order, straight after the checkout.

Applied with `git apply` and no `--3way`. A patch that no longer applies to the
pinned commit fails the build, which is what should happen: the alternative is
a merge resolved by guesswork, producing a CLI that behaves in some third way
nobody wrote down.

## 0001-session-import-history.patch

Adds `POST /session/:sessionID/message/import` and the `SessionV2.importHistory`
service method behind it, so the stack can restore a conversation into a
session that has none — see `designs/hosted-agent-sandbox-unification.md`.

Two things about it are load-bearing rather than incidental:

**A user turn is imported as a `synthetic` message, not a prompt.** `Prompted`
belongs to the prompt-admission lifecycle: it is published by
`SessionInput.publish`, coupled to `session_input` rows carrying
`admitted_seq`/`promoted_seq`, and it queues work the runner executes. Importing
through it would make a restored conversation run itself again. `Synthetic` has
exactly one consumer — the projector — so it describes a turn without provoking
one. The assistant-side events the patch uses (`Step.Started`/`Ended`,
`Text.Started`/`Ended`, `Tool.Called`/`Success`/`Failed`) are the same: their
only consumer is the projector, and the runner module that names them is their
producer.

**The route reaches the v2 service directly rather than the v1 wrapper.**
`packages/opencode/src/session/session.ts` is a compatibility surface over a
parallel implementation and does not delegate to v2, so routing an import
through it would mean writing the same thing twice. `SessionV2.node` is already
in the server's layer.

An import only ever establishes a history: a session that already has messages
is refused, so a conversation the model is holding cannot be edited underneath
it.

Verified with `bun run typecheck` in `packages/core` and `packages/opencode`,
and `git apply --check` against the pinned commit. Not yet run against a live
server.
