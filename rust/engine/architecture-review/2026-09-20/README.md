# IronHorse architecture review: companion documents

Supporting material for [ARCHITECTURE-REVIEW.md](ARCHITECTURE-REVIEW.md), the
current-state architecture review of IronHorse published 2026-09-20.

**Reviewed commit:
[`62b907421`](https://github.com/endojs/endo-but-for-bots/commit/62b9074217aaf2907717f387ab2da98c54953f4b).**
Every source location and observed test result in this directory refers to that
commit.

## Process

The review used three parallel waves:

1. Three region readers mapped compiler/regexp, VM/runtime, and
   persistence/integration.
2. Three cross-cutting readers reviewed security/determinism, API/verification,
   and persistence/lifecycle.
3. Three adversarial verifiers checked code truth, significance/severity, and
   provenance against the prior review and current design records.

The main review contains only findings that survived those passes.
The maps retain useful mechanism detail and scope exclusions.
The lenses retain candidates that were demoted to deliberate limits, inherited
debt, or recommendations.

Unlike a revision of the 2026-09-06 review, this directory is a new snapshot at
the current commit.
It does not rewrite the earlier review's analysis or statuses.

## Region maps

- [Compiler, regexp, text, and meter](maps/compiler-regexp-meter-text.md)
- [VM and runtime](maps/vm-runtime.md)
- [Persistence and integration](maps/persistence-integration.md)

## Lens reports

- [Security and determinism](lenses/security-determinism.md)
- [API and verification](lenses/api-verification.md)
- [Persistence and lifecycle](lenses/persistence-lifecycle.md)

## Interpretation

The review reports nine current findings, but only three are new defects at this
commit: failed guest-compartment rollback, numeric-oracle undefined behavior,
and the two-part regexp conformance finding.
Other entries are known current risks, a documented lead promoted by structural
verification, inherited operational debt, or boundary hardening work.

The separate inherited-debt and deliberate-limits sections are intentional.
They prevent a fresh headline count from relabeling old decisions or fail-closed
phase gates as newly discovered corruption.

