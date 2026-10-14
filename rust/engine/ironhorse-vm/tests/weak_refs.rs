//! `WeakRef` and `FinalizationRegistry` (`Native::WeakRef`,
//! `Native::FinalizationRegistry`; `fx_WeakRef` and
//! `fx_FinalizationRegistry` in `c/moddable/xs/sources/xsMapSet.c`).
//!
//! The guest-visible surface follows the pinned XS: the constructor-only
//! brand checks and their messages, object-only targets and tokens, the
//! `name`/`length`/`@@toStringTag` descriptors. The collector half follows
//! `fxMarkWeakStuff`/`fxMarkFinalizationRegistry`: a full collection at a
//! crank boundary clears a dead `WeakRef` target and queues a registry's
//! dead cells, whose callback runs at the next job boundary
//! (`fxEndJob` → `fxCleanupFinalizationRegistries`).
mod common;
use common::TestCompiler;

use ironhorse_vm::{parse_symbols, Interp, RunOutcome};

/// A machine plus whether a program has been linked on it yet.
struct Machine {
    interp: Interp,
    linked: bool,
}

impl std::ops::Deref for Machine {
    type Target = Interp;
    fn deref(&self) -> &Interp {
        &self.interp
    }
}

impl std::ops::DerefMut for Machine {
    fn deref_mut(&mut self) -> &mut Interp {
        &mut self.interp
    }
}

/// A fresh machine that has linked no program yet.
fn machine() -> Machine {
    let mut interp = Interp::new();
    interp.set_source_compiler(std::rc::Rc::new(TestCompiler));
    Machine {
        interp,
        linked: false,
    }
}

/// Compile and run `source` as one crank on `machine`: the first crank
/// links the program's symbols, every later one relinks onto the table the
/// machine already holds (as `state_golden.rs`'s `crank` does), so a
/// global declared by an earlier crank stays bound.
fn crank(machine: &mut Machine, source: &str) -> RunOutcome {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let names = parse_symbols(&symbols);
    if machine.linked {
        let code = machine.interp.relink_crank(&code, &names).unwrap();
        machine.interp.run(&code)
    } else {
        machine.linked = true;
        machine.interp.link_intrinsics(&names);
        machine.interp.run(&code)
    }
}

/// Run `source` on a fresh machine and return its completion.
fn result(source: &str) -> String {
    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn({
            let source = source.to_string();
            move || {
                let mut machine = machine();
                let outcome = crank(&mut machine, &source);
                assert!(outcome.completed, "{source}: {:?}", outcome.halt);
                outcome.result
            }
        })
        .unwrap()
        .join()
        .unwrap()
}

/// Run `source` on a fresh machine and return the uncaught throw it
/// renders, as `Name: message`.
fn thrown(source: &str) -> String {
    let mut machine = machine();
    let outcome = crank(&mut machine, source);
    assert!(!outcome.completed, "{source} completed: {}", outcome.result);
    match outcome.halt {
        ironhorse_vm::Halt::Throw { rendered, .. } => rendered,
        other => panic!("{source}: {other:?}"),
    }
}

const CATCH: &str = r#"
function attempt(f) {
  try { var v = f(); return 'returned ' + String(v); }
  catch (e) { return e.name + ': ' + e.message; }
}
"#;

// ---------------------------------------------------------------------
// The constructors
// ---------------------------------------------------------------------

#[test]
fn the_constructors_are_guest_globals() {
    assert_eq!(
        result("typeof WeakRef + ' ' + typeof FinalizationRegistry"),
        "function function"
    );
    assert_eq!(result("[WeakRef.length, WeakRef.name].join()"), "1,WeakRef");
    assert_eq!(
        result("[FinalizationRegistry.length, FinalizationRegistry.name].join()"),
        "1,FinalizationRegistry"
    );
    assert_eq!(
        result(
            r#"
            var d = Object.getOwnPropertyDescriptor(this, 'WeakRef');
            var e = Object.getOwnPropertyDescriptor(this, 'FinalizationRegistry');
            [d.writable, d.enumerable, d.configurable,
             e.writable, e.enumerable, e.configurable].join()
            "#
        ),
        "true,false,true,true,false,true"
    );
}

#[test]
fn the_constructors_require_new() {
    assert_eq!(thrown("WeakRef({})"), "TypeError: call: WeakRef");
    assert_eq!(
        thrown("FinalizationRegistry(function () {})"),
        "TypeError: call: FinalizationRegistry"
    );
}

#[test]
fn a_weak_ref_target_must_be_an_object() {
    assert_eq!(
        result(&format!(
            "{CATCH} [attempt(function () {{ return new WeakRef(); }}), \
             attempt(function () {{ return new WeakRef(1); }}), \
             attempt(function () {{ return new WeakRef('s'); }}), \
             attempt(function () {{ return new WeakRef(null); }}), \
             attempt(function () {{ return new WeakRef(Symbol()); }})].join('|')"
        )),
        "TypeError: no target|TypeError: target: not an object|\
         TypeError: target: not an object|TypeError: target: not an object|\
         TypeError: target: not an object"
    );
}

#[test]
fn a_registry_callback_must_be_callable() {
    assert_eq!(
        result(&format!(
            "{CATCH} [attempt(function () {{ return new FinalizationRegistry(); }}), \
             attempt(function () {{ return new FinalizationRegistry({{}}); }}), \
             attempt(function () {{ return new FinalizationRegistry(1); }})].join('|')"
        )),
        "TypeError: no callback|TypeError: callback: not a function|\
         TypeError: callback: not a function"
    );
}

#[test]
fn instances_chain_to_their_prototypes_and_are_extensible() {
    assert_eq!(
        result(
            r#"
            var w = new WeakRef({});
            var r = new FinalizationRegistry(function () {});
            w.x = 1; r.y = 2;
            [Object.getPrototypeOf(w) === WeakRef.prototype,
             Object.getPrototypeOf(r) === FinalizationRegistry.prototype,
             Object.isExtensible(w), Object.isExtensible(r), w.x, r.y,
             WeakRef.prototype.constructor === WeakRef,
             FinalizationRegistry.prototype.constructor === FinalizationRegistry].join()
            "#
        ),
        "true,true,true,true,1,2,true,true"
    );
}

#[test]
fn instances_stringify_by_their_to_string_tags() {
    assert_eq!(
        result(
            r#"
            var ts = Object.prototype.toString;
            [ts.call(new WeakRef({})), ts.call(new FinalizationRegistry(function () {}))].join()
            "#
        ),
        "[object WeakRef],[object FinalizationRegistry]"
    );
    assert_eq!(
        result(
            r#"
            function tag(o) {
              var d = Object.getOwnPropertyDescriptor(o, Symbol.toStringTag);
              return d.value + ':' + d.writable + d.enumerable + d.configurable;
            }
            [tag(WeakRef.prototype), tag(FinalizationRegistry.prototype)].join()
            "#
        ),
        "WeakRef:falsefalsetrue,FinalizationRegistry:falsefalsetrue"
    );
}

#[test]
fn construction_honors_a_derived_new_target_prototype() {
    assert_eq!(
        result(
            r#"
            class W extends WeakRef {}
            class R extends FinalizationRegistry {}
            var w = new W({});
            var r = new R(function () {});
            [w instanceof W, w instanceof WeakRef, typeof w.deref(),
             r instanceof R, r instanceof FinalizationRegistry,
             typeof r.register({}, 1)].join()
            "#
        ),
        "true,true,object,true,true,undefined"
    );
    // The argument is validated before `new.target.prototype` is read
    // (ECMA-262 26.1.1.1 steps 2-3; `fx_WeakRef` checks the target first).
    assert_eq!(
        result(&format!(
            "{CATCH}
            var log = [];
            var NT = new Proxy(function () {{}}, {{
              get: function (t, k, r) {{ if (k === 'prototype') log.push('P'); return Reflect.get(t, k, r); }}
            }});
            log.push(attempt(function () {{ return Reflect.construct(WeakRef, [1], NT); }}));
            log.push(attempt(function () {{ return Reflect.construct(FinalizationRegistry, [1], NT); }}));
            Reflect.construct(WeakRef, [{{}}], NT);
            log.join('|')"
        )),
        "TypeError: target: not an object|TypeError: callback: not a function|P"
    );
}

// ---------------------------------------------------------------------
// The prototype methods
// ---------------------------------------------------------------------

#[test]
fn the_methods_carry_their_names_and_lengths() {
    assert_eq!(
        result(
            r#"
            function d(o, k) {
              var p = Object.getOwnPropertyDescriptor(o, k);
              return k + ':' + p.value.name + ':' + p.value.length + ':' + p.writable + p.enumerable + p.configurable;
            }
            [d(WeakRef.prototype, 'deref'),
             d(FinalizationRegistry.prototype, 'register'),
             d(FinalizationRegistry.prototype, 'unregister')].join()
            "#
        ),
        "deref:deref:0:truefalsetrue,register:register:2:truefalsetrue,unregister:unregister:1:truefalsetrue"
    );
    assert_eq!(
        result(&format!(
            "{CATCH} [attempt(function () {{ return new WeakRef.prototype.deref(); }}), \
             attempt(function () {{ return new FinalizationRegistry.prototype.register(); }})].join('|')"
        )),
        "TypeError: new: not a constructor|TypeError: new: not a constructor"
    );
}

#[test]
fn deref_returns_the_live_target_and_brand_checks_its_receiver() {
    assert_eq!(
        result(&format!(
            "{CATCH}
            var o = {{}};
            var w = new WeakRef(o);
            [w.deref() === o,
             attempt(function () {{ return WeakRef.prototype.deref.call({{}}); }}),
             attempt(function () {{ return WeakRef.prototype.deref.call(1); }}),
             attempt(function () {{ return WeakRef.prototype.deref.call(WeakRef.prototype); }}),
             attempt(function () {{ return WeakRef.prototype.deref.call(new WeakMap()); }})].join('|')"
        )),
        "true|TypeError: this is no WeakRef instance|TypeError: this is no WeakRef instance|\
         TypeError: this is no WeakRef instance|TypeError: this is no WeakRef instance"
    );
}

#[test]
fn register_validates_its_arguments_like_xs() {
    assert_eq!(
        result(&format!(
            "{CATCH}
            var r = new FinalizationRegistry(function () {{}});
            var o = {{}};
            [attempt(function () {{ return r.register(); }}),
             attempt(function () {{ return r.register(1); }}),
             attempt(function () {{ return r.register(Symbol()); }}),
             attempt(function () {{ return r.register(o, o); }}),
             attempt(function () {{ return r.register(o, 1, 2); }}),
             attempt(function () {{ return r.register(o, 1, Symbol()); }}),
             attempt(function () {{ return r.register(o); }}),
             attempt(function () {{ return r.register(o, 'held'); }}),
             attempt(function () {{ return r.register(o, 'held', undefined); }}),
             attempt(function () {{ return r.register(o, o.x, {{}}); }}),
             attempt(function () {{ return r.register(o, undefined, o); }}),
             attempt(function () {{ return FinalizationRegistry.prototype.register.call(1, o); }}),
             attempt(function () {{ return FinalizationRegistry.prototype.register.call({{}}, o); }}),
             attempt(function () {{ return FinalizationRegistry.prototype.register.call(FinalizationRegistry.prototype, o); }})
            ].join('|')"
        )),
        "TypeError: no target|TypeError: target: not an object|TypeError: target: not an object|\
         TypeError: target and holdings are the same|TypeError: token: not an object|\
         TypeError: token: not an object|returned undefined|returned undefined|\
         returned undefined|returned undefined|returned undefined|\
         TypeError: this: not an object|TypeError: this: not a FinalizationRegistry instance|\
         TypeError: this: not a FinalizationRegistry instance"
    );
}

#[test]
fn unregister_drops_every_cell_with_the_token_and_reports_whether_any_was() {
    assert_eq!(
        result(&format!(
            "{CATCH}
            var r = new FinalizationRegistry(function () {{}});
            var a = {{}}, b = {{}}, t = {{}}, u = {{}};
            r.register(a, 'a', t);
            r.register(b, 'b', t);
            r.register(a, 'a2', u);
            r.register(b, 'b2');
            [attempt(function () {{ return r.unregister(); }}),
             attempt(function () {{ return r.unregister(1); }}),
             attempt(function () {{ return r.unregister(Symbol()); }}),
             r.unregister({{}}), r.unregister(t), r.unregister(t), r.unregister(u), r.unregister(b),
             attempt(function () {{ return FinalizationRegistry.prototype.unregister.call({{}}, t); }})
            ].join('|')"
        )),
        "TypeError: no token|TypeError: token: not an object|TypeError: token: not an object|\
         false|true|false|true|false|TypeError: this: not a FinalizationRegistry instance"
    );
}

#[test]
fn hardened_registries_stay_mutable_like_xs() {
    // `fx_petrify` stamps only buffer, date and collection internals
    // read-only; a hardened registry still registers and unregisters.
    assert_eq!(
        result(
            r#"
            var r = harden(new FinalizationRegistry(function () {}));
            var t = {};
            r.register({}, 1, t);
            [Object.isFrozen(r), r.unregister(t), r.unregister(t)].join()
            "#
        ),
        "true,true,false"
    );
}

// ---------------------------------------------------------------------
// The collector
// ---------------------------------------------------------------------

#[test]
fn a_weak_ref_survives_a_collection_while_its_target_is_reachable() {
    let mut m = machine();
    assert!(crank(&mut m, "var keep = {v: 1}; var w = new WeakRef(keep); 0;").completed);
    m.collect_garbage().unwrap();
    let outcome = crank(&mut m, "w.deref() === keep ? w.deref().v : 'cleared'");
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert_eq!(outcome.result, "1");
}

#[test]
fn a_full_collection_clears_an_unreachable_weak_ref_target() {
    let mut m = machine();
    assert!(
        crank(
            &mut m,
            "var w = new WeakRef({v: 1}); var seen = typeof w.deref(); 0;"
        )
        .completed
    );
    // The target stayed alive through its own job (the quiescent-only
    // collector never runs mid-crank), and dies at the boundary.
    m.collect_garbage().unwrap();
    let outcome = crank(&mut m, "seen + ' ' + typeof w.deref()");
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert_eq!(outcome.result, "object undefined");
    // A cleared WeakRef stays cleared and stays branded.
    m.collect_garbage().unwrap();
    let outcome = crank(
        &mut m,
        "typeof w.deref() + ' ' + Object.prototype.toString.call(w)",
    );
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert_eq!(outcome.result, "undefined [object WeakRef]");
}

#[test]
fn a_registry_runs_its_callback_at_the_next_job_boundary_after_a_target_dies() {
    let mut m = machine();
    assert!(
        crank(
            &mut m,
            r#"
        var log = [];
        var keep = {};
        var r = new FinalizationRegistry(function (held) { log.push(held); });
        r.register({}, 'dead-1');
        r.register(keep, 'alive');
        r.register({}, 'dead-2', keep);
        r.register({}, 'unregistered', keep);
        r.unregister(keep);
        0;
        "#
        )
        .completed
    );
    // No cleanup without a collection: the targets are still alive.
    let outcome = crank(&mut m, "log.join()");
    assert_eq!(outcome.result, "");
    m.collect_garbage().unwrap();
    // The cleanup runs after THIS crank's job queue drains (`fxEndJob`), so
    // the script itself still sees an empty log, and a reaction queued by
    // the callback runs in the same crank, which ends quiescent.
    let outcome = crank(
        &mut m,
        "var before = log.join(); Promise.resolve().then(function () { log.push('job'); }); before",
    );
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert_eq!(outcome.result, "");
    assert!(!m.has_pending_jobs());
    assert!(m.is_quiescent());
    let outcome = crank(&mut m, "log.join()");
    assert_eq!(outcome.result, "job,dead-1");
    // A second collection finds nothing new: `keep` is reachable, and the
    // unregistered cell is gone.
    m.collect_garbage().unwrap();
    let outcome = crank(&mut m, "log.join()");
    assert_eq!(outcome.result, "job,dead-1");
    // A registry's holdings are strong: a dead target's holdings reach the
    // callback intact even when nothing else references them.
    assert!(crank(&mut m, "r.register({}, {deep: 'held'}); keep = null; 0;").completed);
    m.collect_garbage().unwrap();
    assert!(crank(&mut m, "0").completed);
    let outcome = crank(
        &mut m,
        "log.map(function (h) { return typeof h === 'object' ? h.deep : h; }).join()",
    );
    assert_eq!(outcome.result, "job,dead-1,alive,held");
}

#[test]
fn a_pump_without_a_script_also_runs_the_cleanup() {
    let mut m = machine();
    assert!(crank(
        &mut m,
        "var log = []; var r = new FinalizationRegistry(function (h) { log.push(h); }); r.register({}, 'h'); 0;"
    )
    .completed);
    m.collect_garbage().unwrap();
    let outcome = m.run_promise_jobs();
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert_eq!(crank(&mut m, "log.join()").result, "h");
}

#[test]
fn a_registry_with_cells_outlives_the_guest_dropping_it() {
    // `mxFinalizationRegistries` keeps a registry alive while it has cells,
    // so its callback still runs once its target dies.
    let mut m = machine();
    assert!(crank(
        &mut m,
        "var log = []; new FinalizationRegistry(function (h) { log.push(h); }).register({}, 'orphan'); 0;"
    )
    .completed);
    m.collect_garbage().unwrap();
    assert!(crank(&mut m, "0").completed);
    assert_eq!(crank(&mut m, "log.join()").result, "orphan");
}

#[test]
fn a_throwing_cleanup_callback_halts_the_crank_and_keeps_the_remaining_cells() {
    let mut m = machine();
    assert!(crank(
        &mut m,
        r#"
        var log = [];
        var r = new FinalizationRegistry(function (h) { log.push(h); if (h === 'boom') throw new Error('cleanup ' + h); });
        r.register({}, 'boom');
        r.register({}, 'after');
        0;
        "#
    )
    .completed);
    m.collect_garbage().unwrap();
    let outcome = crank(&mut m, "0");
    assert!(!outcome.completed);
    match outcome.halt {
        ironhorse_vm::Halt::Throw { rendered, .. } => assert_eq!(rendered, "Error: cleanup boom"),
        other => panic!("{other:?}"),
    }
    // The cell that threw is gone; the one after it waits for the next
    // boundary, which is the end of the next completed crank -- after that
    // crank's own script has read the log.
    let outcome = crank(&mut m, "log.join()");
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert_eq!(outcome.result, "boom");
    assert_eq!(crank(&mut m, "log.join()").result, "boom,after");
}

#[test]
fn dead_tokens_are_dropped_and_weak_refs_do_not_keep_targets_alive_for_each_other() {
    let mut m = machine();
    assert!(
        crank(
            &mut m,
            r#"
        var log = [];
        var r = new FinalizationRegistry(function (h) { log.push(h); });
        var keep = {};
        r.register(keep, 'kept', {});
        var w1 = new WeakRef({}), w2 = new WeakRef({});
        var wm = new WeakMap();
        wm.set(keep, new WeakRef(w1.deref()));
        0;
        "#
        )
        .completed
    );
    m.collect_garbage().unwrap();
    let outcome = crank(
        &mut m,
        "[typeof w1.deref(), typeof w2.deref(), typeof wm.get(keep).deref(), log.join()].join('|')",
    );
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert_eq!(outcome.result, "undefined|undefined|undefined|");
    assert!(m.is_quiescent());
}

#[test]
fn a_machine_holding_a_weak_ref_or_registry_is_persistable() {
    // Both tables travel in the snapshot image (`WKRF`/`FNRG`), so neither
    // trips the persist gate; `ironhorse-snapshot`'s `weak_ref_carry.rs`
    // proves the round trip.
    let mut m = machine();
    assert_eq!(m.stored_unpersistable_row(), None);
    assert!(crank(
        &mut m,
        "var w = new WeakRef({}); var r = new FinalizationRegistry(function () {}); r.register({}, 1, {}); 0;"
    )
    .completed);
    assert_eq!(m.stored_unpersistable_row(), None);
    assert_eq!(m.weak_refs_snapshot().len(), 1);
    assert_eq!(m.finalization_registries_snapshot().len(), 1);
    m.collect_garbage().unwrap();
    // A cleared target and a flagged registry are persistable states too.
    assert_eq!(m.stored_unpersistable_row(), None);
    assert_eq!(m.weak_refs_snapshot()[0].target, u32::MAX);
    assert!(m.finalization_registries_snapshot()[0].changed);
}
