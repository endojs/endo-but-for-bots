//! Intrinsic reflection and constructor probes exercised by the SES bootstrap.
mod common;
use common::TestCompiler;

use ironhorse_vm::{parse_symbols, Interp};

fn result(source: &str) -> String {
    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn({
            let source = source.to_string();
            move || {
                let (code, symbols) = ironhorse_compile::compile_atoms(&source).unwrap();
                let mut machine = Interp::new();
                machine.set_source_compiler(std::rc::Rc::new(TestCompiler));
                machine.link_intrinsics(&parse_symbols(&symbols));
                let outcome = machine.run(&code);
                assert!(outcome.completed, "{:?}", outcome.halt);
                outcome.result
            }
        })
        .unwrap()
        .join()
        .unwrap()
}

#[test]
fn buffer_accessors_can_be_captured_and_brand_check_the_receiver() {
    assert_eq!(
        result(
            r#"
        var b = new ArrayBuffer(12), v = new DataView(b, 3, 5);
        var get = (p, n) => Object.getOwnPropertyDescriptor(p, n).get;
        var a = get(ArrayBuffer.prototype, 'byteLength');
        var d = get(DataView.prototype, 'byteLength');
        var o = get(DataView.prototype, 'byteOffset');
        var r = get(DataView.prototype, 'buffer');
        var caught = 0;
        for (var f of [a, d, o, r]) { try { f.call({}) } catch(e) { caught += e instanceof TypeError; } }
        [a.call(b), d.call(v), o.call(v), r.call(v) === b, caught].join(':')
    "#
        ),
        "12:5:3:true:4"
    );
}

#[test]
fn generator_function_prototype_exposes_the_shared_generator_prototype() {
    assert_eq!(
        result(
            r#"
        var f = function*() { yield 42; };
        var p = Object.getPrototypeOf(f);
        var d = Object.getOwnPropertyDescriptor(p, 'prototype');
        [d.value === Object.getPrototypeOf(f.prototype), d.writable, d.enumerable,
         d.configurable, p.prototype.next.call(f()).value].join(':')
    "#
        ),
        "true:false:false:true:42"
    );
}

#[test]
fn collection_constructor_detection_throws_catchable_type_errors() {
    assert_eq!(
        result(
            r#"
        var n = 0;
        for (var C of [Map, Set, WeakMap, WeakSet]) {
            try { C(); } catch(e) { n += e instanceof TypeError; }
            var c = new C();
            n += typeof c === 'object';
        }
        n
    "#
        ),
        "8"
    );
}

#[test]
fn in_links_computed_intrinsic_names_without_resurrecting_deleted_members() {
    assert_eq!(
        result(
            r#"
        var name = 'to' + 'String';
        var before = name in {};
        delete Object.prototype[name];
        var after = name in {};
        [before, after, 'ent' + 'ries' in new Map()].join(':')
    "#
        ),
        "true:false:true"
    );
}

#[test]
fn short_eval_does_not_lower_the_intrinsic_install_floor() {
    assert_eq!(
        result(
            r#"
        var p = Iterator.prototype;
        var old = Reflect.ownKeys(p);
        for (var key of old) { if(key !== Symbol.iterator) delete p[key]; }
        (0, eval)('1');
        Reflect.ownKeys(p).map(String).join(',')
    "#
        ),
        "Symbol(Symbol.iterator)"
    );
}

#[test]
fn async_generator_inherits_a_distinct_async_iterator_prototype() {
    assert_eq!(
        result(
            r#"
        var f = async function*() {};
        var g = Object.getPrototypeOf(f).prototype;
        var p = Object.getPrototypeOf(g);
        var o = {};
        [p !== Object.prototype, Object.getPrototypeOf(p) === Object.prototype,
         p[Symbol.asyncIterator].call(o) === o].join(':')
    "#
        ),
        "true:true:true"
    );
}

#[test]
fn computed_compound_assignment_preserves_reference_and_evaluates_key_once() {
    assert_eq!(
        result(
            r#"
        var o = {n: 3}, calls = 0;
        var key = () => { calls++; return 'n'; };
        var a = o[key()] += 4;
        var b = o[key()] ||= 99;
        var c = o[key()] &&= 11;
        [a, b, c, o.n, calls].join(':')
    "#
        ),
        "7:7:11:11:3"
    );
}

#[test]
fn intrinsic_reflection_materializes_symbol_keys_before_freeze() {
    assert_eq!(
        result(
            r#"
        const prototype = Array.prototype;
        const keys = Reflect.ownKeys(prototype);
        const symbol = Symbol.unscopables;
        const present = keys.includes(symbol);
        delete prototype[symbol];
        Object.freeze(prototype);
        const before = Reflect.ownKeys(prototype).length;
        eval("Array.prototype[Symbol.unscopables]; Array.prototype['to' + 'Sorted'];");
        [present, Object.isFrozen(prototype), prototype[symbol] === undefined,
         Reflect.ownKeys(prototype).length === before].join(':')
    "#
        ),
        "true:true:true:true"
    );
}

#[test]
fn later_intrinsic_linking_preserves_frozen_descriptors() {
    assert_eq!(
        result(
            r#"
        const protos = [Array.prototype, Error.prototype,
          Object.getPrototypeOf((async function* () {})()).constructor.prototype];
        protos.forEach(Object.freeze);
        const before = protos.map(p => Reflect.ownKeys(p).length);
        eval("new Intl.NumberFormat(); Object.getOwnPropertyDescriptor(Error.prototype, 'stack');");
        protos.map((p, i) => Object.isFrozen(p) && Reflect.ownKeys(p).length === before[i]).join(':')
    "#
        ),
        "true:true:true"
    );
}

#[test]
fn frozen_global_is_not_extended_by_computed_intrinsic_names() {
    assert_eq!(
        result(
            r#"
        (() => {
            const global = globalThis;
            Object.freeze(global);
            const count = Reflect.ownKeys(global).length;
            const name = ['Weak', 'Set'].join('');
            const constructor = global[name];
            return [typeof constructor, Object.isFrozen(global), Reflect.ownKeys(global).length === count].join(':');
        })()
    "#
        ),
        "function:true:true"
    );
}

#[test]
fn buffer_named_reads_honor_accessor_replacement_deletion_and_shadowing() {
    assert_eq!(
        result(
            r#"
        const buffer = new ArrayBuffer(12), view = new DataView(buffer, 3, 5);
        const cases = [[buffer, ArrayBuffer.prototype, 'byteLength'],
            [view, DataView.prototype, 'byteLength'],
            [view, DataView.prototype, 'byteOffset'],
            [view, DataView.prototype, 'buffer']];
        const direct = [(x) => x.byteLength, (x) => x.byteLength,
            (x) => x.byteOffset, (x) => x.buffer];
        cases.map(([instance, prototype, key], i) => {
            const read = direct[i];
            Object.defineProperty(prototype, key, {get() { return 99; }});
            const replaced = read(instance) === 99 && Reflect.get(instance, key) === 99;
            delete prototype[key];
            const deleted = read(instance) === undefined && Reflect.get(instance, key) === undefined;
            Object.defineProperty(instance, key, {value: 42});
            return replaced && deleted && read(instance) === 42 && Reflect.get(instance, key) === 42;
        }).join(':')
    "#
        ),
        "true:true:true:true"
    );
}

/// The guest Hardened-JavaScript surface the ENGINE does not implement, and
/// the realm profile that decides whether the shim can supply it instead.
///
/// `designs/ironhorse-ses-compartment-equivalence.md` measures ironhorse as
/// having no guest `lockdown` and no guest `Compartment`. Both are true of the
/// engine's own bindings, and neither is the whole story: the real `ses` shim
/// installs both, and `packages/thixotrope` already ships that configuration
/// (`scripts/bundle-ironhorse-worker.mjs` bundles `ses`, deletes
/// `polyfills.js`'s `harden` so the shim can install its own, and calls
/// `lockdown({ errorTaming: 'safe', reporting: 'none', overrideTaming: 'min' })`).
///
/// What decides whether the shim can supply it is WHEN the freeze happens, not
/// which constructor was used. `Interp::new()` and
/// `Machine::unfrozen_with_start_global_names` leave the intrinsics mutable and the
/// shim repairs and then freezes them itself. `Machine::new()` freezes them at
/// construction, and the shim's `repairIntrinsics` cannot then rewrite a
/// descriptor it needs to.
///
/// That used to make the two mutually exclusive -- the multi-compartment
/// `Machine` API came only with the construction-time freeze. Deferring the
/// freeze removes the exclusion: see
/// `an_unfrozen_machine_takes_the_shim_and_keeps_its_compartments`.
fn thixotrope_ses_boot() -> Option<String> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/thixotrope/dist-ironhorse/boot.js"
    );
    match std::fs::read_to_string(path) {
        Ok(source) => Some(source),
        Err(_) => {
            assert!(
                std::env::var_os("IRONHORSE_SES_SHIM_REQUIRED").is_none(),
                "IRONHORSE_SES_SHIM_REQUIRED is set but {path} is absent: the lane \
                 claims to have run `yarn workspace @endo/thixotrope \
                 build:ironhorse-bundles` and did not"
            );
            eprintln!(
                "ses-shim: dist-ironhorse/boot.js absent \u{2014} run \
                 `yarn workspace @endo/thixotrope build:ironhorse-bundles` to run this"
            );
            None
        }
    }
}

/// The realm profile, as a single line.
///
/// `hardenTraverses` is the one entry that is not a `typeof`, and it is the
/// point of the census rather than a flourish. Every configuration here has
/// SOME `harden` -- the engine binds its own, the shim installs its own, and a
/// pre-lockdown stand-in is a third -- so `typeof harden` is `function`
/// throughout and pins nothing. What distinguishes them is whether `harden`
/// walks prototype chains, which is what makes it a security primitive rather
/// than an `Object.freeze` alias: a hardened object whose prototype is still
/// extensible has methods anyone holding that prototype can replace.
///
/// The probe hardens `{ __proto__: proto }` where `proto` itself has a NULL
/// prototype, and asks whether `proto` came out frozen. The null link is
/// load-bearing: a probe built on `{}` would walk to `Object.prototype` and
/// freeze the intrinsic graph, which is exactly the pre-lockdown freeze the
/// prologue exists to avoid -- the census would corrupt the realm it measures
/// and take `frozenObjectProto` with it.
const SES_CENSUS: &str = "['lockdown','harden','Compartment']\
    .map(function(n){ return n + '=' + (typeof globalThis[n]); }).join(' ') \
    + ' hardenTraverses=' + (function(){ \
        if (typeof globalThis.harden !== 'function') { return 'n/a'; } \
        var proto = { __proto__: null }; \
        try { globalThis.harden({ __proto__: proto }); } \
        catch (e) { return 'threw:' + e.message; } \
        return String(Object.isFrozen(proto)); \
      })() \
    + ' frozenObjectProto=' + Object.isFrozen(Object.prototype)";

/// What a realm frozen before the prologue runs reports, verbatim.
///
/// Named rather than inlined because it is a PROPERTY OF WHICH REPAIR THE
/// PROLOGUE ATTEMPTS FIRST AGAINST A SEALED SLOT, not of the shim: reorder
/// `packages/ironhorse-prelude/prelude.js` and this string changes without
/// anything being wrong. The assertion below says what must not change -- that
/// the boot forecloses at all -- and this says where it currently does.
///
/// Not the prologue's first statement, which is `delete globalThis.harden`:
/// that one SUCCEEDS even here, because `Machine::new`'s freeze seals the
/// intrinsic graph and not the start global's own properties. The first
/// operation it actually refuses is the `Iterator.prototype` sweep.
const FROZEN_REALM_FORECLOSURE: &str = "ERROR: delete map: no permission (strict mode)";

/// `eval_wrapped`'s shape: an engine halt is not catchable, so a `'ok'` here
/// means the program ran to completion and threw nothing.
fn wrapped(source: &str) -> String {
    format!("var __e; try {{ {source} }} catch(e) {{ __e = e; }} __e ? ('ERROR: ' + __e.message) : 'ok'")
}

#[test]
fn the_ses_shim_supplies_the_guest_surface_on_an_unfrozen_realm() {
    let Some(boot) = thixotrope_ses_boot() else {
        return;
    };
    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(move || {
            let mut machine = Interp::new();
            machine.set_source_compiler(std::rc::Rc::new(TestCompiler));
            let mut crank = |source: &str| {
                let (code, symbols) = ironhorse_compile::compile_atoms_goal(
                    source,
                    ironhorse_compile::Goal::Script,
                    false,
                )
                .expect("compiles");
                let names = parse_symbols(&symbols);
                let code = if machine.program_symbol_names().is_empty() {
                    machine.link_intrinsics(&names);
                    code
                } else {
                    machine.relink_crank(&code, &names).expect("relinks")
                };
                let outcome = machine.run(&code);
                assert!(outcome.completed, "{source:.60}: {:?}", outcome.halt);
                outcome.result
            };

            assert_eq!(
                crank(SES_CENSUS),
                "lockdown=function harden=function Compartment=undefined \
                 hardenTraverses=true frozenObjectProto=false",
                "the engine binds its own lockdown and its own harden -- which \
                 traverses, it is a port of XS's fx_hardenFreezeAndTraverse -- \
                 but no Compartment"
            );
            // **Neither `lockdown=function` nor `harden=function`
            // discriminates, so pin identity too.** Before the engine bound a
            // `lockdown`, that census term meant "the shim installed one". It
            // is now `function` on both sides of the shim's evaluation and says
            // nothing about whose it is, and `harden` never said anything: the
            // engine binds one too. Only `Compartment` and `frozenObjectProto`
            // still move in the census itself.
            //
            // So stash BOTH engine bindings and compare each against its own
            // counterpart. An earlier revision stashed only `__engineLockdown`
            // and then compared `harden` against it, which is `false` however
            // `harden` was built -- a second vacuous term in a test whose
            // purpose is to catch exactly that.
            crank(
                "globalThis.__engineLockdown = globalThis.lockdown; \
                 globalThis.__engineHarden = globalThis.harden; 0",
            );
            assert_eq!(crank(&wrapped(&boot)), "ok", "the ses shim must evaluate");
            assert_eq!(
                crank(SES_CENSUS),
                "lockdown=function harden=function Compartment=function \
                 hardenTraverses=true frozenObjectProto=true",
                "the shim must install what the engine does not, and freeze -- and \
                 the harden it leaves behind must still traverse prototypes"
            );
            assert_eq!(
                crank(
                    "[typeof globalThis.lockdown, typeof globalThis.harden, \
                      globalThis.lockdown === globalThis.__engineLockdown, \
                      globalThis.harden === globalThis.__engineHarden].join(' ')"
                ),
                "function function false false",
                "the shim REPLACED both of the engine's bindings with its own, and \
                 both are still callable afterwards; a typeof census sees neither \
                 replacement"
            );
            // Not merely present: usable, with its own globals and its own
            // evaluator. The `__options__` sigil selects the modern
            // constructor signature; a bare object is the legacy
            // `(globals, modules, options)` positional form
            // (`packages/ses/src/compartment.js:294-316`).
            assert_eq!(
                crank(
                    "var c = new Compartment({ __options__: true, globals: { x: 5 } }); \
                     [c.evaluate('x'), c.evaluate('1 + 1'), typeof x].join(':')"
                ),
                "5:2:undefined",
                "a shim Compartment must evaluate against its own globals, and \
                 must not leak them into the realm that made it"
            );
        })
        .unwrap()
        .join()
        .unwrap();
}

#[test]
fn a_natively_frozen_realm_forecloses_the_ses_shim() {
    let Some(boot) = thixotrope_ses_boot() else {
        return;
    };
    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(move || {
            let machine = ironhorse_vm::Machine::new();
            machine
                .set_source_compiler(std::rc::Rc::new(TestCompiler))
                .expect("machine takes a compiler");
            let start = machine.start_compartment();
            let crank = |source: &str| {
                let (code, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
                let outcome = start.evaluate_with_symbols(&code, &symbols);
                assert!(outcome.completed, "{source:.60}: {:?}", outcome.halt);
                outcome.result
            };
            assert!(
                crank(SES_CENSUS).ends_with("frozenObjectProto=true"),
                "Machine::new freezes the intrinsic graph at construction"
            );
            // The boot now forecloses one layer EARLIER than it used to, and
            // the message changed with it.
            //
            // It used to reach `repairIntrinsics`, which rewrites descriptors
            // on intrinsics the native freeze has already sealed, and report
            // the engine's generic `invalid descriptor`. The repairs ahead of
            // the shim are now a bundled module (`@endo/ironhorse-prelude`)
            // rather than raw statements spliced into the boot script, so they
            // run in STRICT mode. `delete Iterator.prototype.map` on a frozen
            // intrinsic returned false silently under the old sloppy-mode
            // splice; strict mode throws, so the prologue stops there and the
            // shim never runs.
            //
            // Both are foreclosure, and the new one is the better report: it
            // names the first operation the frozen realm actually refused,
            // rather than the first one the shim happened to try afterwards.
            assert_eq!(
                crank(&wrapped(&boot)),
                FROZEN_REALM_FORECLOSURE,
                "the shim is expected to fail on a realm frozen before it runs; \
                 if it now succeeds, the repair path has changed and \
                 designs/ironhorse-ses-compartment-equivalence.md must say so"
            );
            // The message alone would also match an unrelated prologue bug, so
            // pin the outcome too: the shim installed nothing, and the realm is
            // left with NO `harden` at all. The prologue's `delete` of the
            // engine's own succeeded -- see `FROZEN_REALM_FORECLOSURE` -- and
            // the `lockdown()` that would have installed the shim's was never
            // reached. That is the honest report of a half-applied prologue,
            // and it is why this realm profile is foreclosed rather than
            // merely degraded: a guest here would have neither hardener.
            //
            // `lockdown` is still `function`, and it is the ENGINE's, not the
            // shim's: `create_hardened_globals` binds one on every realm. A
            // `typeof` census can say no more than that, and an earlier
            // revision of this comment read more into it -- that such a realm
            // "has a native `lockdown()`" and so "the option now exists". It
            // does not. This is a `Machine::new()` realm, which performs the
            // whole lockdown operation at construction and sets `locked_down`
            // while doing it; the guest's first call is therefore refused as a
            // second one. The name is bound and calling it throws.
            // `native_lockdown.rs::a_frozen_machine_runs_the_whole_lockdown_at_construction`
            // pins the refusal together with the reach it costs nothing:
            // construction already rewired the constructors, so there is no
            // work the refused call would have done.
            assert_eq!(
                crank(SES_CENSUS),
                "lockdown=function harden=undefined Compartment=undefined \
                 hardenTraverses=n/a frozenObjectProto=true"
            );
            // `lockdown=function` above is the weak term: the engine binds one
            // on every realm, so it is `function` whether the shim ran or not.
            // CALL it, and the message says whose it is -- the engine's refuses
            // a machine that locked down at construction, where the shim's
            // would have said `Already locked down ... (SES_MULTIPLE_INSTANCES)`
            // had it installed.
            assert_eq!(
                crank(
                    "try { lockdown(); 'returned' } \
                     catch (e) { e.name + ': ' + e.message }"
                ),
                "TypeError: lockdown already called",
                "the bound lockdown is the ENGINE's, and the machine already ran it"
            );
        })
        .unwrap()
        .join()
        .unwrap();
}

/// The two profiles stop excluding each other when the freeze is deferred.
///
/// `Machine::new` froze the intrinsics at construction, which is what made the
/// shim fail on it. `Machine::unfrozen_with_start_global_names` builds the same
/// shared realm and leaves the graph mutable, so the guest's own `lockdown()`
/// can repair and freeze it -- and the multi-compartment API survives, which
/// a bare `Interp` does not offer.
#[test]
fn an_unfrozen_machine_takes_the_shim_and_keeps_its_compartments() {
    let Some(boot) = thixotrope_ses_boot() else {
        return;
    };
    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(move || {
            let machine = ironhorse_vm::Machine::unfrozen_with_start_global_names(None);
            machine
                .set_source_compiler(std::rc::Rc::new(TestCompiler))
                .expect("machine takes a compiler");
            assert!(!machine.intrinsics().is_locked_down());
            let start = machine.start_compartment();
            let crank = |c: &ironhorse_vm::Compartment, source: &str| {
                let (code, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
                let outcome = c.evaluate_with_symbols(&code, &symbols);
                assert!(outcome.completed, "{source:.60}: {:?}", outcome.halt);
                outcome.result
            };
            assert_eq!(
                crank(&start, SES_CENSUS),
                "lockdown=undefined harden=function Compartment=undefined \
                 hardenTraverses=true frozenObjectProto=false",
                "an UNFROZEN machine does not bind the engine's `lockdown`: \
                 `freeze == false` means the SES shim owns the operation, and \
                 the shim installs its own when it evaluates. The harden it \
                 does bind traverses"
            );
            assert_eq!(
                crank(&start, &wrapped(&boot)),
                "ok",
                "the shim must evaluate"
            );
            assert_eq!(
                crank(&start, SES_CENSUS),
                "lockdown=function harden=function Compartment=function \
                 hardenTraverses=true frozenObjectProto=true",
                "the guest's own lockdown must install and freeze, and leave a \
                 harden that traverses prototypes"
            );
            // The engine's multi-compartment API still works, and the guest's
            // freeze reached the graph the sibling shares.
            let sibling = machine.new_compartment();
            assert_eq!(
                crank(&sibling, "Object.isFrozen(Object.prototype)"),
                "true",
                "a sibling sees the graph the guest froze"
            );
            assert_eq!(crank(&start, "var here = 1; here"), "1");
            assert_eq!(crank(&sibling, "typeof here"), "undefined");
        })
        .unwrap()
        .join()
        .unwrap();
}
