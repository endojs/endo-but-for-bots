//! A name interned ABOVE the installed-names floor must become
//! reachable at the NEXT relink — growing or not.
//!
//! The floor (wave-6 W6-7) makes partial install passes re-consider
//! exactly the ids no full link has installed: names interned DURING
//! an install pass (the `format` accessor key, the Intl member keys)
//! and names the guest interned itself (`o['Ma' + 'th']`). But the
//! pass only RAN when a relink happened to grow the table, so a crank
//! that referenced such a name without introducing any novel name read
//! `undefined` where the next (growing) crank read the binding — the
//! Intl carry's twins caught this only by accident, through an array
//! literal interning `length`. The pass now runs on every relink while
//! any above-floor id exists, and the floor advance makes it free once
//! the backlog is installed.

use ironhorse_vm::Interp;

fn compile(src: &str) -> (Vec<u8>, Vec<String>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}

fn boot(src: &str) -> Interp {
    let (b, n) = compile(src);
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    let o = m.run(&b);
    assert!(o.completed, "crank 1: {:?}", o.halt);
    m
}

fn crank(m: &mut Interp, src: &str) -> (bool, String, String) {
    let (b, n) = compile(src);
    let b = m.relink_crank(&b, &n).expect("relink");
    let o = m.run(&b);
    (o.completed, format!("{:?}", o.halt), o.result)
}

/// The boot-interned case: crank 1 never names `format`, but linking
/// `Intl` interns it (the NumberFormat accessor install). A NON-GROWING
/// crank 2 — every name already in the table — must still reach
/// `ListFormat.prototype.format`.
#[test]
fn a_non_growing_crank_reaches_a_boot_interned_method() {
    let mut m = boot(
        "var lf = 0; var t = 0; \
         lf = new Intl.ListFormat('en', { type: 'conjunction' }); t = 7; t",
    );
    let (completed, halt, result) = crank(&mut m, "var lf; var t; t = typeof lf.format; t");
    assert!(completed, "{halt}");
    assert_eq!(result, "function", "the interned method installs at the relink");
    // And the method WORKS, not merely exists. (The array literal
    // interns `length`, so this crank happens to grow the table — the
    // accidental path the pre-fix twins survived on; the typeof crank
    // above is the non-growing lock.)
    let (completed, halt, result) =
        crank(&mut m, "var lf; var t; t = lf.format(['a', 'b']); t");
    assert!(completed, "{halt}");
    assert_eq!(result, "a and b");
}

/// The guest-interned case (wave-6 W6-7's original specimen class): the
/// guest interns `Math` as a novel OWN key (`JSON.parse` — the computed
/// `o['Ma'+'th']` form deliberately self-names for boot default keys,
/// which is the engine's separate ambiguity refusal), with no install
/// having seen the name. A later NON-GROWING crank referencing `Math`
/// textually must get the global bound.
#[test]
fn a_non_growing_crank_reaches_a_guest_interned_intrinsic_name() {
    let mut m = boot(
        "var o = 0; var t = 0; o = JSON.parse('{\"Math\":1}'); t = 7; t",
    );
    let (completed, halt, result) = crank(&mut m, "var o; var t; t = typeof Math; t");
    assert!(completed, "{halt}");
    assert_eq!(result, "object", "the guest-interned intrinsic name binds at the relink");
    // And the bound namespace WORKS (this crank grows the table with
    // `abs` — the already-locked W6-7 growing path — so the two paths
    // compose).
    let (completed, halt, result) = crank(&mut m, "var o; var t; t = Math.abs(-4); t");
    assert!(completed, "{halt}");
    assert_eq!(result, "4");
}

/// The pass is ONE-SHOT per id: once the backlog installs, the floor
/// advances past it, so a guest overwrite of the freshly-installed
/// binding survives every later relink — growing or not — instead of
/// being resurrected by a re-install.
#[test]
fn later_relinks_do_not_resurrect_an_installed_binding_over_a_guest_write() {
    let mut m = boot(
        "var o = 0; var t = 0; o = JSON.parse('{\"Math\":1}'); t = 7; t",
    );
    let (completed, halt, result) = crank(&mut m, "var o; var t; t = typeof Math; t");
    assert!(completed, "{halt}");
    assert_eq!(result, "object");
    let (completed, halt, result) = crank(&mut m, "var o; var t; Math = 5; t = Math === 5; t");
    assert!(completed, "{halt}");
    assert_eq!(result, "true", "the guest may overwrite the installed binding");
    // A growing relink AND a non-growing one both leave the guest's
    // value in place.
    let (completed, halt, result) =
        crank(&mut m, "var o; var t; var q = 0; q = 1; t = Math === 5; t");
    assert!(completed, "{halt}");
    assert_eq!(result, "true");
    let (completed, halt, result) = crank(&mut m, "var o; var t; t = Math === 5; t");
    assert!(completed, "{halt}");
    assert_eq!(result, "true");
}
