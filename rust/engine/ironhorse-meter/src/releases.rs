//! Append-only release digest ledger. Never replace an existing release pin.
//! Change weights or charging points by appending a release and updating the
//! literal version pin and golden corpus in the same commit.
pub const PINNED: &[(&str, &str)] = &[
    (
        "ironhorse-meter-1",
        "1ec1bc1202e33d831db9a3218eb53fa0d7b1b2e321a68cba6419216d8a722819",
    ),
    (
        "ironhorse-meter-2",
        "21d596bd7d6c8545c3e3c21336ce26bef17ab0d85b7e2596c00dbfee2ca177f0",
    ),
    (
        "ironhorse-meter-3",
        "039b227725239e1da7f6c1c6be93b036a2c6582b2aab545e01bfd9d31c762490",
    ),
    // W2 changes admission/charging points, retaining the shared weights.
    (
        "ironhorse-meter-4",
        "039b227725239e1da7f6c1c6be93b036a2c6582b2aab545e01bfd9d31c762490",
    ),
    // Same weights, new compiler work reservation and refusal policy.
    (
        "ironhorse-meter-5",
        "039b227725239e1da7f6c1c6be93b036a2c6582b2aab545e01bfd9d31c762490",
    ),
    // A nullish for-in's own creation weight. The for-in enumerator follows
    // XS's per-level walk, which moves its per-key charges on a TypedArray
    // or String wrapper receiver, and intrinsic surface reached by a
    // program's walk moves what it charges.
    (
        "ironhorse-meter-6",
        "4d9abebe68c732f045097da41de323467d6403019a672eb1249521cd476601a5",
    ),
];
