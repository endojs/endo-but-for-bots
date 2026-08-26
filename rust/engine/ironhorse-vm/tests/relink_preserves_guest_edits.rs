//! A table-growing relink must not revert guest edits to intrinsics.
//!
//! `install_intrinsic_bindings`' name-keyed branches are gated by the
//! relink's append-only `keep` filter, but its well-known-SYMBOL
//! branches (`@@toStringTag` tags, `@@iterator`/`@@asyncIterator`
//! identities, the dispose aliases) depend on no program name and the
//! filter cannot gate them — symbol-key ids mint top-down from
//! `u16::MAX`, so every one reads as "appended". Before the fix they
//! re-ran on every relink: a crank-1 monkeypatch of
//! `String.prototype[Symbol.iterator]` was silently reverted, a
//! crank-1 `delete DataView.prototype[Symbol.toStringTag]` came back,
//! and the Segments branch minted fresh iterator functions per relink
//! (review of the llm-rebase merge). They now run on the FULL link
//! only.

use ironhorse_vm::Interp;

fn compile(src: &str) -> (Vec<u8>, Vec<String>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}

#[test]
fn a_growing_relink_preserves_a_symbol_keyed_monkeypatch() {
    // The patch function's IDENTITY is the witness (a cross-crank CALL
    // is separately impossible — the pinned self-contained-crank
    // contract — so the read-back compares references, which is also
    // exactly what a reinstall would break).
    let crank1 = "var p = 0; var probe = 0; \
                  p = function () { return 'patched'; }; \
                  String.prototype[Symbol.iterator] = p; \
                  probe = String.prototype[Symbol.iterator] === p; probe";
    let (b1, n1) = compile(crank1);
    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    let o = m.run(&b1);
    assert!(o.completed, "patch crank: {:?}", o.halt);
    assert_eq!(o.result, "true");

    // A crank that GROWS the table (fresh names) relinks; the patch
    // must survive the appended-ids install pass.
    let crank2 = "var p; var probe; var freshName = 0; freshName = 1; \
                  probe = String.prototype[Symbol.iterator] === p; probe";
    let (b2, n2) = compile(crank2);
    let relinked = m.relink_crank(&b2, &n2).expect("relink");
    let o2 = m.run(&relinked);
    assert!(o2.completed, "read-back crank: {:?}", o2.halt);
    assert_eq!(
        o2.result, "true",
        "the relink reinstalled the intrinsic over the guest's patch"
    );
}

#[test]
fn a_growing_relink_preserves_a_symbol_keyed_deletion() {
    let crank1 = "var probe = 0; \
                  delete DataView.prototype[Symbol.toStringTag]; \
                  probe = DataView.prototype[Symbol.toStringTag] === undefined; probe";
    let (b1, n1) = compile(crank1);
    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    let o = m.run(&b1);
    assert!(o.completed, "delete crank: {:?}", o.halt);
    assert_eq!(o.result, "true");

    let crank2 = "var probe; var anotherFresh = 0; anotherFresh = 2; \
                  probe = DataView.prototype[Symbol.toStringTag] === undefined; probe";
    let (b2, n2) = compile(crank2);
    let relinked = m.relink_crank(&b2, &n2).expect("relink");
    let o2 = m.run(&relinked);
    assert!(o2.completed, "read-back crank: {:?}", o2.halt);
    assert_eq!(
        o2.result, "true",
        "the relink resurrected a property the guest deleted"
    );
}
