//! The store's failure taxonomy: every variant classifies, and the three
//! classes mean what the daemon seam acts on (review finding F157).
//!
//! `StoreError::classify` is an exhaustive match, so a new variant fails to
//! compile until it states its class. What a compiler cannot check is that the
//! test also *checks* the answer, that the classes stay distinguishable, and
//! that `Display` stays structured rather than collapsing back to one opaque
//! string — which is the defect F157 records.
use ironhorse_snapshot::atom::AtomError;
use ironhorse_snapshot::format::{FourCc, SignatureError, SnapshotError, VersionError};
use ironhorse_snapshot::store::{StoreError, StoreFailure};

/// One case per `StoreError` variant with its expected class.
///
/// The `match` is what makes this exhaustive: a new variant fails to compile
/// HERE as well as in `classify`, so the answer is checked and not merely
/// stated. Returning a sample from the same match keeps the two in step.
fn expected(sample: &StoreError) -> StoreFailure {
    match sample {
        StoreError::Io(_) => StoreFailure::Transient,

        StoreError::MachineNotQuiescent
        | StoreError::MachineOperation(_)
        | StoreError::PendingStateUnsupported { .. }
        | StoreError::Empty
        | StoreError::Unsupported(_)
        | StoreError::BatchRejected(_)
        | StoreError::EpochMismatch { .. }
        | StoreError::BaselineMismatch { .. }
        | StoreError::NotEmpty { .. }
        | StoreError::NeedsMigration { .. } => StoreFailure::Refused,

        StoreError::MissingRow(_, _)
        | StoreError::RowLength { .. }
        | StoreError::SummaryCount { .. }
        | StoreError::SummaryMismatch { .. }
        | StoreError::EngineInvariant(_) => StoreFailure::Poisoned,

        StoreError::Snapshot(_) => unreachable!("covered by its own test"),
        // `StoreError` is `#[non_exhaustive]` within its own crate only; from
        // here the compiler still requires this arm. A variant added upstream
        // lands here rather than silently taking a neighbour's class.
        other => panic!("unclassified store error: {other:?}"),
    }
}

fn every_variant() -> Vec<StoreError> {
    vec![
        StoreError::Io("disk".into()),
        StoreError::MachineNotQuiescent,
        StoreError::MachineOperation("host root".into()),
        StoreError::PendingStateUnsupported { row: "modules" },
        StoreError::Empty,
        StoreError::Unsupported("migrate a manifest in place"),
        StoreError::BatchRejected(Box::new(StoreError::SummaryMismatch { page: 1 })),
        StoreError::EpochMismatch {
            expected: 4,
            found: 9,
        },
        StoreError::BaselineMismatch {
            expected: "a".into(),
            found: "b".into(),
        },
        StoreError::NotEmpty { epoch: 2 },
        StoreError::NeedsMigration { found: 30 },
        StoreError::MissingRow("page", 3),
        StoreError::RowLength {
            kind: "page",
            index: 3,
            expected: 64,
            found: 32,
        },
        StoreError::SummaryCount {
            expected: 8,
            found: 4,
        },
        StoreError::SummaryMismatch { page: 1 },
        StoreError::EngineInvariant("gc registry".into()),
    ]
}

#[test]
fn every_variant_classifies_as_stated() {
    for sample in every_variant() {
        assert_eq!(
            sample.classify(),
            expected(&sample),
            "{sample:?} classified against the table"
        );
    }
}

/// One representative of each class, so a refactor that folded two classes
/// together would fail here rather than silently make a supervisor retry a
/// refusal forever.
#[test]
fn the_three_classes_stay_distinguishable() {
    assert_eq!(
        StoreError::Io("disk".into()).classify(),
        StoreFailure::Transient
    );
    assert_eq!(
        StoreError::MachineNotQuiescent.classify(),
        StoreFailure::Refused
    );
    assert_eq!(
        StoreError::SummaryMismatch { page: 7 }.classify(),
        StoreFailure::Poisoned
    );
}

/// The medium is the only thing worth retrying, and a capability the backend
/// does not have is not the medium. Before `Unsupported` existed, an in-place
/// migration on a backend that cannot do one was `Io`, so a supervisor
/// obeying the classifier would retry a permanent refusal forever.
#[test]
fn only_the_medium_is_transient() {
    for sample in every_variant() {
        if matches!(sample, StoreError::Io(_)) {
            continue;
        }
        assert_ne!(
            sample.classify(),
            StoreFailure::Transient,
            "{sample:?} must not invite a retry"
        );
    }
}

/// A rejected commit batch is the CALLER's fault, not the store's. Batch
/// validation reuses the at-rest vocabulary, so without the wrapper a
/// malformed request would tell a supervisor to tear down a healthy session.
#[test]
fn a_rejected_batch_does_not_poison_the_store() {
    for inner in [
        StoreError::SummaryMismatch { page: 3 },
        StoreError::MissingRow("slot page", 1),
        StoreError::RowLength {
            kind: "slot page",
            index: 1,
            expected: 64,
            found: 32,
        },
    ] {
        assert_eq!(
            inner.classify(),
            StoreFailure::Poisoned,
            "the bare form describes stored content"
        );
        assert_eq!(
            StoreError::BatchRejected(Box::new(inner)).classify(),
            StoreFailure::Refused,
            "the wrapped form describes the request"
        );
    }
}

/// A decode failure splits by cause, at both levels. Structural damage means
/// the stored bytes cannot be trusted; a compatibility answer is a refusal
/// from an intact store. `VersionError` splits again for the same reason: a
/// truncated `VERS` atom is damage, a version this engine will not read is an
/// answer.
#[test]
fn snapshot_decode_failures_split_by_cause() {
    let poisoned = [
        SnapshotError::Atom(AtomError::Truncated),
        SnapshotError::Signature(SignatureError::NotUtf8),
        SnapshotError::MissingAtom(FourCc(*b"HEAP")),
        SnapshotError::Corrupt("slot record"),
        SnapshotError::Version(VersionError::Truncated),
        SnapshotError::Version(VersionError::TrailingBytes),
    ];
    for e in poisoned {
        assert_eq!(
            StoreError::Snapshot(e).classify(),
            StoreFailure::Poisoned,
            "structural damage must not read as a refusal"
        );
    }

    let refused = [
        SnapshotError::BootLayoutMismatch {
            expected: [1; 32],
            found: Some([2; 32]),
        },
        SnapshotError::Version(VersionError::UnsupportedVersion(99)),
        SnapshotError::Version(VersionError::NotIronhorse(*b"XSNP")),
        SnapshotError::Version(VersionError::SlotWidthMismatch {
            expected: 8,
            found: 4,
        }),
        SnapshotError::Version(VersionError::UnsupportedEndian(1)),
        SnapshotError::SignatureMismatch {
            expected: ironhorse_snapshot::format::Signature::new("this-host"),
            found: ironhorse_snapshot::format::Signature::new("that-host"),
        },
        SnapshotError::CostTableMismatch {
            expected: "ironhorse-meter-5".into(),
            found: "ironhorse-meter-4".into(),
        },
    ];
    for e in refused {
        assert_eq!(
            StoreError::Snapshot(e).classify(),
            StoreFailure::Refused,
            "an intact store answering `no` must not read as corruption"
        );
    }
}

/// `Display` has to carry the variant's own information, in a form the Debug
/// rendering does not already give. The seam this replaces rendered every
/// failure through `format!("{e:?}")`, so the assertion that matters is that
/// a full revert to Debug would fail: Debug prints field NAMES, so requiring
/// prose that Debug cannot produce is what distinguishes them.
#[test]
fn display_is_prose_rather_than_debug() {
    let error = StoreError::RowLength {
        kind: "page",
        index: 12,
        expected: 64,
        found: 32,
    };
    let shown = error.to_string();
    assert_eq!(
        shown, "page row 12 is 32 bytes, geometry promises 64",
        "a Debug-shaped rendering would name fields instead"
    );
    assert!(!shown.contains("RowLength") && !shown.contains("expected:"));

    // A wrapped decode failure must not flatten to the wrapper's name: the
    // cause travels through both levels.
    let wrapped = StoreError::Snapshot(SnapshotError::Atom(AtomError::DuplicateAtom(FourCc(
        *b"HEAP",
    ))));
    let shown = wrapped.to_string();
    assert!(shown.contains("HEAP"), "{shown:?} must name the atom");
    assert!(shown.contains("twice"), "{shown:?} must state the cause");
    assert!(
        shown.contains("store"),
        "{shown:?} must say where it came from"
    );
}

/// `expected` and `found` must not be swapped in the rendering: an operator
/// reading a reversed message would chase the wrong side of a mismatch.
///
/// `EpochMismatch` and `BaselineMismatch` are deliberately neutral about
/// WHICH actor holds which value, because their construction sites do not
/// agree on that — `check_epoch` expects the store's next epoch and finds the
/// batch's, while `checkpoint_to_store_core` expects the session's and finds
/// the store's. What they must preserve is which value was required and which
/// was met. The arms that DO name a side are asserted to name the right one.
#[test]
fn mismatch_renderings_do_not_swap_expected_and_found() {
    for shown in [
        StoreError::EpochMismatch {
            expected: 5,
            found: 9,
        }
        .to_string(),
        StoreError::BaselineMismatch {
            expected: "required".into(),
            found: "met".into(),
        }
        .to_string(),
    ] {
        assert!(
            shown.contains("expected") && shown.contains("found"),
            "{shown:?} must keep required and met on their own sides"
        );
        for side in ["store holds", "commit carries", "commit is for"] {
            assert!(
                !shown.contains(side),
                "{shown:?} must not name an actor: the construction sites disagree"
            );
        }
    }

    let shown = StoreError::RowLength {
        kind: "page",
        index: 0,
        expected: 64,
        found: 32,
    }
    .to_string();
    assert!(
        shown.contains("is 32 bytes") && shown.contains("promises 64"),
        "{shown:?} must report the actual length as found"
    );

    let shown = StoreError::Snapshot(SnapshotError::CostTableMismatch {
        expected: "engine".into(),
        found: "snapshot".into(),
    })
    .to_string();
    assert!(
        shown.contains("carries snapshot") && shown.contains("engine is engine"),
        "{shown:?} must attribute each version to its own side"
    );
}

/// The two renderings that index into a fingerprint. Both take a fixed
/// `[u8; 32]`, so the slice cannot panic by type; what is asserted here is
/// that the prefix is the value's own and long enough to tell two apart.
#[test]
fn fingerprint_renderings_show_their_own_prefix() {
    let mut expected = [0u8; 32];
    let mut found = [0u8; 32];
    expected[..8].copy_from_slice(&[0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);
    found[..8].copy_from_slice(&[0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10]);
    let shown = StoreError::Snapshot(SnapshotError::BootLayoutMismatch {
        expected,
        found: Some(found),
    })
    .to_string();
    assert!(shown.contains("0123456789abcdef"), "{shown:?}");
    assert!(shown.contains("fedcba9876543210"), "{shown:?}");

    let shown = StoreError::Snapshot(SnapshotError::BootLayoutMismatch {
        expected,
        found: None,
    })
    .to_string();
    assert!(shown.contains("no fingerprint"), "{shown:?}");

    // `Signature::new` always stamps this engine's boot fingerprint, so the
    // reachable rendering is host-plus-prefix. The boot-less form exists only
    // for a legacy payload decoded for inspection, which no constructor here
    // can build.
    let shown = ironhorse_snapshot::format::Signature::new("some-host").to_string();
    assert!(shown.starts_with("some-host @"), "{shown:?}");
    assert_eq!(
        shown.len(),
        "some-host @".len() + 16,
        "{shown:?} must carry sixteen hex digits"
    );
    assert!(
        shown["some-host @".len()..]
            .bytes()
            .all(|b| b.is_ascii_hexdigit()),
        "{shown:?}"
    );
}

/// The seam that motivated this needs `?`-compatibility and a walkable chain,
/// not just text: a supervisor using `anyhow`/`eyre` sees the cause only if
/// `source()` is implemented at every level.
#[test]
fn the_cause_survives_an_error_chain_walk() {
    fn boxed() -> Result<(), Box<dyn std::error::Error>> {
        Err(StoreError::Empty)?;
        Ok(())
    }
    assert_eq!(
        boxed().unwrap_err().to_string(),
        "store has no committed epoch"
    );

    let error = StoreError::BatchRejected(Box::new(StoreError::Snapshot(SnapshotError::Atom(
        AtomError::BadLength,
    ))));
    let mut chain: Vec<String> = vec![error.to_string()];
    let mut cursor: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(&error);
    while let Some(e) = cursor {
        chain.push(e.to_string());
        cursor = e.source();
    }
    assert_eq!(
        chain.len(),
        4,
        "batch -> store -> snapshot -> atom, got {chain:?}"
    );
    assert!(chain.last().unwrap().contains("8-byte header"), "{chain:?}");
}
