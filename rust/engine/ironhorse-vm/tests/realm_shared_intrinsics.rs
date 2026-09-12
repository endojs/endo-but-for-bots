//! F059: two realms over one machine share the primordial intrinsic graph and
//! keep distinct globals.
//!
//! [`ironhorse_vm::Realm`] is the per-compartment namespace over a shared
//! [`ironhorse_vm::Interp`]. Swapping realms into one machine must not copy the
//! intrinsic graph: `Object.prototype` is one object, so a mutation made in
//! one realm is visible in the next, while each realm's own globals stay its
//! own.

use ironhorse_vm::{parse_symbols, Interp, Realm};

fn run(interp: &mut Interp, realm: &mut Realm, source: &str) -> String {
    interp.swap_realm(realm);
    let (code, names) = ironhorse_compile::compile_atoms(source).expect("compiles");
    interp.link_intrinsics(&parse_symbols(&names));
    let outcome = interp.run(&code);
    interp.swap_realm(realm);
    assert!(outcome.completed, "{source}: {:?}", outcome.halt);
    outcome.result
}

#[test]
fn realms_share_intrinsics_but_not_globals() {
    let mut machine = Interp::new();
    let mut a = machine.new_realm();
    let mut b = machine.new_realm();

    // Realm A mutates the shared %Object.prototype% and creates its own global.
    assert_eq!(
        run(
            &mut machine,
            &mut a,
            "Object.prototype.__ihProbe = 42; var onlyInA = 'A'; 0"
        ),
        "0"
    );

    // Realm B sees the shared intrinsic mutation but not A's global.
    assert_eq!(
        run(
            &mut machine,
            &mut b,
            "typeof Object.prototype.__ihProbe + ',' + typeof onlyInA"
        ),
        "number,undefined"
    );

    // Realm A's own namespace survives its parked interval.
    assert_eq!(
        run(
            &mut machine,
            &mut a,
            "typeof onlyInA + ',' + Object.prototype.__ihProbe"
        ),
        "string,42"
    );

    // And the identity really is shared, not a copy: a mutation from B is the
    // value A reads next.
    assert_eq!(
        run(&mut machine, &mut b, "Object.prototype.__ihProbe = 7; 0"),
        "0"
    );
    assert_eq!(run(&mut machine, &mut a, "Object.prototype.__ihProbe"), "7");
}
