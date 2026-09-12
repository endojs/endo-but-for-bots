//! F144: the intrinsic-global attenuation permit.
//!
//! A realm's host can restrict which intrinsic **globals** a program may name,
//! so an embedder hosting untrusted code can express "this realm binds no
//! `eval`, no `Function`, no `Intl`". The permit is an allow-list consulted at
//! the intrinsic-binding arms; the primitive value globals and the
//! `globalThis` self-binding are scaffolding and remain.
//!
//! Scope, stated so a reader does not over-trust the name: this is a
//! global-binding permit, not a confinement boundary. Prototype behavior is
//! unchanged, so a denied constructor can still be reached through a
//! prototype's `.constructor` (for example `function(){}.constructor`).
//! Removing that access needs a shared frozen intrinsic graph and is the
//! realm-split work F059 records, not this permit.

use ironhorse_vm::{CompartmentOptions, CompartmentSkip, Machine};

/// A second compiler used to pin `evaluate_with_symbols_on`'s precedence: the
/// caller's compiler must win over the machine's. It rewrites `6*7` to `43`,
/// so the completion distinguishes the two.
struct CallerCompiler;

impl ironhorse_vm::SourceCompiler for CallerCompiler {
    fn compile_source(
        &self,
        source: &str,
        strict: bool,
        _raw_budget: u64,
        _charge: &mut dyn FnMut(u64) -> bool,
    ) -> Result<ironhorse_vm::CompiledSource, ironhorse_vm::SourceCompileError> {
        let rewritten = if source == "6*7" { "43" } else { source };
        let (bytecode, symbols) = ironhorse_compile::compile_atoms_with(rewritten, strict)
            .map_err(|e| ironhorse_vm::SourceCompileError::Syntax(e.message))?;
        Ok(ironhorse_vm::CompiledSource {
            bytecode,
            symbols,
            parse_meter_raw: 0,
            parse_computrons: 0,
        })
    }
}

/// A minimal evaluative source compiler for the boundary test: enough to show
/// that a denied constructor reached through `.constructor` can still compile
/// and run.
struct TestCompiler;

impl ironhorse_vm::SourceCompiler for TestCompiler {
    fn compile_source(
        &self,
        source: &str,
        strict: bool,
        _raw_budget: u64,
        _charge: &mut dyn FnMut(u64) -> bool,
    ) -> Result<ironhorse_vm::CompiledSource, ironhorse_vm::SourceCompileError> {
        let (bytecode, symbols) = ironhorse_compile::compile_atoms_with(source, strict)
            .map_err(|e| ironhorse_vm::SourceCompileError::Syntax(e.message))?;
        Ok(ironhorse_vm::CompiledSource {
            bytecode,
            symbols,
            parse_meter_raw: 0,
            parse_computrons: 0,
        })
    }
}

/// A program whose completion names the resolution of four intrinsic globals
/// plus the realm scaffolding. It is compiled once per test, not per realm.
const PROBE: &str = "typeof eval + ',' + typeof Function + ',' + typeof Object + ',' \
                     + typeof Array + ',' + typeof globalThis";

fn run(permit: Option<Vec<&str>>) -> String {
    let (code, symbols) = ironhorse_compile::compile_atoms(PROBE).expect("compiles");
    let machine = Machine::new();
    let options = CompartmentOptions {
        intrinsic_permit: permit.map(|names| names.into_iter().map(str::to_string).collect()),
        ..Default::default()
    };
    let outcome = machine
        .compartment(options)
        .evaluate_with_symbols(&code, &symbols);
    assert!(outcome.completed, "{:?}", outcome.halt);
    outcome.result
}

#[test]
fn full_realm_binds_every_named_intrinsic() {
    // `globalThis` is an object; the four intrinsics are callables.
    assert_eq!(run(None), "function,function,function,function,object");
}

#[test]
fn empty_permit_denies_every_intrinsic_global_but_keeps_scaffolding() {
    // No intrinsic global resolves, so `typeof` of each is "undefined"; the
    // realm's own `globalThis` still exists.
    assert_eq!(
        run(Some(vec![])),
        "undefined,undefined,undefined,undefined,object"
    );
}

#[test]
fn allow_list_admits_only_named_intrinsics() {
    assert_eq!(
        run(Some(vec!["Object", "Array"])),
        "undefined,undefined,function,function,object"
    );
}

#[test]
fn permit_is_part_of_the_template_cache_key() {
    // The machine caches one pristine template per exact symbol table; the
    // permit must be part of that key, or the second realm would inherit the
    // first realm's bindings. Evaluate full, restricted, then full again.
    let (code, symbols) = ironhorse_compile::compile_atoms(PROBE).expect("compiles");
    let machine = Machine::new();

    let full = machine.new_compartment();
    let restricted = machine.compartment(CompartmentOptions {
        intrinsic_permit: Some(vec![]),
        ..Default::default()
    });

    let first = full.evaluate_with_symbols(&code, &symbols);
    assert!(first.completed, "{:?}", first.halt);
    assert_eq!(first.result, "function,function,function,function,object");

    let denied = restricted.evaluate_with_symbols(&code, &symbols);
    assert!(denied.completed, "{:?}", denied.halt);
    assert_eq!(
        denied.result,
        "undefined,undefined,undefined,undefined,object"
    );

    let again = full.evaluate_with_symbols(&code, &symbols);
    assert!(again.completed, "{:?}", again.halt);
    assert_eq!(
        again.result, "function,function,function,function,object",
        "the full realm must not inherit a cached restricted template"
    );
}

#[test]
fn runtime_interned_keys_cannot_materialize_a_denied_global() {
    // A bracket expression carries a runtime string, not a symbol id. The
    // `this['Object']` clause is the discriminating one: `Object` never enters
    // the program symbol table, so it exercises the runtime materialization
    // path, while the bare `typeof eval` clause exercises the link-time arm.
    let (code, symbols) = ironhorse_compile::compile_atoms(
        "typeof eval + ',' + typeof this['eval'] + ',' + typeof this['Object']",
    )
    .expect("compiles");
    let machine = Machine::new();
    let restricted = machine.compartment(CompartmentOptions {
        intrinsic_permit: Some(vec![]),
        ..Default::default()
    });
    let outcome = restricted.evaluate_with_symbols(&code, &symbols);
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert_eq!(outcome.result, "undefined,undefined,undefined");
}

#[test]
fn nested_compartments_inherit_the_parent_permit() {
    let (code, symbols) = ironhorse_compile::compile_atoms(PROBE).expect("compiles");
    let machine = Machine::new();
    let parent = machine.compartment(CompartmentOptions {
        intrinsic_permit: Some(vec![]),
        ..Default::default()
    });
    assert_eq!(parent.intrinsic_permit(), Some([].as_slice()));
    let child = parent.new_compartment();
    // Attenuation is not widened by nesting.
    assert_eq!(child.intrinsic_permit(), Some([].as_slice()));
    let outcome = child.evaluate_with_symbols(&code, &symbols);
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert_eq!(
        outcome.result,
        "undefined,undefined,undefined,undefined,object"
    );
}

#[test]
fn evaluate_on_resolves_permit_precedence_both_ways() {
    use ironhorse_vm::Interp;
    let (code, symbols) = ironhorse_compile::compile_atoms(PROBE).expect("compiles");
    let machine = Machine::new();
    let expected_restricted = "undefined,undefined,undefined,undefined,object";

    // A compartment WITHOUT a permit must not silently widen an interpreter
    // the caller already armed.
    let open = machine.new_compartment();
    let mut armed = Interp::new();
    armed.set_intrinsic_permit(Some(&[]));
    let preserved = open.evaluate_with_symbols_on(armed, &code, &symbols);
    assert!(preserved.completed, "{:?}", preserved.halt);
    assert_eq!(preserved.result, expected_restricted);

    // A compartment WITH a permit overrides a caller's unrestricted
    // interpreter: attenuation is the compartment's policy.
    let restricted = machine.compartment(CompartmentOptions {
        intrinsic_permit: Some(vec![]),
        ..Default::default()
    });
    let plain = Interp::new();
    let overridden = restricted.evaluate_with_symbols_on(plain, &code, &symbols);
    assert!(overridden.completed, "{:?}", overridden.halt);
    assert_eq!(overridden.result, expected_restricted);
}

#[test]
fn evaluate_on_preserves_a_callers_compiler() {
    // The machine installs a compiler, but the caller's interpreter already
    // carries one; the caller's explicit choice must win, or a host that
    // supplies its own compiler through this entry point is silently ignored.
    use ironhorse_vm::Interp;
    let (code, symbols) = ironhorse_compile::compile_atoms("eval('6*7')").expect("compiles");
    let machine = Machine::new();
    machine.set_source_compiler(std::rc::Rc::new(TestCompiler));
    let compartment = machine.new_compartment();
    let mut caller = Interp::new();
    caller.set_source_compiler(std::rc::Rc::new(CallerCompiler));
    let outcome = compartment.evaluate_with_symbols_on(caller, &code, &symbols);
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert_eq!(
        outcome.result, "43",
        "the caller-installed compiler must take precedence over the machine's"
    );
}

#[test]
fn permit_is_a_global_binding_policy_not_confinement() {
    // Documented boundary: prototype behavior is unchanged, so a denied
    // constructor remains reachable through `.constructor`, and with a source
    // compiler installed it still compiles and runs guest code. Confinement is
    // the shared-frozen-intrinsics realm split (F059), not this permit; this
    // test pins the current contract so a reader does not mistake it for a
    // membrane.
    let (code, symbols) = ironhorse_compile::compile_atoms(
        "typeof (function(){}).constructor + ',' + (function(){}).constructor('return 42')()",
    )
    .expect("compiles");
    let machine = Machine::new();
    machine.set_source_compiler(std::rc::Rc::new(TestCompiler));
    let restricted = machine.compartment(CompartmentOptions {
        intrinsic_permit: Some(vec![]),
        ..Default::default()
    });
    let outcome = restricted.evaluate_with_symbols(&code, &symbols);
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert_eq!(outcome.result, "function,42");
}

#[test]
fn continuing_meter_path_honors_the_permit() {
    // The production daemon evaluator reaches this entry point; mutating its
    // permit argument to `None` must not leave the suite green.
    let (code, symbols) = ironhorse_compile::compile_atoms(PROBE).expect("compiles");
    let machine = Machine::new();
    let restricted = machine.compartment(CompartmentOptions {
        intrinsic_permit: Some(vec![]),
        ..Default::default()
    });
    let outcome = restricted.evaluate_with_symbols_continuing_meter_shared(
        code.into(),
        &symbols,
        ironhorse_vm::Meter::new(),
        None,
    );
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert_eq!(
        outcome.result,
        "undefined,undefined,undefined,undefined,object"
    );
}

#[test]
fn a_permit_on_an_already_linked_interpreter_is_refused() {
    // An interpreter linked under a wider policy cannot be un-bound
    // create-only, so applying a narrower permit after linking must fail
    // closed rather than silently no-op.
    use ironhorse_vm::{parse_symbols, Interp};
    let (code, symbols) = ironhorse_compile::compile_atoms(PROBE).expect("compiles");
    let names = parse_symbols(&symbols);
    let mut prelinked = Interp::new();
    prelinked.link_intrinsics(&names);
    assert!(prelinked.intrinsics_linked());

    let machine = Machine::new();
    let restricted = machine.compartment(CompartmentOptions {
        intrinsic_permit: Some(vec![]),
        ..Default::default()
    });
    let outcome = restricted.evaluate_with_symbols_on(prelinked, &code, &symbols);
    assert!(!outcome.completed);
    assert_eq!(
        outcome.halt,
        ironhorse_vm::Halt::NotImplemented("compartment:permit-after-link")
    );
    assert_eq!(
        CompartmentSkip::PermitAfterLink.name(),
        "compartment:permit-after-link"
    );

    // A fresh, unlinked interpreter still accepts the compartment's permit.
    let fresh = Interp::new();
    let outcome = restricted.evaluate_with_symbols_on(fresh, &code, &symbols);
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert_eq!(
        outcome.result,
        "undefined,undefined,undefined,undefined,object"
    );
}

#[test]
fn empty_permit_denies_the_test262_host_object() {
    // The conformance harness installs `$262` explicitly; a production realm
    // never carries it, and a restricted realm must not expose it either.
    use ironhorse_vm::{parse_symbols, Interp};
    let (code, symbols) = ironhorse_compile::compile_atoms("typeof $262").expect("compiles");
    let names = parse_symbols(&symbols);

    let mut full = Interp::new();
    full.install_test262_host();
    full.link_intrinsics(&names);
    let full_outcome = full.run(&code);
    assert!(full_outcome.completed, "{:?}", full_outcome.halt);
    assert_eq!(full_outcome.result, "object");

    let mut restricted = Interp::new();
    restricted.install_test262_host();
    restricted.set_intrinsic_permit(Some(&[]));
    restricted.link_intrinsics(&names);
    let restricted_outcome = restricted.run(&code);
    assert!(
        restricted_outcome.completed,
        "{:?}",
        restricted_outcome.halt
    );
    assert_eq!(restricted_outcome.result, "undefined");
}
