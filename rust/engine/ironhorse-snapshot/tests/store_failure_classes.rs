//! The store's failure taxonomy: every variant classifies, and the three
//! classes mean what the daemon seam acts on (review finding F157).
//!
//! `StoreError::failure` is an exhaustive match, so a new variant fails to
//! compile until it states its class. What a compiler cannot check is that the
//! classes stay *distinguishable* and that `Display` stays structured rather
//! than collapsing back to one opaque string, which is the defect F157 records.
use ironhorse_snapshot::atom::AtomError;
use ironhorse_snapshot::format::{FourCc, SignatureError, SnapshotError, VersionError};
use ironhorse_snapshot::store::{StoreError, StoreFailure};

/// One representative of each class, so a refactor that folded two classes
/// together would fail here rather than silently make a supervisor retry a
/// refusal forever.
#[test]
fn the_three_classes_stay_distinguishable() {
    assert_eq!(
        StoreError::Io("disk".into()).failure(),
        StoreFailure::Transient
    );
    assert_eq!(
        StoreError::MachineNotQuiescent.failure(),
        StoreFailure::Refused
    );
    assert_eq!(
        StoreError::SummaryMismatch { page: 7 }.failure(),
        StoreFailure::Poisoned
    );
}

/// The medium is the only thing worth retrying. Every other class of failure
/// answers the same way on the next call, so a retry loop over one is a
/// busy-loop; this is the whole reason the classifier exists.
#[test]
fn only_io_is_transient() {
    let not_io = [
        StoreError::MachineNotQuiescent,
        StoreError::MachineOperation("host root".into()),
        StoreError::PendingStateUnsupported { row: "modules" },
        StoreError::Empty,
        StoreError::MissingRow("page", 3),
        StoreError::RowLength {
            kind: "page",
            index: 3,
            expected: 64,
            found: 32,
        },
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
        StoreError::SummaryCount {
            expected: 8,
            found: 4,
        },
        StoreError::SummaryMismatch { page: 1 },
    ];
    for error in not_io {
        assert_ne!(
            error.failure(),
            StoreFailure::Transient,
            "{error:?} must not invite a retry"
        );
    }
}

/// A decode failure splits one level down: structural damage means the stored
/// bytes cannot be trusted, while a compatibility answer is a refusal about an
/// intact store. Collapsing the two would either tear down a session over a
/// cost-table bump or resume over a torn container.
#[test]
fn snapshot_decode_failures_split_by_cause() {
    let poisoned = [
        SnapshotError::Atom(AtomError::Truncated),
        SnapshotError::Signature(SignatureError::NotUtf8),
        SnapshotError::MissingAtom(FourCc(*b"HEAP")),
        SnapshotError::Corrupt("slot record"),
    ];
    for e in poisoned {
        assert_eq!(
            StoreError::Snapshot(e).failure(),
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
        SnapshotError::CostTableMismatch {
            expected: "ironhorse-meter-5".into(),
            found: "ironhorse-meter-4".into(),
        },
    ];
    for e in refused {
        assert_eq!(
            StoreError::Snapshot(e).failure(),
            StoreFailure::Refused,
            "an intact store answering `no` must not read as corruption"
        );
    }
}

/// `Display` has to carry the variant's own information. The seam this
/// replaces rendered every failure through `format!("{e:?}")`, so the test
/// that matters is that the rendering is not the Debug rendering and that the
/// distinguishing field survives it.
#[test]
fn display_is_structured_rather_than_debug() {
    let error = StoreError::RowLength {
        kind: "page",
        index: 12,
        expected: 64,
        found: 32,
    };
    let shown = error.to_string();
    assert_ne!(shown, format!("{error:?}"));
    for part in ["page", "12", "64", "32"] {
        assert!(shown.contains(part), "{shown:?} must name {part}");
    }

    // A wrapped decode failure must not flatten to the wrapper's name: the
    // cause travels through both levels.
    let wrapped = StoreError::Snapshot(SnapshotError::Atom(AtomError::DuplicateAtom(FourCc(
        *b"HEAP",
    ))));
    let shown = wrapped.to_string();
    assert!(shown.contains("HEAP"), "{shown:?} must name the atom");
    assert!(shown.contains("twice"), "{shown:?} must state the cause");
}

/// `expected` and `found` must not be swapped in the rendering: an operator
/// reading a reversed message would chase the wrong side of a mismatch. The
/// `BaselineMismatch` arm is deliberately neutral about WHICH actor holds
/// which value, because its nine construction sites do not agree on that;
/// what it must preserve is which value was required and which was met.
#[test]
fn mismatch_renderings_do_not_swap_expected_and_found() {
    let shown = StoreError::EpochMismatch {
        expected: 5,
        found: 9,
    }
    .to_string();
    assert!(
        shown.contains("epoch 9") && shown.contains("expects 5"),
        "{shown:?} must say the commit is for 9 and the store expects 5"
    );

    let shown = StoreError::BaselineMismatch {
        expected: "required".into(),
        found: "met".into(),
    }
    .to_string();
    assert!(
        shown.contains("expected required") && shown.contains("found met"),
        "{shown:?} must keep required and met on their own sides"
    );
    for side in ["store holds", "commit carries"] {
        assert!(
            !shown.contains(side),
            "{shown:?} must not name an actor: the construction sites disagree on which is which"
        );
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

/// The seam that motivated this needs `?`-compatibility, not just text.
#[test]
fn store_error_is_a_std_error() {
    fn boxed() -> Result<(), Box<dyn std::error::Error>> {
        Err(StoreError::Empty)?;
        Ok(())
    }
    let message = boxed().unwrap_err().to_string();
    assert_eq!(message, "store has no committed epoch");
}
