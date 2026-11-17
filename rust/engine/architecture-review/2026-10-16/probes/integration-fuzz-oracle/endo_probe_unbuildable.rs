// AUDIT PROBE (temporary, integration-fuzz-oracle region). Deleted after use;
// a copy lives under the reviewer's probes directory.
//
// A. Does a guest-reachable Rust panic (`var a = 1 << 31; --a`, an i32
//    decrement overflow in the dispatch loop) escape the ephemeral
//    `Machine::eval`, and is the Machine usable afterwards?
// B. Does one ephemeral evaluation's property-key interning affect a later,
//    independent evaluation on the same `Machine` ("fresh Realm" per eval)?
// C. Does the same panic escape `PersistentMachine::eval`, and if a caller
//    catches it and keeps the machine, do the panicked crank's partial
//    effects survive into the next crank and into the store?
#![cfg(feature = "ironhorse-engine")]

use endo::ironhorse_engine::engine::{
    CadencePolicy, HeapStoreOptions, Machine, MeterBounds, PersistentMachine,
};
use std::panic::{catch_unwind, AssertUnwindSafe};

fn show<T: std::fmt::Debug, E: std::fmt::Display>(r: Result<T, E>) -> String {
    match r {
        Ok(v) => format!("Ok({v:?})"),
        Err(e) => format!("Err({e})"),
    }
}

fn body() {
    std::panic::set_hook(Box::new(|info| {
        eprintln!("  [panic hook] {info}");
    }));
    const PANIC: &str = "var a = 1 << 31; --a; String(a)";

    println!("== A: ephemeral Machine");
    let m = Machine::with_bounds(MeterBounds::default());
    println!("A0 eval(1+1)            -> {}", show(m.eval("1+1")));
    let r = catch_unwind(AssertUnwindSafe(|| m.eval(PANIC)));
    println!("A1 eval(PANIC) unwound  -> {}", r.is_err());
    let r = catch_unwind(AssertUnwindSafe(|| show(m.eval("1+1"))));
    println!("A2 eval(1+1) afterwards -> {r:?}");

    println!("== B: cross-evaluation key interference on one ephemeral Machine");
    let m = Machine::with_bounds(MeterBounds::Unbounded);
    println!(
        "B0 fresh Machine, eval(o.fresh = 1)            -> {}",
        show(m.eval("var o = {}; o.freshName = 1; 'ok'"))
    );
    println!(
        "B1 eval(intern 70000 names)                    -> {}",
        show(m.eval(
            "var o = {}; try { for (var i = 0; i < 70000; i++) o['n' + i] = i; 'ok' } \
             catch (e) { e.name + ': ' + e.message + ' at i=' + i }"
        ))
    );
    println!(
        "B2 next independent eval(o.anotherName = 1)    -> {}",
        show(m.eval(
            "try { var o = {}; o.anotherFreshName = 1; 'ok' } catch (e) { e.name + ': ' + e.message }"
        ))
    );
    println!(
        "B3 next independent eval(JSON.parse 1 new key) -> {}",
        show(m.eval(
            "try { JSON.parse('{\"zzzUnseen\":1}').zzzUnseen } catch (e) { e.name + ': ' + e.message }"
        ))
    );
    let fresh = Machine::with_bounds(MeterBounds::Unbounded);
    println!(
        "B4 a FRESH Machine, same source as B2          -> {}",
        show(fresh.eval(
            "try { var o = {}; o.anotherFreshName = 1; 'ok' } catch (e) { e.name + ': ' + e.message }"
        ))
    );

    println!("== C: PersistentMachine");
    let dir = tempfile::tempdir().expect("temp dir");
    let options = HeapStoreOptions {
        path: dir.path().join("heap.sqlite"),
        signature: "audit-int-probe".to_string(),
        cadence: CadencePolicy::default(),
        meter: MeterBounds::default(),
        global_names: None,
    };
    let mut pm = PersistentMachine::open(&options).expect("open");
    println!(
        "C0 crank(globalThis.x = 1)                -> {}  epoch={:?}",
        show(pm.eval("globalThis.x = 1; 'x=1'").map(|o| o.result)),
        pm.epoch().ok()
    );
    let r = catch_unwind(AssertUnwindSafe(|| {
        show(
            pm.eval("globalThis.x = 2; var a = 1 << 31; --a; 'unreached'")
                .map(|o| o.result),
        )
    }));
    println!(
        "C1 crank(x = 2; PANIC) unwound out of eval -> {}  epoch={:?}",
        r.is_err(),
        pm.epoch().ok()
    );
    let r = catch_unwind(AssertUnwindSafe(|| {
        show(pm.eval("String(globalThis.x)").map(|o| o.result))
    }));
    println!(
        "C2 next crank(String(x)) on same machine  -> {r:?}  epoch={:?}",
        pm.epoch().ok()
    );
    let r = catch_unwind(AssertUnwindSafe(|| pm.close()));
    println!(
        "C3 close                                  -> {:?}",
        r.map(|x| x.map_err(|e| e.to_string()))
    );
    let mut pm2 = PersistentMachine::open(&options).expect("reopen");
    println!(
        "C4 reopened store: crank(String(x))       -> {}  epoch={:?}",
        show(pm2.eval("String(globalThis.x)").map(|o| o.result)),
        pm2.epoch().ok()
    );
    let _ = pm2.close();
}

#[test]
fn probe() {
    std::thread::Builder::new()
        .stack_size(64 << 20)
        .spawn(body)
        .unwrap()
        .join()
        .unwrap();
}
