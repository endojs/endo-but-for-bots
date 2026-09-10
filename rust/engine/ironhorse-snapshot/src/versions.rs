//! Release and persistence compatibility: version ownership and upgrade rules.
//!
//! # Meter and compiler policy
//!
//! `COST_TABLE_VERSION` is owned by `ironhorse-meter/src/lib.rs` and re-exported
//! by [`ironhorse_vm::meter`]. A weight, charging-point or admission-policy change
//! requires an appended `releases::PINNED` entry, a new release literal and a
//! deliberate update of runtime/compiler/carried-state golden vectors together.
//! Never replace a historical release pin. Equal weight digests do not imply
//! equal charging policies: multiple release names can share one digest.
//! [`crate::image::MeterImage::validate`] requires both name and digest equality.
//!
//! `PARSE_METER_RELEASE` in `ironhorse-compile/src/meter.rs` is an alias of
//! `COST_TABLE_VERSION`, not an independent counter. Compiler accounting changes
//! use the same release procedure; a separate parse version must not be revived.
//!
//! # Storage encodings
//!
//! [`crate::format::IRONHORSE_FORMAT_VERSION`] governs container encoding and
//! interpretation. Change it when the wire contract changes, with explicit reader
//! support or refusal. [`crate::format::IRONHORSE_FORMAT_VERSION_MIN_READ`] names
//! the readable range, not an unconditional execution-compatibility promise.
//! Meter, callback signature and boot identity checks apply independently.
//!
//! [`crate::store::STORE_SCHEMA_VERSION`] governs the paged-store representation,
//! manifest and small-state layout. A change needs a schema bump plus a verified
//! migration step or explicit refusal. [`crate::store::migrate_store`] authenticates
//! old state before restamping and advances monotonically through supported schemas.
//! It does not translate execution semantics across meter releases.
//!
//! # Intl data and derived identity
//!
//! Generated `ironhorse-vm/src/intl_profile.rs` exposes `INTL_DATA_VERSION` as
//! `Intl.__ironhorseDataVersion`. `scripts/intl-profile.py` binds the in-tree
//! profile to locked ICU versions, checksums, dependency edges and root features;
//! CI rejects stale generation. Custom data builds are outside this profile.
//! In-tree locale algorithm/table changes still require deliberate release review.
//!
//! [`ironhorse_vm::Interp::boot_fingerprint`] hashes ordered intrinsic layout,
//! the Intl profile and the selected deterministic Math provider. SIGN therefore
//! refuses incompatible profiles before execution. A matching cost-table digest
//! alone does not establish execution compatibility.
//!
//! # Upgrade consequence
//!
//! Old-meter heaps cannot resume on the new engine merely by migrating their
//! container/store schema. Retain the old executable to drain/export state, or
//! reboot from an approved initial state under an explicit worker transition plan.
//! There is no general cross-meter heap translator. Execution determinism remains
//! scoped per release binary per platform, with matching initial state, inputs and
//! host policy; a platform-independent weight digest is not an execution guarantee.
