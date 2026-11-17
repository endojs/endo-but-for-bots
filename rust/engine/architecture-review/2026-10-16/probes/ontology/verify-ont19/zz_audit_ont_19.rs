//! Verify ONT-19: can a host that keeps per-environment restore policy keyed by
//! EnvironmentId (as MachineRestorePolicy requires) end up applying one
//! compartment's policy to a different compartment that reused its slot,
//! without any refusal?
use ironhorse_snapshot::{
    machine::{from_snapshot_bytes, MachineSnapshot},
    Signature,
};
use ironhorse_vm::{
    Compartment, CompartmentOptions, EnvironmentId, EnvironmentPolicy, Machine,
    MachineRestorePolicy,
};
use std::collections::BTreeMap;

fn eval(c: &Compartment, source: &str) -> String {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let outcome = c.evaluate_with_symbols(&code, &symbols);
    assert!(outcome.completed, "{source}: {:?}", outcome.halt);
    outcome.result
}
fn ids(m: &Machine) -> Vec<u32> {
    m.with_persistence(|i| i.shared_environment_ids()).unwrap()
}
fn policy(name: Option<&str>) -> EnvironmentPolicy {
    EnvironmentPolicy {
        global_names: None,
        source_compiler: None,
        name: name.map(str::to_owned),
        has_resolve_hook: false,
        has_import_hook: false,
    }
}

fn attempt(pad: usize, verbose: bool) -> bool {
    let m = Machine::new();
    let sid = m.start_compartment().snapshot_id().unwrap();
    // Host-made compartment "A"; the guest (start) retains one of its closures.
    let a = m.compartment(CompartmentOptions {
        name: Some("A".into()),
        ..Default::default()
    });
    eval(&a, "var who = 'A'; function f() { return who; } 0");
    let aid = a.snapshot_id().unwrap();
    // Padding allocated ABOVE A's slots: the freelist hands out the highest
    // freed slot first, so this shifts where later globals land.
    eval(
        &m.start_compartment(),
        &format!("var pad = []; for (var i = 0; i < {pad}; i++) pad.push({{}}); 0"),
    );
    {
        // Scoped: define_global_value keeps the RootedValue in the handle.
        let mut start0 = m.start_compartment();
        start0
            .define_global_value("fa", &a.global_value("f").unwrap())
            .unwrap();
        assert_eq!(eval(&start0, "fa()"), "A");
    }
    drop(a);
    m.collect().unwrap();
    let start = m.start_compartment();
    let ids1 = ids(&m);
    // Host bookkeeping keyed by EnvironmentId: A is still live (guest-retained),
    // so the host must keep A's policy for the next restore.
    let mut host_map: BTreeMap<EnvironmentId, &str> = BTreeMap::new();
    host_map.insert(aid, "A");
    // Guest drops its last reference to A (and the padding). Host is not told.
    eval(&start, "delete globalThis.fa; pad = undefined; 0");
    m.collect().unwrap();
    m.collect().unwrap();
    let ids2 = ids(&m);
    // Guest makes its own compartments, keeps each one's global object and
    // per-compartment eval, and drops the Compartment instances (a snapshot
    // refuses only a LIVE guest Compartment instance).
    eval(
        &start,
        "var cg = [], h = []; for (var i = 0; i < 8; i++) { var c = new Compartment(); c.globalThis.who = 'guest-C' + i; cg.push(c.globalThis); h.push(c.globalThis.eval); } c = undefined; 0",
    );
    m.collect().unwrap();
    m.collect().unwrap();
    let ids3 = ids(&m);
    let hit = ids3.contains(&aid.0);
    if !hit && !verbose {
        return false;
    }
    println!("pad={pad} sid={sid:?} aid={aid:?}");
    println!("  host dropped A handle, guest retains fa: ids={ids1:?}");
    println!("  guest dropped fa: ids={ids2:?}");
    println!("  after 8 guest compartments: {} envs, contains aid: {hit}", ids3.len());
    let signature = Signature::new("zz-audit-ont-19");
    let bytes = match m.write_snapshot(&signature) {
        Ok(b) => b,
        Err(e) => {
            println!("  snapshot refused: {e:?}");
            return hit;
        }
    };
    let interp = from_snapshot_bytes(&bytes, &signature).unwrap();
    let restore_ids = interp.shared_environment_ids();
    // Host policy: its own record where it has one, default otherwise.
    let environments: BTreeMap<_, _> = restore_ids
        .iter()
        .map(|&id| {
            let id = EnvironmentId(id);
            (id, policy(host_map.get(&id).copied()))
        })
        .collect();
    let restored = match Machine::from_restored_interpreter(
        interp,
        MachineRestorePolicy {
            host_callables: Default::default(),
            environments,
            meter_host: None,
        },
    ) {
        Ok(r) => r,
        Err(h) => {
            println!("  restore refused: {h:?}");
            return hit;
        }
    };
    println!("  restore accepted the host's id-keyed policy");
    match restored.claim_compartment(aid) {
        Err(h) => println!("  claim_compartment({aid:?}) -> {h:?}"),
        Ok(ra) => {
            let rs = restored.claim_compartment(sid).unwrap();
            println!(
                "  host claimed {aid:?} believing it is A: name={:?} who={} typeof f={}",
                ra.name(),
                eval(&ra, "who"),
                eval(&ra, "typeof f")
            );
            eval(&ra, "globalThis.marker = 'written-via-host-handle-A'; 0");
            println!(
                "  guest reads marker through its own references: {}",
                eval(&rs, "JSON.stringify(cg.map((g, i) => [i, g.marker]).filter(p => p[1] !== undefined))")
            );
        }
    }
    hit
}

#[test]
fn zz_audit_ont_19() {
    attempt(0, true);
    for pad in 1..400 {
        if attempt(pad, false) {
            return;
        }
    }
    println!("no pad in 1..400 produced reuse");
}
