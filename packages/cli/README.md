# Endo CLI

The Endo command line is a user interface for managing the Endo application
runner (daemon).
This includes managing the lifecycle of the daemon process.

## In-flight design work

The CLI's `store`-family verbs are being reshaped under the design
[`designs/cli-store-verb-text-modes.md`](../../designs/cli-store-verb-text-modes.md).
That design unifies the source/sink, representation, and
formula-vs-mount axes across `endo store` and a new `endo write` /
`endo read` pair for mount-path mutation.
The implementation lands on a `master`-base PR; this entry is a tracking
placeholder on the `llm` roadmap branch and will be removed when the
implementation lands.
