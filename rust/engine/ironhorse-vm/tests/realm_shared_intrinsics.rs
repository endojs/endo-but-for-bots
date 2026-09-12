//! F059: two realms over one machine share the primordial intrinsic graph and
//! keep distinct globals.
//!
//! [`ironhorse_vm::Realm`] is the per-compartment namespace over a shared
//! [`ironhorse_vm::Interp`]. Swapping realms into one machine must not copy the
//! intrinsic graph: `Object.prototype` is one object, so a mutation made in
//! one realm is visible in the next, while each realm's own globals stay its
//! own. A realm's namespace is rooted from allocation and survives that
//! parking (and a collection) until [`Interp::release_realm`].

use ironhorse_vm::{parse_symbols, Interp, Realm};

fn run(interp: &mut Interp, realm: &mut Realm, source: &str) -> String {
    interp.swap_realm(realm);
    let (code, names) = ironhorse_compile::compile_atoms(source).expect("compiles");
    let code = interp
        .relink_crank(&code, &parse_symbols(&names))
        .expect("relinks onto the realm table");
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

#[test]
fn rooted_realms_are_bounded_and_releasable() {
    let mut machine = Interp::new();
    assert_eq!(machine.rooted_realm_count(), 0, "no realm yet");
    let mut realms: Vec<Realm> = (0..8).map(|_| machine.new_realm()).collect();
    // A realm's global object is rooted from allocation, so a collection in
    // the interval before it is installed cannot reclaim its namespace.
    assert_eq!(machine.rooted_realm_count(), 8);

    // Installing each realm parks the previous one; the set still tracks
    // exactly the minted realms (the parked default global included).
    for realm in realms.iter_mut() {
        machine.swap_realm(realm);
    }
    assert_eq!(machine.rooted_realm_count(), 8);

    // Releasing every realm drops every realm root; the active realm is
    // rooted through `global_obj`, and the default global parked inside the
    // first realm goes with it.
    for realm in realms.iter() {
        machine.release_realm(realm);
    }
    assert_eq!(
        machine.rooted_realm_count(),
        0,
        "released realms leave no realm roots"
    );
    for _ in 0..3 {
        let realm = machine.new_realm();
        machine.release_realm(&realm);
    }
    assert_eq!(
        machine.rooted_realm_count(),
        0,
        "released realms do not accumulate"
    );
}

#[test]
fn parked_realm_state_survives_a_collection() {
    let mut machine = Interp::new();
    let mut a = machine.new_realm();
    let mut b = machine.new_realm();

    // Realm A installs a global and a function that closes over it.
    assert_eq!(
        run(
            &mut machine,
            &mut a,
            "var keep = 41; function f(){ return keep; } 0"
        ),
        "0"
    );

    // Realm B runs its own program, parking A.
    assert_eq!(run(&mut machine, &mut b, "var other = 'b'; other"), "b");

    // A collection while A is parked must not reclaim A's namespace.
    machine.collect_garbage().expect("collection admitted");

    assert_eq!(
        run(&mut machine, &mut a, "typeof keep + ',' + keep + ',' + f()"),
        "number,41,41"
    );
}

#[test]
fn a_realm_minted_before_a_collection_survives_it() {
    // Regression lock: the interval between minting a realm and installing it
    // is open to a collection; the global object is rooted from allocation,
    // so the later install must not touch a reclaimed slot.
    let mut machine = Interp::new();
    let mut realm = machine.new_realm();
    machine.collect_garbage().expect("collection admitted");
    assert_eq!(run(&mut machine, &mut realm, "1 + 1"), "2");
}
