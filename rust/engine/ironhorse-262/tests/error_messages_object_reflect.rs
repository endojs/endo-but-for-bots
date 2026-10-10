//! Error texts ported from xsObject.c and xsProxy.c. Catching the real error
//! checks both the diagnostic and guest-visible constructor identity.

use ironhorse_262::{dual_run, Agreement};

#[test]
fn object_and_reflect_errors_match_xs() {
    for (expression, message) in [
        ("Object.hasOwn(null, \"x\")", "invalid object"),
        ("Object.assign(null,{})", "invalid target"),
        ("Object.keys(null)", "invalid object"),
        ("Object.getOwnPropertyNames(null)", "invalid object"),
        ("Object.getOwnPropertySymbols(null)", "invalid object"),
        ("Object.getOwnPropertyDescriptors(null)", "invalid object"),
        ("Object.values(null)", "invalid object"),
        ("Object.entries(null)", "invalid object"),
        ("Object.defineProperties({})", "invalid properties"),
        ("Object.setPrototypeOf(null, 1)", "invalid object"),
        ("Reflect.getPrototypeOf(1)", "target: not an object"),
        ("Reflect.setPrototypeOf(1, null)", "target: not an object"),
        ("Reflect.setPrototypeOf({}, 1)", "invalid prototype"),
        ("Reflect.isExtensible(1)", "target: not an object"),
        ("Reflect.preventExtensions(1)", "target: not an object"),
        (
            "Reflect.getOwnPropertyDescriptor(1, 'x')",
            "target: not an object",
        ),
        (
            "Reflect.defineProperty(1, 'x', {})",
            "target: not an object",
        ),
        ("Reflect.defineProperty({}, 'x', 1)", "invalid descriptor"),
        ("Reflect.ownKeys(1)", "target: not an object"),
        ("Reflect.has(1, 'x')", "target: not an object"),
        ("Reflect.get(1, 'x')", "target: not an object"),
        ("Reflect.set(1, 'x', 2)", "target: not an object"),
        ("Reflect.deleteProperty(1, 'x')", "target: not an object"),
        ("Reflect.apply(1, null, [])", "target: not a function"),
        (
            "Reflect.apply(function () {}, null, 1)",
            "argumentsList: not an object",
        ),
        ("Reflect.construct(1, [])", "target: not a constructor"),
        (
            "Reflect.construct(function () {}, [], 1)",
            "newTarget: not a constructor",
        ),
        (
            "Reflect.construct(function () {}, 1)",
            "argumentsList: not an object",
        ),
        ("Object.getPrototypeOf(null)", "invalid object"),
        (
            "Object.prototype.valueOf.call(null)",
            "cannot coerce null to object",
        ),
        (
            "Object.prototype.valueOf.call(undefined)",
            "cannot coerce undefined to object",
        ),
        ("Object.setPrototypeOf({}, 1)", "invalid prototype"),
        ("Object.setPrototypeOf(null, {})", "invalid object"),
        (
            "Object.setPrototypeOf(Object.preventExtensions({}), {})",
            "invalid prototype",
        ),
        (
            "Object.getOwnPropertyDescriptor(null, 'x')",
            "invalid object",
        ),
        (
            "Object.defineProperty(Object.preventExtensions({}), 'x', {value: 1})",
            "invalid descriptor",
        ),
        (
            "Object.defineProperty(new Uint8Array(1), '0', {configurable: false})",
            "invalid descriptor",
        ),
        (
            "Object.defineProperties(Object.preventExtensions({}), {x: {value: 1}})",
            "invalid descriptor",
        ),
    ] {
        let source = format!("var result = 'not caught'; try {{ {expression}; }} catch (error) {{ result = (error instanceof TypeError) + ':' + error.message; }} result");
        let run = dual_run(&source).expect("oracle run");
        assert_eq!(run.agreement, Agreement::BothComplete, "{expression}");
        assert_eq!(run.oracle_result, format!("true:{message}"), "{expression}");
        assert_eq!(run.ironhorse_result, run.oracle_result, "{expression}");
    }
}
