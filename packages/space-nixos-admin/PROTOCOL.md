# NixOS host-admin spool protocol

This document specifies protocol version 2 between `NixosAdmin` and the
root-owned service that performs NixOS builds and activations.
An installation can implement the service as a NixOS module with systemd path
and service units; it does not need any Endo-specific NixOS configuration.

## Directories and authority

The administrator configures these paths:

- `ENDO_NIXOS_CONFIG_DIR` is a Git checkout containing a flake with
  `nixosConfigurations.<host>`.
  The daemon user may edit it; the root service may commit and reset it.
- `ENDO_NIXOS_DIR` is the apply spool.
  The daemon user may create requests and read statuses, outcomes, and logs.
  The service owns protocol metadata and writes statuses and outcomes.
- `ENDO_NIXOS_STATE_DIR` is optional and defaults to the parent of the apply
  spool.
  Its `deploy/` and `releases/` children implement the prebuild protocol.
- `ENDO_NIXOS_LOCK_DIR` defaults to `/run/lock/endo-nixos-admin` and is a
  protected lock directory shared by the daemon and privileged service.

The capability also creates two lock files of its own, inside the spools rather
than in the lock directory, because they guard the spool slots themselves:

- `$ENDO_NIXOS_DIR/submit.lock` serializes the submit-or-attach decision for
  `apply-request.json` across processes.
- `$ENDO_NIXOS_STATE_DIR/deploy/submit.lock` does the same for the prebuild
  spool's `request.json`.

Both are empty `flock(2)` anchors: nothing is ever read from them and their
contents carry no meaning.
The service does not take them — it is the single consumer, and the daemon side
is what needs mutual exclusion — but a service that validates or cleans a spool
directory must expect them and must not delete them.

Do not make either spool world-writable.
Give the daemon user write access only to request publication and the checkout;
status, outcome, log, and protocol files should be service-owned and readable
by that user.
The service must validate every request again rather than trusting directory
permissions as input validation.

## Current protocol marker

On every service start or system activation, atomically replace
`$ENDO_NIXOS_DIR/protocol.json` with:

```json
{
  "version": 2,
  "idEcho": true,
  "outcomes": true,
  "system": "/nix/store/...-nixos-system-host-version",
  "host": "flake-output-name",
  "configDir": "/canonical/path/to/checkout",
  "lockDir": "/canonical/path/to/lock-directory"
}
```

`system` must exactly equal the target returned by `readlink
/run/current-system`.
`host` must exactly equal the configured `nixosConfigurations` output name.
`configDir` must be the canonical path obtained by resolving every symlink in
`ENDO_NIXOS_CONFIG_DIR`.
`lockDir` is likewise the canonical path of `ENDO_NIXOS_LOCK_DIR`.
Binding the marker to the current system prevents an outcome written by an old
service, a different checkout, or a differently configured host from being
mistaken for proof that the installed service supports this protocol.
Write to a unique temporary file in the same directory, `fsync` it, and rename
it into place.

## Apply request and correlation

The capability atomically publishes `$ENDO_NIXOS_DIR/apply-request.json`:

```json
{
  "action": "build",
  "message": "operator audit note",
  "id": "caller-supplied-idempotency-key",
  "fingerprint": "sha256-of-bound-operation-fields",
  "configFingerprint": "sha256-of-the-exact-config-input",
  "protocolFingerprint": "sha256-of-the-protocol-binding",
  "nonce": "unique-publication-value"
}
```

`action` is exactly one of `build`, `switch`, or `rollback`.
`id` is an opaque, non-empty string.
The service must never use it directly as a path; use the same sanitization as
`sanitizeId()` and verify the raw `id` stored inside every record.
`nonce` distinguishes physical publications and has no idempotency meaning.
`fingerprint` is the lowercase SHA-256 digest of the UTF-8 encoding of
`JSON.stringify({ action, message, configFingerprint, protocolFingerprint })`.
It immutably binds an idempotency key to the requested operation while leaving
outcome `message` free for diagnostics.
`protocolFingerprint` is the lowercase SHA-256 digest of the UTF-8 encoding of
the following compact JSON object, with keys in exactly this order:

```json
{"version":2,"idEcho":true,"outcomes":true,"host":"...","configDir":"...","lockDir":"..."}
```

The values are exactly those validated in the current protocol marker, except
for `system`, which is intentionally omitted from this stable authority
binding.
The client still validates the marker's `system` against `/run/current-system`
before every submit-or-attach decision, but a successful `switch` changes that
symlink and can restart the client before it observes the outcome.
Omitting `system` lets that restarted client safely recover the outcome while
the host, checkout, lock namespace, and protocol version remain the same.
This prevents an outcome from another checkout, flake host, lock namespace, or
protocol generation from satisfying the current operation.

For `build` and `switch`, `configFingerprint` binds the request to the exact
checkout contents seen at publication time.
Walk entries in JavaScript string-code-unit order, omit any entry named `.git`
at every depth rather than only at the checkout root, and reject symlinks and
special files.
The capability refuses to write through such a path for the same reason, so no
content it can edit is outside the digest.
For each directory and regular file, hash its type (`d` or `f`), relative UTF-8
path, and low 12 permission bits as
`<type><path-byte-length>:<path><mode>:` where `mode` is decimal.
For a regular file, immediately append
`<content-byte-length>:<content>`.
Including directories and mode bits prevents an empty directory or executable
bit from changing the Nix input without changing the digest.

The known-answer tree below gives independent implementations a compatibility
check (the checkout root itself is not an entry):

```text
a.nix       regular file, mode 0644, content "abc\n"
empty/      directory, mode 0755
```

Its digest is
`fcedad18db84adbaf8935ae34ce543e024d36160a79125aaac195e25c5336dd2`.
For `rollback`, this field is `null`.
The service must reproduce the digest in a race-free staging area, build only
that content, and reject a mismatch; it must never sweep later checkout edits
into the operation.

Before doing work, the service checks
`outcomes/<sanitizeId(id)>.json`.
If that record embeds the same raw ID and exactly matches the request's
`action`, `fingerprint`, `configFingerprint`, and `protocolFingerprint`, the
request is already complete and must not run again.
If the raw ID matches but any bound field differs, stop with an idempotency-key
conflict; do not run the request and do not report the prior outcome as its
result.
If it embeds another ID, stop with a protocol error.

While running, atomically update `apply-status.json` with at least `id`,
`action`, `fingerprint`, `configFingerprint`, `protocolFingerprint`, and
`phase`.

The service must not leave a window in which neither `apply-request.json` nor
`apply-status.json` names the ID it is working on.
Concretely, it must publish the ID-echoing status durably — `fsync` and rename,
per "Atomic file publication" — and only then remove or overwrite
`apply-request.json`; the simplest compliant service never consumes the request
at all and lets the next publication replace it.
This is a MUST rather than a nicety because it is the only thing that closes
the last double-apply hole.
The capability decides a slot is free to claim when it sees no request and no
status for its own ID, and it holds `submit.lock` while deciding — but the
service does not take that lock, so a sample inside such a window would let an
at-least-once re-dispatch of an already-running key publish a second request.
For a `switch`, that means activating the host twice.
The capability cannot close this from its side; the service's ordering is what
makes the guarantee.

A status naming a *different* ID is already handled without help: while its
`phase` is nonterminal the capability treats the slot as busy even with no
request file present, so a consumed request does not let an unrelated operation
stack onto one that is still being health-checked.
That is why `phase` must reach `ok` or `error` on every operation, including
those that fail early — a status left nonterminal forever blocks later
submissions until they time out.

On completion, atomically write
`outcomes/<sanitizeId(id)>.json` with at least `id`, `action`, `fingerprint`,
`configFingerprint`, `protocolFingerprint`, `phase`, and a human-readable
diagnostic `message` when useful.
Terminal `phase` is `ok` or `error`.
Update `apply-status.json` to the same terminal record.
Append command output and diagnostics to `apply.log` without secrets.

## Action semantics

`build` evaluates and builds `$ENDO_NIXOS_CONFIG_DIR#<host>` without activation.
It must not change the system profile or run activation scripts.

`switch` creates an auditable Git commit using the request's `message`, builds
the content bound by `configFingerprint`, activates it, and checks
installation-defined health criteria.
Health criteria should be explicit NixOS options, such as required systemd
units or a fixed local command, rather than an Endo-specific gateway.
Record the last generation that passed those checks.
If activation or health checking fails, reactivate that last healthy generation
and restore the checkout to the configuration associated with it before writing
the terminal error outcome.

`rollback` reactivates the recorded last healthy generation and reports an
error if no such generation is known.
It does not apply uncommitted checkout edits.

The service serializes all three actions.
Checkout mutation APIs use an advisory `flock(2)` lock at
`$ENDO_NIXOS_LOCK_DIR/<sha256(canonical-config-dir)>.lock`.
Provision the lock directory so only the daemon user and root can create or
open its files; it must not be world-writable.
Any other daemon-user or privileged component that changes the checkout must
honor this lock, and the service must still stage and verify
`configFingerprint` rather than relying on the lock across a process restart.
It must not execute arbitrary commands or accept caller-provided flake paths,
host names, executable paths, or command-line options through the request.

## Prebuild protocol

`prebuildRev(rev)` uses `$ENDO_NIXOS_STATE_DIR/deploy/request.json`:

```json
{
  "action": "prebuild",
  "rev": "40-character-lowercase-Git-hash",
  "nonce": "publication-value"
}
```

Publish and read this file atomically.
While a request is active, retain it or atomically publish `status.json` with
the same `rev` and a nonterminal `phase` before consuming it.
The capability will not overwrite a request or active status for another
revision.
Every status record must echo both `rev` and `nonce`.
`phase` is exactly `queued`, `building`, `ok`, or `error`; only the first two
are nonterminal.
On failure, write
`{ "rev": "...", "nonce": "...", "phase": "error", "message": "..." }`.
A later request for the same revision but a different nonce is a new attempt
and may replace a terminal failed request.
The same nonce attaches to and returns the earlier failure.

Success is the durable marker
`$ENDO_NIXOS_STATE_DIR/releases/<rev>/.deploy-complete`, created only after the
entire release is usable.
A directory without this marker is an interrupted build, not success.
Prebuilding must not change the active system, a `current` symlink, or any
running service.

## Atomic file publication

Every JSON writer uses a unique temporary file in the destination directory,
flushes it, renames it over the public path, and flushes the containing
directory before acknowledging publication.
Readers treat only `ENOENT` as absence.
Malformed JSON, permission errors, and I/O errors are protocol failures and
must never be converted into permission to submit or repeat a privileged
operation.
