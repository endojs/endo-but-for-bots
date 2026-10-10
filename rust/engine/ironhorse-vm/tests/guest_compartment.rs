//! The guest `Compartment` (`Native::Compartment`, `fx_Compartment` in
//! `c/moddable/xs/sources/xsModule.c`), scoped in
//! `designs/ironhorse-guest-compartment.md`.
//!
//! Phase 1 is the non-module surface. The module half — `import`, `importNow`,
//! and real `resolveHook`/`importHook` callables — is phase 2 and is gated on
//! threading a referrer through `ModuleGraph::resolve`.
mod common;
use common::TestCompiler;

use ironhorse_vm::{parse_symbols, Compartment, Interp, Machine};

/// Run `source` on a default machine, as `native_lockdown.rs` does.
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

fn compartment_result(compartment: &Compartment, source: &str) -> String {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let outcome = compartment.evaluate_with_symbols(&code, &symbols);
    assert!(outcome.completed, "{source}: {:?}", outcome.halt);
    outcome.result
}

const CATCH: &str = r#"
function attempt(f) {
  try { var v = f(); return 'returned ' + String(v); }
  catch (e) { return e.name + ': ' + e.message; }
}
"#;

#[test]
fn the_constructor_is_a_guest_global() {
    assert_eq!(result("typeof Compartment"), "function");
    assert_eq!(result("Compartment.length"), "1");
    assert_eq!(result("Compartment.name"), "Compartment");
}

#[test]
fn a_compartment_stringifies_by_its_to_string_tag() {
    assert_eq!(result("String(new Compartment())"), "[object Compartment]");
}

#[test]
fn the_to_string_tag_is_a_non_writable_configurable_data_property() {
    assert_eq!(
        result(
            r#"
            var d = Object.getOwnPropertyDescriptor(
              Compartment.prototype, Symbol.toStringTag);
            [d.value, d.writable, d.enumerable, d.configurable, 'get' in d].join(',')
            "#
        ),
        "Compartment,false,false,true,false"
    );
}

/// `constructor/options-type.js`: arity decides, not the value. A supplied
/// `undefined` is a `TypeError`; no argument at all is the default compartment.
#[test]
fn options_are_required_to_be_an_object_when_supplied() {
    let source = format!(
        r#"{CATCH}
        function check(options) {{ return function () {{
          return String(new Compartment(options)); }}; }}
        [
          String(new Compartment()),
          attempt(check(undefined)),
          attempt(check(null)),
          attempt(check(false)),
          attempt(check(0)),
          attempt(check('')),
          attempt(check(Symbol())),
          attempt(check({{}})),
          attempt(check([])),
        ].join('|')
        "#
    );
    let r = result(&source);
    let parts: Vec<&str> = r.split('|').collect();
    assert_eq!(parts[0], "[object Compartment]", "no options");
    for (i, label) in ["undefined", "null", "boolean", "number", "string", "symbol"]
        .iter()
        .enumerate()
    {
        assert!(
            parts[i + 1].starts_with("TypeError:"),
            "{label}: {}",
            parts[i + 1]
        );
    }
    assert_eq!(parts[7], "returned [object Compartment]", "object");
    assert_eq!(parts[8], "returned [object Compartment]", "array");
}

/// `constructor/globals-types.js`: presence, not truthiness. `{}` is fine,
/// `{ globals: undefined }` is not.
#[test]
fn the_globals_option_is_read_by_presence() {
    let source = format!(
        r#"{CATCH}
        function check(globals) {{ return function () {{
          return String(new Compartment({{ globals, __options__: true }})); }}; }}
        [
          String(new Compartment({{ __options__: true }})),
          String(new Compartment({{ globals: {{}}, __options__: true }})),
          attempt(check(undefined)),
          attempt(check(null)),
          attempt(check(0)),
          attempt(check(Symbol())),
          attempt(check({{}})),
        ].join('|')
        "#
    );
    let r = result(&source);
    let parts: Vec<&str> = r.split('|').collect();
    assert_eq!(parts[0], "[object Compartment]", "no globals key");
    assert_eq!(parts[1], "[object Compartment]", "empty globals");
    for i in 2..6 {
        assert!(parts[i].starts_with("TypeError:"), "{}", parts[i]);
    }
    assert_eq!(parts[6], "returned [object Compartment]");
}

/// `constructor/globals-properties.js`, reduced to what phase 1 pins: own
/// enumerable string keys are COPIED (one read each), inherited /
/// non-enumerable / symbol keys are never read, and a write inside the
/// compartment does not reach the source object.
#[test]
fn endowments_are_copied_from_own_enumerable_string_keys() {
    assert_eq!(
        result(
            r#"
            var getterCount = 0, setterCount = 0, neverCount = 0;
            var globals = Object.create(
              { get x() { neverCount++; } },
              {
                y: { get: function () { neverCount++; } },
                foo: { enumerable: true, writable: true, value: 0 },
                bar: {
                  enumerable: true,
                  get: function () { getterCount++; return globals.foo; },
                  set: function (it) { setterCount++; globals.foo = it; },
                },
              });
            var c1 = new Compartment({ globals, __options__: true });
            var c2 = new Compartment({ globals, __options__: true });
            c1.evaluate('foo++; bar++; globalThis.which = 1;');
            c2.evaluate('foo++; bar++; globalThis.which = 2;');
            [
              getterCount, setterCount, neverCount,
              globals.foo, globals.bar, String(globals.which),
              c1.globalThis.foo, c1.globalThis.bar, c1.globalThis.which,
              c2.globalThis.foo, c2.globalThis.bar, c2.globalThis.which,
            ].join(',')
            "#
        ),
        "2,0,0,0,0,undefined,1,1,1,1,1,2"
    );
}

/// `evaluate.js`: a compartment's `Compartment` constructs, and the intrinsic
/// graph is SHARED by identity across compartments rather than copied.
#[test]
fn compartments_nest_and_share_one_intrinsic_graph() {
    assert_eq!(
        result(
            r#"
            var parent = new Compartment();
            var child = new parent.globalThis.Compartment();
            [
              parent.evaluate('42'),
              child.evaluate('42'),
              [] instanceof parent.globalThis.Array,
              [] instanceof child.globalThis.Array,
              parent.globalThis.Array === Array,
            ].join(',')
            "#
        ),
        "42,42,true,true,true"
    );
}

#[test]
fn a_name_first_linked_in_a_child_is_still_installed_in_its_parent() {
    assert_eq!(
        result(
            "var child = new Compartment(); \
             child.evaluate('typeof Map.prototype.get') + ',' + \
             eval('typeof Map')"
        ),
        "function,function"
    );
}

#[test]
fn a_transferred_child_keeps_its_compiler_after_its_creator_is_collected() {
    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(|| {
            let machine = Machine::unfrozen_with_start_global_names(None);
            let mut creator = machine.compartment(Default::default());
            let compiler: std::rc::Rc<dyn ironhorse_vm::SourceCompiler> =
                std::rc::Rc::new(TestCompiler);
            let compiler_released = std::rc::Rc::downgrade(&compiler);
            creator.set_source_compiler(compiler);
            assert_eq!(
                compartment_result(
                    &creator,
                    "globalThis.child = new Compartment(); child.evaluate('40 + 2')",
                ),
                "42"
            );

            let child = creator
                .global_value("child")
                .expect("the creator retains the guest child");
            let mut keeper = machine.compartment(Default::default());
            keeper
                .define_global_value("child", &child)
                .expect("the sibling belongs to the same machine");
            assert_eq!(compartment_result(&keeper, "child.evaluate('6 * 7')"), "42");

            drop(child);
            drop(creator);
            machine.collect().expect("the idle machine collects");

            assert_eq!(
                compartment_result(&keeper, "child.evaluate('84 / 2')"),
                "42",
                "compiler authority follows the reachable child environment"
            );

            drop(keeper);
            machine
                .collect()
                .expect("the dead compartment instance is collected");
            machine
                .collect()
                .expect("the now-unowned child environment is collected");
            assert!(
                compiler_released.upgrade().is_none(),
                "the child environment releases its compiler policy"
            );
        })
        .unwrap()
        .join()
        .unwrap();
}

#[test]
fn persistence_borrowed_collection_retires_dead_environment_compilers() {
    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(|| {
            let machine = Machine::unfrozen_with_start_global_names(None);
            let mut creator = machine.compartment(Default::default());
            let compiler: std::rc::Rc<dyn ironhorse_vm::SourceCompiler> =
                std::rc::Rc::new(TestCompiler);
            let compiler_released = std::rc::Rc::downgrade(&compiler);
            creator.set_source_compiler(compiler);
            assert_eq!(
                compartment_result(
                    &creator,
                    "globalThis.child = new Compartment(); child.evaluate('40 + 2')",
                ),
                "42"
            );

            let sweeper = machine.compartment(Default::default());
            assert_eq!(compartment_result(&sweeper, "0"), "0");
            drop(creator);

            machine
                .with_persistence(|interp| interp.collect_garbage())
                .expect("the idle machine lends its interpreter")
                .expect("the first collection succeeds");
            assert!(
                compiler_released.upgrade().is_some(),
                "the child environment is retained through the first collection"
            );
            let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                machine.with_persistence(|interp| {
                    interp
                        .collect_garbage()
                        .expect("the second collection succeeds");
                    std::panic::resume_unwind(Box::new("host callback unwinds after collection"));
                })
            }));
            assert!(unwound.is_err(), "the host callback panic is resumed");
            assert!(
                compiler_released.upgrade().is_none(),
                "retirement follows collection even when with_persistence unwinds"
            );
        })
        .unwrap()
        .join()
        .unwrap();
}

/// `prototype/globalThis/defaults.js`: every global is the outer realm's by
/// identity except the per-compartment evaluators and the value globals.
#[test]
fn a_compartment_global_shares_every_name_but_its_own_evaluators() {
    assert_eq!(
        result(
            r#"
            var c = new Compartment();
            var globals = c.globalThis;
            // Name the evaluators STATICALLY. A compartment's global is
            // populated from the interned symbol table and materializes a name
            // lazily, so `globals['Function']` reads `undefined` when nothing
            // in the crank ever named `Function` -- which is how this check
            // previously "passed" for the evaluators: `undefined` on one side
            // compares unequal, exactly as a per-compartment copy would.
            var pairs = [
              ['Compartment', globals.Compartment, globalThis.Compartment],
              ['Function', globals.Function, globalThis.Function],
              ['eval', globals.eval, globalThis.eval],
            ];
            var wrong = [];
            for (var j = 0; j < pairs.length; j++) {
              var name = pairs[j][0], mine = pairs[j][1], outer = pairs[j][2];
              // Minted per compartment: distinct, and CALLABLE on both sides.
              // Inequality alone is not evidence of a copy -- two `undefined`s
              // would also have satisfied it.
              if (mine === outer) { wrong.push(name + ':shared'); }
              if (typeof mine !== 'function') { wrong.push(name + ':mine-not-callable'); }
              if (typeof outer !== 'function') { wrong.push(name + ':outer-not-callable'); }
            }
            if (globals.globalThis !== globals) { wrong.push('globalThis:not-own'); }
            // `NaN` is checked as a self-inequality, never as an "exception":
            // listing it as one would pass whether or not it were
            // per-compartment, because it compares unequal to itself.
            if (globals.NaN === globals.NaN) { wrong.push('NaN:self-equal'); }
            // Everything else the compartment's global carries is SHARED.
            var names = Object.getOwnPropertyNames(globals);
            var perCompartment = ['Compartment', 'Function', 'eval', 'global', 'globalThis'];
            for (var i = 0; i < names.length; i++) {
              var n = names[i];
              if (n === 'NaN' || perCompartment.indexOf(n) >= 0) { continue; }
              if (globalThis[n] !== globals[n]) { wrong.push(n + ':not-shared'); }
            }
            // Without a floor this reads `ok` on an empty name set.
            [names.indexOf('Object') >= 0, wrong.length === 0 ? 'ok' : wrong.join(',')].join(' ')
            "#
        ),
        "true ok"
    );
}

/// A compartment's global object is its own, and a guest write to it does not
/// reach the outer realm.
#[test]
fn compartment_globals_are_separate_objects() {
    assert_eq!(
        result(
            r#"
            var c = new Compartment();
            c.evaluate('globalThis.mine = 1');
            [c.globalThis === globalThis, c.globalThis.mine, typeof mine].join(',')
            "#
        ),
        "false,1,undefined"
    );
}

/// The prototype members are brand-checked, not duck-typed.
#[test]
fn prototype_members_reject_a_foreign_receiver() {
    let source = format!(
        r#"{CATCH}
        [
          attempt(function () {{ return Compartment.prototype.evaluate.call({{}}, '1'); }}),
          attempt(function () {{
            var d = Object.getOwnPropertyDescriptor(Compartment.prototype, 'globalThis');
            return d.get.call({{}});
          }}),
          attempt(function () {{ return Compartment(); }}),
        ].join('|')
        "#
    );
    for part in result(&source).split('|') {
        assert!(part.starts_with("TypeError:"), "{part}");
    }
}

/// `globalThis` is an accessor on the prototype and nothing on the instance.
#[test]
fn global_this_is_a_prototype_accessor() {
    assert_eq!(
        result(
            r#"
            var d = Object.getOwnPropertyDescriptor(Compartment.prototype, 'globalThis');
            var c = new Compartment();
            [
              typeof d.get, String(d.set), d.enumerable, d.configurable,
              Object.getOwnPropertyNames(c).length,
            ].join(',')
            "#
        ),
        "function,undefined,false,true,0"
    );
}

/// `constructor/globalLexicals-types.js`: the option is type-checked at
/// construction even though phase 1 binds no lexical scope.
#[test]
fn the_global_lexicals_option_is_type_checked() {
    let source = format!(
        r#"{CATCH}
        function check(globalLexicals) {{ return function () {{
          return String(new Compartment({{ globalLexicals }})); }}; }}
        [
          String(new Compartment()),
          String(new Compartment({{}})),
          attempt(check(undefined)),
          attempt(check(null)),
          attempt(check(false)),
          attempt(check(0)),
          attempt(check('')),
          attempt(check(Symbol())),
          attempt(check({{}})),
          attempt(check([])),
        ].join('|')
        "#
    );
    let r = result(&source);
    let parts: Vec<&str> = r.split('|').collect();
    assert_eq!(parts[0], "[object Compartment]");
    assert_eq!(parts[1], "[object Compartment]");
    for i in 2..8 {
        assert!(parts[i].starts_with("TypeError:"), "{}", parts[i]);
    }
    assert_eq!(parts[8], "returned [object Compartment]");
    assert_eq!(parts[9], "returned [object Compartment]");
}

/// `constructor/modules-types.js`: the option is type-checked, and each entry
/// must describe a module. `{}`, `[]` and a key-less `Proxy` are objects and
/// none of them describes one.
#[test]
fn the_modules_option_and_its_entries_are_type_checked() {
    let source = format!(
        r#"{CATCH}
        function check(modules) {{ return function () {{
          return String(new Compartment({{ modules, __options__: true }})); }}; }}
        function checkEntry(value) {{ return function () {{
          return String(new Compartment({{ __options__: true, modules: {{ foo: value }} }})); }}; }}
        [
          String(new Compartment({{ __options__: true, modules: {{}} }})),
          attempt(check(undefined)),
          attempt(check(null)),
          attempt(check(0)),
          attempt(check(Symbol())),
          attempt(check({{}})),
          attempt(checkEntry(null)),
          attempt(checkEntry(0)),
          attempt(checkEntry('')),
          attempt(checkEntry({{}})),
          attempt(checkEntry([])),
          attempt(checkEntry(new Proxy({{}}, {{}}))),
        ].join('|')
        "#
    );
    let r = result(&source);
    let parts: Vec<&str> = r.split('|').collect();
    assert_eq!(parts[0], "[object Compartment]", "empty module map");
    // The REASON, not just the class: a `TypeError` raised by some unrelated
    // mistake in the fixture would satisfy a bare `starts_with("TypeError:")`.
    for i in 1..5 {
        assert_eq!(
            parts[i], "TypeError: new Compartment: modules is not an object",
            "option {i}"
        );
    }
    assert_eq!(parts[5], "returned [object Compartment]", "empty object");
    for (i, reason) in (6..12).zip([
        "module descriptor is not an object",
        "module descriptor is not an object",
        "module descriptor is not an object",
        "unrecognized module descriptor",
        "unrecognized module descriptor",
        "unrecognized module descriptor",
    ]) {
        assert_eq!(
            parts[i],
            format!("TypeError: new Compartment: {reason}"),
            "entry {i}"
        );
    }
}

/// An exception thrown inside a compartment surfaces in the CALLING
/// compartment with its environment intact.
#[test]
fn a_throw_inside_a_compartment_restores_the_calling_environment() {
    assert_eq!(
        result(
            r#"
            var c = new Compartment();
            globalThis.outer = 'outer';
            var caught = '';
            try { c.evaluate('throw new Error("inside")'); }
            catch (e) { caught = e.message; }
            [caught, outer, c.evaluate('typeof outer')].join(',')
            "#
        ),
        "inside,outer,undefined"
    );
}

/// `prototype/evaluate/environments.js`: lexicals are assignable, persist
/// across `evaluate` calls, and are invisible on `globalThis`, while globals
/// are visible there.
#[test]
fn global_lexicals_are_a_scope_between_the_global_and_the_source() {
    assert_eq!(
        result(
            r#"
            var c = new Compartment({
              globals: { foo: 0 },
              globalLexicals: { bar: 0 },
            });
            var first = c.evaluate('bar = foo++');
            var second = c.evaluate('bar = foo++');
            [
              first, second,
              c.globalThis.foo,
              String(c.globalThis.bar),
              c.evaluate('bar'),
              Object.getOwnPropertyNames(c.globalThis).indexOf('bar'),
            ].join(',')
            "#
        ),
        "0,1,2,undefined,1,-1"
    );
}

/// `constructor/globalLexicals-properties.js`: own enumerable string keys
/// only, copied once per compartment, per-compartment and not aliased back to
/// the source, with writability taken from the source descriptor.
#[test]
fn global_lexicals_are_copied_per_compartment_with_their_writability() {
    assert_eq!(
        result(
            r#"
            var getterCount = 0, setterCount = 0, neverCount = 0;
            var globalLexicals = Object.create(
              { get x() { neverCount++; } },
              {
                y: { get: function () { neverCount++; } },
                foo: { enumerable: true, writable: true, value: 0 },
                bar: {
                  enumerable: true,
                  get: function () { getterCount++; return globalLexicals.foo; },
                  set: function (it) { setterCount++; globalLexicals.foo = it; },
                },
                shared: {
                  enumerable: true,
                  value: { foo: 0, get bar() { return this.foo; },
                           set bar(it) { this.foo = it; } },
                },
              });
            var body = `
              foo++;
              bar++;
              shared.foo++;
              shared.bar++;
              (function () {
                try { shared = null; return 'no-throw'; }
                catch (e) { return e.name + ':' + e.message; }
              })()
            `;
            var c1 = new Compartment({ globalLexicals });
            var r1 = c1.evaluate(body);
            var c2 = new Compartment({ globalLexicals });
            var r2 = c2.evaluate(body);
            [
              r1, r2,
              getterCount, setterCount, neverCount,
              globalLexicals.foo, globalLexicals.bar,
              globalLexicals.shared.foo, globalLexicals.shared.bar,
              c1.evaluate('foo'), c1.evaluate('bar'),
              String(c1.globalThis.foo), String(c1.globalThis.bar),
              c2.evaluate('foo'), c2.evaluate('bar'),
            ].join(',')
            "#
        ),
        // `r1`/`r2` are the point of the `shared = null` probe: a
        // non-writable descriptor makes the lexical a `const` binding, and
        // swallowing the throw in a bare `catch` pinned nothing -- every other
        // term reads the same whether the store throws or silently succeeds.
        "TypeError:set shared: const,TypeError:set shared: const,\
2,0,0,0,0,4,4,1,1,undefined,undefined,1,1"
    );
}

/// A `const` lexical rejects a store from the compartment's OWN evaluators
/// too, not just from strict `evaluate` source.
///
/// `Compartment.prototype.evaluate` is always strict, so a strictness-gated
/// const check looked right for as long as `evaluate` was the only way in.
/// `globalThis.eval` and `globalThis.Function` are the compartment's own
/// evaluator copies and run SLOPPY source, and a store to an immutable binding
/// throws however strict the assigning code is (ECMA-262 9.1.1.1.5
/// `SetMutableBinding` forces `S` to true -- the same reason `const c = 1;
/// c = 2` throws in sloppy code).
#[test]
fn a_const_lexical_rejects_a_sloppy_store() {
    assert_eq!(
        result(
            r#"
            var gl = {};
            Object.defineProperty(gl, 'k', { enumerable: true, value: 1 });
            var c = new Compartment({ globalLexicals: gl });
            function attempt(f) {
              try { return 'returned ' + String(f()); }
              catch (e) { return e.name + ': ' + e.message; }
            }
            [
              attempt(function () { return c.globalThis.Function('k = 9; return k')(); }),
              attempt(function () { return c.globalThis.eval('k = 9; k'); }),
              attempt(function () { return c.evaluate('k = 9; k'); }),
              String(c.evaluate('k')),
            ].join(' | ')
            "#
        ),
        "TypeError: set k: const | TypeError: set k: const | \
TypeError: set k: const | 1"
    );
}

/// A lexical shadows a global of the same name, and the write reaches the
/// lexical rather than creating or overwriting the global.
#[test]
fn a_lexical_shadows_a_global_of_the_same_name() {
    assert_eq!(
        result(
            r#"
            var c = new Compartment({
              globals: { x: 'global' },
              globalLexicals: { x: 'lexical' },
            });
            var before = c.evaluate('x');
            c.evaluate('x = "written"');
            [before, c.evaluate('x'), c.globalThis.x].join(',')
            "#
        ),
        "lexical,written,global"
    );
}

/// `fx_lockdown` step 2's fifth call: `Compartment.prototype.constructor`
/// becomes the inert stand-in, like the function family's and `Date`'s.
///
/// The stand-in is anonymous and takes its `length` from the constructor it
/// replaces, which is 1 for `Compartment`. Reaching it is `secure mode`, not a
/// second compartment.
#[test]
fn lockdown_poisons_the_compartment_constructor() {
    let source = format!(
        r#"{CATCH}
        var before = Compartment.prototype.constructor === Compartment;
        lockdown();
        var inert = Compartment.prototype.constructor;
        [
          before,
          inert === Compartment,
          inert.name,
          inert.length,
          attempt(function () {{ return new inert(); }}),
          // The real constructor is still reachable by NAME, as XS leaves it:
          // step 2 rewires the prototype's `constructor`, it does not unbind
          // the global.
          String(new Compartment().evaluate('1+1')),
        ].join('|')
        "#
    );
    assert_eq!(
        result(&source),
        "true|false||1|TypeError: secure mode|2",
        "lockdown() must replace Compartment.prototype.constructor with the \
         inert stand-in, leaving the global constructor working"
    );
}

/// A `globalLexicals` cell outlives the `Compartment` INSTANCE that
/// introduced it, for as long as the compartment's global object is alive.
///
/// The cell is deliberately off the global object's property chain -- that is
/// what keeps the name invisible on `globalThis` -- so, alone among
/// environment state, nothing reaches it through an ordinary arena edge. Its
/// only root was the `environments` root walk, which filters on the
/// environment's owner lease, and that lease belongs to the INSTANCE. A
/// retained function keeps `global_env`, and hence the environment, alive long
/// after its instance is swept: two collections later the cell was freed while
/// `global_lexicals` still named it, and the next crank's allocations recycled
/// the slot. Read back through the retained function this answered the new
/// occupant's value rather than the binding's, in a debug build with nothing
/// tripped -- the slot had been reallocated and was live again.
#[test]
fn a_lexical_outlives_the_compartment_instance() {
    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(|| {
            // The instance is never stored: only the function it evaluated
            // escapes, and that function is what pins the compartment's global.
            let crank1 = "var f = 0; var churn = 0; churn = []; \
                 f = new Compartment({ globalLexicals: { secret: 42 } })\
                 .evaluate('(function () { return secret; })'); 0;";
            let crank2 = "var f; var churn; var zz = 0; var t = 0; \
                 for (zz = 0; zz < 64; zz++) { churn[zz % 8] = { a: zz, b: 'x' + zz }; } \
                 t = f(); t";
            let (c1, s1) = ironhorse_compile::compile_atoms(crank1).unwrap();
            let (c2, s2) = ironhorse_compile::compile_atoms(crank2).unwrap();
            let mut m = Interp::new();
            m.set_source_compiler(std::rc::Rc::new(TestCompiler));
            m.link_intrinsics(&parse_symbols(&s1));
            assert!(m.run(&c1).completed);
            // The first collection sweeps the instance and prunes its row,
            // dropping the environment's owner lease; the second is the one
            // that used to sweep the cell.
            m.collect_garbage().unwrap();
            m.collect_garbage().unwrap();
            let c2 = m.relink_crank(&c2, &parse_symbols(&s2)).expect("relink");
            let out = m.run(&c2);
            assert!(out.completed, "{:?}", out.halt);
            assert_eq!(out.result, "42");
        })
        .unwrap()
        .join()
        .unwrap()
}

/// A bare-name `delete` inside a compartment resolves against the
/// compartment's own global, and cannot remove a `globalLexicals` binding.
///
/// `EVAL_REFERENCE` pushes a `Kind::EnvReference` sentinel carrying
/// `SlotIndex(0)` to mean "the global object", and `DELETE_PROPERTY` matched on
/// the payload without checking the kind -- taking the sentinel for a live
/// instance. `SlotIndex(0)` is the DEFAULT realm's global only because
/// `Interp::new` happens to allocate it first, so a `delete` evaluated in a
/// compartment reached into the parent realm and deleted there. The sentinel
/// and the delete path both predate the guest constructor; compartments are
/// what made the defect reachable, since until then only the host could mint a
/// second environment.
#[test]
fn a_bare_delete_in_a_compartment_stays_in_that_compartment() {
    assert_eq!(
        result(
            r#"
            globalThis.leak = 1;
            var c = new Compartment({ globalLexicals: { bar: 1 } });
            c.globalThis.own = 2;
            var deletedLexical = c.globalThis.eval('delete bar');
            var deletedOwn = c.globalThis.eval('delete own');
            c.globalThis.eval('delete leak');
            [
              String(globalThis.leak),
              String(deletedLexical), String(c.evaluate('bar')),
              String(deletedOwn), String(c.globalThis.own),
            ].join(',')
            "#
        ),
        // The parent's `leak` survives; `delete` of a lexical answers `false`
        // (a binding in a scope is not a property, and `delete` must not claim
        // to have removed one); the compartment's own global property goes.
        "1,false,1,true,undefined"
    );
}
