# SES package amendments

Work in this package inherits the project-wide guidance in the
repository-root [`CLAUDE.md`](../../CLAUDE.md). The amendments
below are SES-specific; they extend (not replace) the global
rules for every role that operates here.

## Reviewer (juror, fixer, builder, designer): SES intrinsic naming

When the work touches a permits table, a shared-intrinsic
binding, or a design document proposing one, the same name
appears in three contexts and each wants a different surface
form (`%SharedURL%` in permits, `globalThis.URL` in compartment
code, bare `SharedURL` in pure prose). Mechanical
sed-substitution silently swaps consumer-facing surface for
permits-machinery surface and breaks the design's coherence.

Read [`../../skills/ses-intrinsic-naming.md`](../../skills/ses-intrinsic-naming.md)
in full before editing or reviewing such material. The skill
covers the three contexts, the precedents to follow
(`%Symbol%` / `%SharedSymbol%`, the Error constructor's
shared/start-compartment split), how to author a new shared
intrinsic, and the canonical session example (PR 84's
`%SharedURL%` correction).

## How to extend this file

This file is a **trigger** layer: succinct pointers at
canonical material in `roles/` and `skills/` at the repo root.
The detail belongs in the canonical files; this file directs
attention. See the trigger-and-filter convention in
[`../../skills/README.md`](../../skills/README.md).

When adding a new SES-specific amendment:

1. Land the canonical content in the relevant top-level role
   or skill (or a new skill).
2. Add a short section here naming the role(s) it amends and
   linking the canonical file.
