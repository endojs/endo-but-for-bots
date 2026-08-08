//! Class execution regressions, dual-run against the pinned XS oracle.

use ironhorse_262::{dual_run, Agreement};

fn assert_result_agrees(source: &str) {
    let dr = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        dr.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (ironhorse halt: {:?}; oracle={:?} ironhorse={:?})",
        dr.ironhorse_halt,
        dr.oracle_result,
        dr.ironhorse_result,
    );
    assert!(
        dr.result_agrees,
        "`{source}` result divergence: oracle={:?} ironhorse={:?}",
        dr.oracle_result, dr.ironhorse_result,
    );
}

#[test]
fn base_class_construction_and_methods() {
    assert_result_agrees("class A { constructor(v) { this.v = v } } new A(42).v");
    assert_result_agrees("class A { m() { return 7 } } new A().m()");
    assert_result_agrees("class A {} (new A()) instanceof A");
    assert_result_agrees("class A {} A.prototype.constructor === A");
}

#[test]
fn derived_construction_and_super_properties() {
    assert_result_agrees(
        "class A { constructor(v) { this.v = v } } class B extends A { constructor(v) { super(v + 1) } } new B(40).v",
    );
    assert_result_agrees("class A { m() { return 1 } } class B extends A { m() { return 2 } } B.prototype.hasOwnProperty('m')");
    assert_result_agrees("class A { m() { return 1 } } class B extends A { constructor() { super() } m() { return 2 } } new B().m()");
    assert_result_agrees(
        "class A { constructor(v) { this.v = v } m() { return this.v } } class B extends A { constructor(v) { super(v + 1) } m() { return super.m() + 1 } } new B(40).m()",
    );
    assert_result_agrees("class A {} class B extends A {} new B() instanceof A");
    assert_result_agrees(
        "class A { get x() { return this.v } set x(v) { this.v = v } } class B extends A { constructor() { super(); this.v = 3 } get() { return super['x'] } set(v) { super['x'] = v } } let b = new B(); b.set(5); b.get()",
    );
    assert_result_agrees(
        "class A { get x() { return this.v } set x(v) { this.v = v } } class B extends A { constructor() { super(); this.v = 3 } set(v) { super.x = v } } let b = new B(); b.set(7); b.v",
    );
}

#[test]
fn class_and_derived_constructor_errors_are_catchable() {
    assert_result_agrees(
        "class A {} let caught = false; try { A() } catch (e) { caught = e instanceof TypeError } caught",
    );
    assert_result_agrees(
        "class A {} class B extends A {} let caught = false; try { B() } catch (e) { caught = e instanceof TypeError } caught",
    );
    assert_result_agrees(
        "class A {} class B extends A { constructor() { this.x = 1 } } let caught = false; try { new B() } catch (e) { caught = e instanceof ReferenceError } caught",
    );
    assert_result_agrees(
        "class A {} class B extends A { constructor() {} } let caught = false; try { new B() } catch (e) { caught = e instanceof ReferenceError } caught",
    );
    assert_result_agrees(
        "class A {} class B extends A { constructor() { return 1 } } let caught = false; try { new B() } catch (e) { caught = e instanceof TypeError } caught",
    );
    assert_result_agrees(
        "class A {} class B extends A { constructor() { return { x: 9 } } } new B().x",
    );
}

#[test]
fn public_field_and_static_initialization() {
    assert_result_agrees("class A { x = 1; y = this.x + 1 } new A().y");
    assert_result_agrees("class A { static x = 1; static { this.x += 2 } } A.x");
    assert_result_agrees(
        "let seen; class A { get ['x']() { return 1 } set ['x'](v) { seen = v } } let a = new A(); let first = a.x; a.x = 2; first + seen",
    );
}

#[test]
fn private_elements_use_lexical_brand_identity() {
    let generator_private = "class C { *m() { return 42; } #m = 'test262'; method() { return this.#m; } } var c = new C();";
    assert_result_agrees(&format!("{generator_private} c.m().next().value"));
    assert_result_agrees(&format!("{generator_private} c.method()"));
    assert_result_agrees(&format!("{generator_private} c.m === C.prototype.m"));
    assert_result_agrees(&format!(
        "{generator_private} Object.prototype.hasOwnProperty.call(c, 'm')"
    ));
    assert_result_agrees(&format!(
        "{generator_private} Object.getOwnPropertyDescriptor(C.prototype, 'm').enumerable"
    ));
    assert_result_agrees(
        "class A { #x = 1; get() { return this.#x } set(v) { this.#x = v } } let a = new A(); a.set(9); a.get()",
    );
    assert_result_agrees(
        "class A { #m() { return 4 } call() { return this.#m() } } new A().call()",
    );
    assert_result_agrees(
        "class A { m() { return 4 } } class B extends A { #m() { return super.m() } call() { return this.#m() } } new B().call()",
    );
    assert_result_agrees(
        "class A { #x = 1; has(o) { return #x in o } } let a = new A(); a.has(a) && !a.has({})",
    );
    assert_result_agrees("class A { static #x = 3; static get() { return this.#x } } A.get()");
}
