# Mount CLI denied-segment overrides

| | |
|---|---|
| **Created** | 2026-07-21 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

## What is the Problem Being Solved?

PR [#650](https://github.com/endojs/endo-but-for-bots/pull/650) completed PR A
of the [mount-extensions reconstruction design (PR #648)](https://github.com/endojs/endo-but-for-bots/pull/648): a mount may be created with a `deniedSegments` iterable that replaces
`defaultDeniedSegments`. The option is already persistent and daemon-visible,
but the CLI has no corresponding authority surface. Consequently a CLI user
cannot make a mount with a project-specific deny set, or deliberately make one
with no deny set.

This is the deferred CLI follow-up tracked by
[issue #651](https://github.com/endojs/endo-but-for-bots/issues/651), promoted
to design in [the maintainer directive](https://github.com/endojs/endo-but-for-bots/issues/651#issuecomment-5029609203).

## Design

### Three creation states

The CLI must preserve all three states of the daemon option:

| User input | CLI value | Host-call option | Result |
|---|---|---|---|
| no deny option | `undefined` | omit `deniedSegments` | retain `defaultDeniedSegments` |
| one or more named segments | ordered strings | `deniedSegments: strings` | replace the default set |
| explicit denial disable | empty list | `deniedSegments: []` | deny no segment |

The omission rule is material: formula records intentionally omit the property
when it was not overridden, preserving the historical record shape for default
mounts. The command layer therefore must not pass
`{ deniedSegments: undefined }`; it conditionally spreads the field only for
the latter two states.

The implementation parses the option before calling `provideMount` or
`provideScratchMount`, then forwards the resulting replacement set unchanged.
It does not merge supplied names with `defaultDeniedSegments`: replacement is
the daemon option's established meaning. A caller that wants defaults plus a
name uses the eventual chosen CLI spelling for every desired segment.

### Command surface

The preferred shape is a repeatable, one-segment option:

```console
endo mount <path> --name work --denied-segments .ssh --denied-segments .env
endo mktmp --name scratch --denied-segments .credentials
endo mount <path> --name unrestricted --no-deny
```

`--denied-segments <name>` is repeatable, takes one path segment per occurrence,
and maps directly to the ordered list above. The scratch-mount spelling must be
attached to the existing scratch command as well as external `mount`; the
current CLI calls that command `endo mktmp`, although the originating issue
describes it as `endo mount --scratch`.

`--no-deny` is mutually exclusive with every non-empty deny option and is the
sole explicit-empty spelling proposed here. It is deliberately not an alias
for omission. The parser rejects a bare empty `--denied-segments=` value rather
than giving an empty string the accidental meaning of a path segment or an
empty set. Segment validation remains the daemon's normal mount-name validation;
the CLI should report a command-line error before contacting the daemon where
that validation can be shared safely.

### Help and diagnostics

Both command help pages must say that the named option *replaces* the default
restricted-segment set, rather than adds to it. The `--no-deny` help must state
that it passes an empty set and disables denial. It must also be clear that
leaving both options out retains the default protections. Mutual-exclusion
errors should name the conflicting flags and explain that one chooses a custom
set while the other chooses an empty set.

### Tests

Add CLI tests that cover the public command rather than only the option parser:

1. A custom set makes a name in that set inaccessible through the created
   mount, while a default-only name remains accessible, proving replacement.
2. `--no-deny` makes a normally default-denied fixture name accessible,
   proving that the CLI sends an explicit empty set rather than omitting it.
3. With no deny option, a default-denied fixture name remains inaccessible,
   protecting the omission behavior and formula-shape invariant.
4. Repeat collection, mutual exclusion, invalid empty-value rejection, and
   both command help surfaces have focused command/parser coverage.

The integration cases create external and scratch mounts through their CLI
commands, then exercise the mount capability so success demonstrates actual
daemon enforcement. Help tests must assert the replacement and empty-set
semantics, not merely the presence of flag names.

## Dependencies

| Design / change | Relationship |
|---|---|
| [mount-extensions reconstruction design (PR #648)](https://github.com/endojs/endo-but-for-bots/pull/648) § PR A | Defines the deferred CLI follow-up and the daemon-side semantics. |
| [PR #650](https://github.com/endojs/endo-but-for-bots/pull/650) | Supplies the shipped `deniedSegments` creation option and persistence plumbing. |
| [issue #651](https://github.com/endojs/endo-but-for-bots/issues/651) | Tracking issue for this CLI work. |

## Phased implementation

1. Register the selected option pair on external and scratch mount commands;
   resolve the three-state value and conditionally forward it to the matching
   host method.
2. Add help, validation, and parser coverage.
3. Add end-to-end CLI mount enforcement tests for custom, empty, and omitted
   sets.

## Open questions

- Should the public flag be the explicit `--denied-segments <name>` proposed
  here, the shorter `--deny <segment>`, or should one be a documented alias?
- Should scratch creation retain its current `endo mktmp` command spelling,
  gain `endo mount --scratch`, or support both while preserving compatibility?
- Should comma-separated values be accepted in addition to repeated options,
  and, if so, how should commas in an otherwise valid path segment be handled?
- Should an explicit empty `--denied-segments=` be accepted as an alias for
  `--no-deny`, or rejected so `--no-deny` remains the only unambiguous empty
  form?

## Prompt

> Design the CLI surface for the already-plumbed `deniedSegments` mount
> creation option: custom and empty replacement sets must reach external and
> scratch mount creation, preserve omitted-versus-empty semantics, document the
> behavior, and prove enforcement through the CLI.
