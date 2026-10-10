//! XS fxRunDebugID diagnostics at strict stores and deletion boundaries.
use ironhorse_262::{dual_run, Agreement};

#[test]
fn strict_assignment_and_delete_messages() {
    for (body, expected) in [
        ("var o=Object.freeze({x:1});o.x=2", "set x: not writable"),
        (
            "var o=Object.preventExtensions({});o.x=2",
            "set x: not extensible",
        ),
        ("var o={get x(){return 1}};o.x=2", "set x: no setter"),
        (
            "var o=Object.create(Object.freeze({x:1}));o.x=2",
            "set x: not writable",
        ),
        (
            "var o=Object.create({get x(){return 1}});o.x=2",
            "set x: no setter",
        ),
        ("var o=Symbol();o.x=2", "set x: not extensible"),
        (
            "var a=Object.freeze([]);a.length=0",
            "set length: not writable",
        ),
        (
            "var o=Object.freeze({x:1});delete o.x",
            "delete x: no permission (strict mode)",
        ),
        (
            "var o=Object.freeze({x:1});var k='x';delete o[k]",
            "delete x: no permission (strict mode)",
        ),
        (
            "var o=Object.freeze([1]);delete o[0]",
            "delete ?: no permission (strict mode)",
        ),
        ("NaN=1", "set NaN: not writable"),
        ("const x=1;eval('x=2')", "set x: const"),
    ] {
        let expression = format!("(function(){{'use strict';{body}}})()");
        let expected = format!("TypeError: {expected}");
        let run = dual_run(&expression).expect("oracle starts");
        assert_eq!(run.agreement, Agreement::BothAbort, "{expression}: {run:?}");
        assert_eq!(run.oracle_error, expected, "XS: {expression}");
        assert_eq!(run.ironhorse_error, expected, "IH: {expression}");
        let caught = format!("try {{ {expression}; 'no throw' }} catch(e) {{ String(e) }}");
        let run = dual_run(&caught).expect("oracle starts");
        assert_eq!(
            run.agreement,
            Agreement::BothComplete,
            "{expression}: {run:?}"
        );
        assert_eq!(run.oracle_result, expected, "XS caught: {expression}");
        assert_eq!(run.ironhorse_result, expected, "IH caught: {expression}");
    }
}

#[test]
fn private_and_class_opcode_messages() {
    for (expression, expected) in [
        (
            "class C { #x; static f(o){return o.#x} }; C.f({})",
            "get #x: undefined private property",
        ),
        (
            "class C { #x; static f(o){return o.#x} }; C.f(1)",
            "get #x: undefined private property",
        ),
        (
            "class C { #x; static f(o){return o.#x} }; C.f(null)",
            "cannot coerce null to object",
        ),
        (
            "class C { #x; static f(o){o.#x=1} }; C.f({})",
            "set #x: undefined private property",
        ),
        (
            "class C { get #x(){return 1}; static f(o){o.#x=1} }; C.f(new C)",
            "set #x: undefined private property",
        ),
        (
            "class C { #x; static f(o){return #x in o} }; C.f(1)",
            "in: not an object",
        ),
        (
            "class C extends 1 {}",
            "extends: class is not a constructor",
        ),
        (
            "var o={__proto__:null,m(){return super.x}};o.m()",
            "get super.x: no prototype",
        ),
        (
            "var o={__proto__:null,m(){super.x=1}};o.m()",
            "set super.x: no prototype",
        ),
        ("var p={x:1};var o={__proto__:p,m(){'use strict';super.x=2}};Object.defineProperty(o,'x',{value:1,writable:false});o.m()", "set x: not writable"),
        ("var p={x:1};var o={__proto__:p,m(){'use strict';super.x=2}};Object.preventExtensions(o);o.m()", "set x: not extensible"),
        ("var p={get x(){return 1}};var o={__proto__:p,m(){'use strict';super.x=2}};o.m()", "set x: no setter"),
        ("var p={x:1};var o={__proto__:p,m(){'use strict';super['x']=2}};Object.defineProperty(o,'x',{value:1,writable:false});o.m()", "set x: not writable"),
        ("class C extends null {}; new C", "super: not a constructor"),
    ] {
        let expected = format!("TypeError: {expected}");
        let run = dual_run(expression).expect("oracle starts");
        assert_eq!(run.agreement, Agreement::BothAbort, "{expression}: {run:?}");
        assert_eq!(run.oracle_error, expected, "XS: {expression}");
        assert_eq!(run.ironhorse_error, expected, "IH: {expression}");
        let caught = format!("try {{ {expression}; 'no throw' }} catch(e) {{ String(e) }}");
        let run = dual_run(&caught).expect("oracle starts");
        assert_eq!(
            run.agreement,
            Agreement::BothComplete,
            "{expression}: {run:?}"
        );
        assert_eq!(run.oracle_result, expected, "XS caught: {expression}");
        assert_eq!(run.ironhorse_result, expected, "IH caught: {expression}");
    }
}

#[test]
fn reference_error_opcode_messages() {
    for (expression, message) in [
        (
            "(()=>{eval(\"x=1\");let x})()",
            "set x: not initialized yet",
        ),
        ("(()=>{ return x; let x })()", "get x: not initialized yet"),
        (
            "(()=>{function f(){return x}; f(); let x})()",
            "get x: not initialized yet",
        ),
        (
            "class A{}; class B extends A { constructor(){this.x=1;super()} };new B",
            "this: not initialized yet",
        ),
        (
            "class A{}; class B extends A { constructor(){super();super()} };new B",
            "this: already initialized",
        ),
    ] {
        let expected = format!("ReferenceError: {message}");
        let run = dual_run(expression).expect("oracle starts");
        assert_eq!(run.agreement, Agreement::BothAbort, "{expression}: {run:?}");
        assert_eq!(run.oracle_error, expected, "XS: {expression}");
        assert_eq!(run.ironhorse_error, expected, "IH: {expression}");
        let caught = format!("try {{ {expression}; 'no throw' }} catch(e) {{ String(e) }}");
        let run = dual_run(&caught).expect("oracle starts");
        assert_eq!(
            run.agreement,
            Agreement::BothComplete,
            "{expression}: {run:?}"
        );
        assert_eq!(run.oracle_result, expected, "XS caught: {expression}");
        assert_eq!(run.ironhorse_result, expected, "IH caught: {expression}");
    }
}
