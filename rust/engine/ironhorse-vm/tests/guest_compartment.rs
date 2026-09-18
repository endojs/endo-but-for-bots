//! The guest `Compartment` (`Native::Compartment`, `fx_Compartment` in
//! `c/moddable/xs/sources/xsModule.c`), scoped in
//! `designs/ironhorse-guest-compartment.md`.
//!
//! Phase 1 is the non-module surface. The module half — `import`, `importNow`,
//! and real `resolveHook`/`importHook` callables — is phase 2 and is gated on
//! threading a referrer through `ModuleGraph::resolve`.
mod common;
use common::TestCompiler;

use ironhorse_vm::{parse_symbols, Interp};

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

/// `prototype/globalThis/defaults.js`: every global is the outer realm's by
/// identity except the per-compartment evaluators and the value globals.
#[test]
fn a_compartment_global_shares_every_name_but_its_own_evaluators() {
    assert_eq!(
        result(
            r#"
            var c = new Compartment();
            var globals = c.globalThis;
            var exceptions = ['Compartment','Function','NaN','eval','global','globalThis'];
            var wrong = [];
            var names = Object.getOwnPropertyNames(globals);
            for (var i = 0; i < names.length; i++) {
              var name = names[i];
              var same = globalThis[name] === globals[name];
              var expected = exceptions.indexOf(name) >= 0 ? false : true;
              if (same !== expected) { wrong.push(name); }
            }
            wrong.length === 0 ? 'ok' : wrong.join(',')
            "#
        ),
        "ok"
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
    for i in 1..5 {
        assert!(parts[i].starts_with("TypeError:"), "option: {}", parts[i]);
    }
    assert_eq!(parts[5], "returned [object Compartment]", "empty object");
    for i in 6..12 {
        assert!(parts[i].starts_with("TypeError:"), "entry: {}", parts[i]);
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
