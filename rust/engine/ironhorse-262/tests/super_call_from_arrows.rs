//! `super(...)` inside an arrow function in a derived constructor: the pinned
//! XS oracle's answer.
//!
//! An arrow has no [[Construct]] and no class of its own. XS's `SUPER` takes
//! the class from the arrow's home object (its `constructor`), and every
//! frame of the constructor shares one `this` cell, so a `super()` the arrow
//! runs binds the constructor's `this` and every other arrow's. Ironhorse
//! read the parent from the arrow itself and threw "super: not a
//! constructor".

use ironhorse_262::dual_run;

/// The program completes with the XS oracle's value.
fn agrees(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert!(
        run.observables_agree(),
        "disagrees: {source}\n  oracle_result={} ironhorse_result={}\n  ironhorse_halt={:?}",
        run.oracle_result,
        run.ironhorse_result,
        run.ironhorse_halt,
    );
}

#[test]
fn an_arrow_constructs_the_parent_with_the_constructors_new_target() {
    agrees(
        "class B { constructor() { this.x = 1; } } \
         class D extends B { constructor() { (() => super())(); } } \
         var d = new D(); [d.x, d instanceof D].join()",
    );
    agrees(
        "class D extends Map { constructor() { (() => super())(); } } \
         var d = new D(); [d instanceof D, d.size].join()",
    );
    agrees(
        "class B { constructor() { this.nt = new.target; } } \
         class D extends B { constructor() { var f = () => super(new Map()); f(); } } \
         var d = new D(); [d.nt === D, d instanceof D].join()",
    );
    agrees(
        "class B { constructor(a) { this.a = a; } } \
         class D extends B { constructor() { var f = (...r) => super(...r); f(5); } } new D().a",
    );
}

#[test]
fn every_way_an_arrow_is_reached_binds_the_constructors_this() {
    // Nested arrows, a callback, an arrow in an object literal, a default
    // parameter, and an arrow made before `super()` reading `this` after it.
    for constructor in [
        "(() => { (() => super())(); })();",
        "[1].forEach(() => super());",
        "var o = { m: () => super() }; o.m();",
        "((a = super()) => a)();",
        "var g = () => this; var f = () => super(); f(); this.same = g() === this;",
        "var g = () => this; [1].forEach(() => super()); this.same = g() === this;",
    ] {
        agrees(&format!(
            "class B {{ constructor() {{ this.x = 2; }} }} \
             class D extends B {{ constructor() {{ {constructor} }} }} \
             var d = new D(); [d.x, d.same, d instanceof D].join()"
        ));
    }
}

#[test]
fn this_is_bound_once_however_super_is_reached() {
    agrees(
        "class B { constructor() { this.x = 1; } } \
         class D extends B { constructor() { var f = () => super(); f(); \
           try { f(); } catch (e) { this.e = e.constructor.name; } } } new D().e",
    );
    agrees(
        "class B {} class D extends B { constructor() { var f = () => super(); super(); \
           try { f(); } catch (e) { return { m: e.message }; } } } new D().m",
    );
    // `this` before any `super()`, and a constructor that never calls one.
    agrees(
        "class B {} class D extends B { constructor() { var f = () => super(); \
           try { this; } catch (e) { this.never = 1; } } } \
         try { new D(); 'constructed' } catch (e) { e.constructor.name }",
    );
    agrees(
        "class B {} class D extends B { constructor() { this.f = () => super(); return; } } \
         try { new D(); 'constructed' } catch (e) { e.constructor.name }",
    );
}

#[test]
fn the_class_comes_from_the_home_objects_constructor() {
    // XS reads the arrow's home object's own `constructor`; replaced by a
    // function whose [[Prototype]] is no constructor, the call throws.
    agrees(
        "class B {} class D extends B { constructor() { var f = () => super(); \
           Object.defineProperty(D.prototype, 'constructor', { value: Object }); f(); } } \
         try { new D() instanceof D } catch (e) { e.constructor.name + ': ' + e.message }",
    );
}

#[test]
fn an_async_arrow_keeps_the_constructors_new_target() {
    agrees(
        "class B {} class D extends B { constructor() { var f = async () => super(); f(); \
           this.t = typeof this; } } try { new D().t } catch (e) { e.constructor.name }",
    );
}
