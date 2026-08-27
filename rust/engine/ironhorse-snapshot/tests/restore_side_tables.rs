//! Restore-time side-table rebuild regressions (supervisor stage-6 review,
//! PR #600). The side-table completeness ledger
//! (`ironhorse_snapshot::sidetable`) once claimed `GlobalProps` and
//! `SymbolTables` were covered by the arena / serialized atoms, but
//! `Interp::restore_snapshot_state` reinstates arenas + stack + `symbol_names`
//! + meter only — the `global_props` id→slot index and the `symbol_ids`
//! inverse map + the then-extant `next_intern_id` counter (all derived,
//! HashMap-resident, not arena state) stayed at their empty fresh-boot
//! values. A runtime global materialized in an earlier crank then vanished
//! after suspend/resume. (The counter has since retired: the 2026-08-26
//! id-space unification made runtime string keys `symbol_names` appends and
//! moved symbol-key minting to the SYMB-carried `next_symbol_key_id`.)
//!
//! These tests lock the fix in the shape the review used: a real guest crank
//! materializes a runtime global, the machine is suspended via
//! `write_snapshot` and resumed via `from_snapshot_bytes` (the machine truly
//! reconstructed from bytes), and a second crank on the restored machine must
//! behave **identically to a machine that never suspended** — in both the
//! completion value and the final computron count.
//!
//! The programs are compiled from source through the pure-Rust
//! `ironhorse-compile` pipeline (no oracle needed), which emits both the bytecode
//! and the `SYMB` atom, exactly as `dual_run` links a program.

use ironhorse_snapshot::format::Signature;
use ironhorse_snapshot::machine::{from_snapshot_bytes, MachineSnapshot};
use ironhorse_vm::{parse_symbols, Interp};

/// Compile guest `source` to `(bytecode, program symbol names)` — the two
/// halves `Interp::link_intrinsics` + `Interp::run` consume. Panics if the
/// pure-Rust compiler cannot lower the source (the fixtures below are chosen
/// to compile cleanly).
fn compile(source: &str) -> (Vec<u8>, Vec<String>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
    (bytecode, parse_symbols(&symbols))
}

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

/// **Finding 1 — `GlobalProps`.** Crank 1 materializes a runtime global
/// (`var x = 5`), the machine is snapshotted and rebuilt from bytes, and
/// crank 2 (`x + 1`) reads that global. Before the fix the restored machine's
/// `global_props` map was empty, so `x` resolved as an undeclared reference
/// and crank 2 diverged from the uninterrupted run. After the fix
/// `restore_snapshot_state` rebuilds `global_props` from the restored global
/// object's property chain, so the resumed crank matches the uninterrupted
/// machine in both result and computrons.
#[test]
fn runtime_global_survives_suspend_resume() {
    let (crank1, names1) = compile("var x = 5;");
    let (crank2, _names2) = compile("x + 1");

    // Baseline: one machine runs both cranks without ever suspending.
    let mut uninterrupted = Interp::new();
    uninterrupted.link_intrinsics(&names1);
    uninterrupted.run(&crank1);
    let baseline = uninterrupted.run(&crank2);
    assert!(baseline.completed, "baseline crank 2 completes");
    assert_eq!(baseline.result, "6", "baseline reads the global: 5 + 1");

    // Suspend after crank 1, drop the machine, rebuild it from the bytes, and
    // run crank 2 on the reconstructed machine.
    let mut m1 = Interp::new();
    m1.link_intrinsics(&names1);
    m1.run(&crank1);
    let bytes = m1.write_snapshot(&sig()).expect("quiescent machine snapshots");
    drop(m1);

    let mut m2 = from_snapshot_bytes(&bytes, &sig()).expect("machine restores from bytes");
    let resumed = m2.run(&crank2);

    assert!(resumed.completed, "resumed crank 2 completes (global resolved)");
    assert_eq!(
        resumed.result, baseline.result,
        "resumed run reads the runtime global identically to the uninterrupted run",
    );
    assert_eq!(
        resumed.computrons, baseline.computrons,
        "resumed run's computrons match the uninterrupted run (no divergent path)",
    );
}

/// **Finding 3 — `SymbolTables`.** Only `symbol_names` is serialized; the
/// inverse `symbol_ids` map (which `global_string` — and every native
/// built-in that relinks a well-known property name — consults) is derived
/// from it and was never rebuilt at restore, so it stayed at its fresh-boot
/// value (empty; so did the runtime-key counter of the day, since retired
/// by the id-space unification). After the fix `restore_snapshot_state`
/// re-derives it via `bind_program_symbols`, so a global materialized before
/// the snapshot reads back **by name** on the restored machine.
#[test]
fn symbol_tables_rebuilt_at_restore() {
    let (crank1, names1) = compile("var x = 5;");

    let mut m1 = Interp::new();
    m1.link_intrinsics(&names1);
    m1.run(&crank1);
    // Sanity: the live machine reads the global by name (uses `symbol_ids`).
    assert_eq!(m1.global_string("x").as_deref(), Some("5"));

    let bytes = m1.write_snapshot(&sig()).expect("quiescent machine snapshots");
    drop(m1);
    let m2 = from_snapshot_bytes(&bytes, &sig()).expect("machine restores from bytes");

    // `symbol_names` round-trips — the MACHINE's table, which since the
    // id-space unification includes any name the boot link appended
    // (constructor `prototype`, iterator-protocol atoms) beyond the
    // compiled `names1`. The compiled prefix must survive verbatim.
    assert_eq!(
        &m2.program_symbol_names()[..names1.len()],
        names1.as_slice(),
        "the compiled name-table prefix round-trips through the snapshot",
    );
    // … and the *derived* inverse `symbol_ids` is rebuilt, so name-keyed
    // resolution works after resume. Before the fix this was `None` (empty
    // `symbol_ids`), the concrete corruption the review flagged.
    assert_eq!(
        m2.global_string("x").as_deref(),
        Some("5"),
        "the inverse symbol_ids map is rebuilt at restore: the global reads back by name",
    );
}
