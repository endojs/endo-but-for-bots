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

/// PrivateFieldAdd and PrivateMethodOrAccessorAdd throw a TypeError when the
/// object already has the element. Ironhorse overwrote it, so a base
/// constructor that returns an existing object let a second `new` reset that
/// object's private state.
#[test]
fn private_elements_cannot_be_added_twice() {
    let returner = "class B { constructor(o) { return o; } }";
    for elements in [
        "#f = ++n;",
        "#f;",
        "#m() {}",
        "get #a() { return n; }",
        "set #a(v) {}",
        "get #a() { return n; } set #a(v) {}",
        "static x = 1; #f = ++n; #m() {}",
    ] {
        assert_result_agrees(&format!(
            "var n = 0; {returner} class C extends B {{ {elements} constructor(o) {{ super(o); }} \
             static has(o) {{ return {has}; }} }} \
             var o = {{}}; new C(o); var r; try {{ new C(o); r = 'none'; }} catch (e) {{ r = String(e); }} \
             [n, r, C.has(o)].join()",
            // XS answers `#a in o` false for a setter-only accessor, which
            // `xs_departures.rs` records; the getter forms avoid it here.
            has = if elements.contains("#f") {
                "#f in o"
            } else if elements.contains("#m") {
                "#m in o"
            } else if elements.contains("get #a") {
                "#a in o"
            } else {
                "'skipped'"
            },
        ));
    }
    // Two classes may each add their own element of the same spelling.
    assert_result_agrees(&format!(
        "{returner} class C extends B {{ #f = 1; static get(o) {{ return o.#f; }} }} \
         class D extends B {{ #f = 2; static get(o) {{ return o.#f; }} }} \
         var o = {{}}; new C(o); new D(o); [C.get(o), D.get(o)].join()"
    ));
}

/// The integrity case: an unhardened class with private state, reached
/// through a returning base constructor installed after the fact.
#[test]
fn a_purse_balance_cannot_be_reset_through_a_returning_constructor() {
    assert_result_agrees(
        "class Base {} \
         class Purse extends Base { #balance = 0; deposit(v) { this.#balance += v; } get balance() { return this.#balance; } } \
         var p = new Purse(); p.deposit(10); \
         Object.setPrototypeOf(Purse, function (o) { return o; }); \
         var r; try { new Purse(p); r = 'reset'; } catch (e) { r = e.constructor.name; } \
         [r, p.balance].join()",
    );
}

/// PrivateSet throws on a method, and PrivateGet on an accessor without a
/// getter, through every assignment form.
#[test]
fn private_methods_are_read_only_and_setter_only_accessors_unreadable() {
    for target in ["this.#m", "C.#s"] {
        for write in [
            "T = 5",
            "T += 1",
            "T &&= 1",
            "T ||= 1",
            "T ??= 1",
            "T++",
            "--T",
            "[T] = [1]",
            "({ a: T } = { a: 1 })",
            "for (T of [1]);",
            "for (T in { a: 1 });",
            "eval('T = 1')",
        ] {
            let write = write.replace('T', target);
            assert_result_agrees(&format!(
                "class C {{ #m() {{ return 1; }} static #s() {{ return 2; }} \
                 t() {{ var r; try {{ {write}; r = 'wrote'; }} catch (e) {{ r = String(e); }} \
                 return [r, typeof this.#m, typeof C.#s].join(); }} }} new C().t()"
            ));
        }
    }
    for read in [
        "this.#s",
        "this.#s + 1",
        "this.#s++",
        "this.#s += 1",
        "[this.#s] = [1]",
        "this.#s ??= 1",
    ] {
        assert_result_agrees(&format!(
            "var log = []; class C {{ set #s(v) {{ log.push(v); }} \
             t() {{ var r; try {{ r = String({read}); }} catch (e) {{ r = String(e); }} return [r, log.join()].join(' '); }} }} \
             new C().t()"
        ));
    }
}
