//! Guest option reads must cross the same MOP boundary as reflection.
use ironhorse_vm::Interp;

fn check(source: &str, expected: &str) {
    let (code, atoms) = ironhorse_compile::compile_atoms(source).expect("compile");
    let mut vm = Interp::new();
    vm.link_intrinsics(&ironhorse_vm::parse_symbols(&atoms));
    let result = vm.run(&code);
    assert!(result.completed, "{source}: {:?}", result.halt);
    assert_eq!(result.result, expected, "{source}");
}

#[test]
fn intl_options_invoke_traps_for_previously_unknown_names() {
    // None of the option names occur as identifiers or complete key literals
    // in this source. A missing intern id must not suppress a proxy Get.
    check(
        r#"
        var log = [];
        var options = new Proxy({}, {get: function (target, key) {
            log.push(key);
            return undefined;
        }});
        new Intl.Locale('en', options);
        log.indexOf('num' + 'eric') >= 0 && log.indexOf('lang' + 'uage') >= 0
    "#,
        "true",
    );
}

#[test]
fn intl_options_invoke_accessors_and_propagate_throws() {
    check(
        r#"
        var count = 0;
        var locale = new Intl.Locale('en', {get numeric() { count++; return true; }});
        count === 1 && locale.numeric
    "#,
        "true",
    );
    check(
        r#"
        var marker = {};
        var caught = false;
        try { new Intl.Locale('en', new Proxy({}, {get: function () { throw marker; }})); }
        catch (error) { caught = error === marker; }
        caught
    "#,
        "true",
    );
}

#[test]
fn temporal_rounding_increment_invokes_accessor() {
    check(
        r#"
        var count = 0;
        Temporal.Duration.from({seconds: 3}).round({
            smallestUnit: 'second',
            get roundingIncrement() { count++; return 1; }
        });
        count
    "#,
        "1",
    );
}

#[test]
fn exotic_named_fallbacks_invoke_accessors() {
    check(
        r#"
        var objects = [new Intl.Locale('en'), /x/, Temporal.Duration.from({seconds: 1})];
        var count = 0;
        for (var object of objects) {
            Object.defineProperty(object, 'probe', {get: function () { count++; return 73; }});
            if (object.probe !== 73) throw 'wrong value';
        }
        count
    "#,
        "3",
    );
}

#[test]
fn error_stack_reads_live_properties_through_mop() {
    check(
        r#"
        var error = new Error('original');
        var count = 0;
        Object.defineProperty(error, 'name', {get: function () { count++; return 'renamed'; }});
        Object.defineProperty(error, 'message', {get: function () { count++; return '\uD800'; }});
        var stack = error.stack;
        count === 2 && stack.charCodeAt(9) === 55296
    "#,
        "true",
    );
}

#[test]
fn transparent_membranes_preserve_property_operations() {
    check(
        r#"
        var shapes = [
            {}, [], function named() {}, new String('abc'), new Number(3),
            new Boolean(true), Object(Symbol('s')), Object(1n), /x/g,
            new Date(0), new Map(), new Set(), new WeakMap(), new WeakSet(),
            new ArrayBuffer(4), new Uint8Array(4), new DataView(new ArrayBuffer(4)),
            new Error('x'), Object.create(null), {get value() { return 7; }}
        ];
        for (var object of shapes) {
            var proxy = new Proxy(object, {});
            var keys = Reflect.ownKeys(object);
            var proxyKeys = Reflect.ownKeys(proxy);
            if (keys.length !== proxyKeys.length) throw 'key count';
            for (var i = 0; i < keys.length; i++) {
                var key = keys[i];
                if (key !== proxyKeys[i]) throw 'key order';
                var a = Reflect.getOwnPropertyDescriptor(object, key);
                var b = Reflect.getOwnPropertyDescriptor(proxy, key);
                for (var field of ['value', 'get', 'set', 'writable', 'enumerable', 'configurable']) {
                    if (!Object.is(a[field], b[field])) throw 'descriptor ' + field;
                }
                if (!Object.is(Reflect.get(object, key), Reflect.get(proxy, key))) throw 'get';
                if (Reflect.has(object, key) !== Reflect.has(proxy, key)) throw 'has';
            }
            if (!Reflect.set(proxy, 'seamProbe', 73) || Reflect.get(object, 'seamProbe') !== 73) throw 'set';
            if (!Reflect.deleteProperty(proxy, 'seamProbe') || Reflect.has(object, 'seamProbe')) throw 'delete';
        }
        true
    "#,
        "true",
    );
}

/// Recursively scan the module tree: extraction must not weaken the boundary.
/// Tokens also catch aliases (`let read = Interp::boot_chain_get`), raw
/// identifiers, and calls split by comments or whitespace.
#[test]
fn raw_property_reads_are_confined_to_boot_restore_and_mop() {
    use ironhorse_vm::source_scan::{code_only, rs_files, tokens};
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut violations = Vec::new();
    for path in rs_files(&root) {
        let relative = path.strip_prefix(&root).unwrap().to_str().unwrap();
        let source = std::fs::read_to_string(&path).unwrap();
        let code = code_only(&source);
        for token in tokens(&code) {
            let allowed = match token.text {
                "instance_get" | "instance_has" | "instance_put" => false,
                "boot_chain_get" => matches!(
                    relative,
                    "interp/link.rs"
                        | "interp/persist.rs"
                        | "interp/property/ordinary.rs"
                        | "interp/tests.rs"
                ),
                "ordinary_get" | "ordinary_set" => {
                    relative == "interp/property.rs" || relative.starts_with("interp/property/")
                }
                _ => true,
            };
            if !allowed {
                violations.push(format!("{relative}: {}", token.text));
            }
        }
    }
    assert!(
        violations.is_empty(),
        "property MOP bypasses: {violations:?}"
    );
}

#[test]
fn additional_option_readers_do_not_gate_on_atom_presence() {
    check(
        r#"
        var log = [];
        var options = new Proxy({}, {get: function (target, key) { log.push(key); }});
        new Intl.NumberFormat('en', options);
        log.indexOf('minimum' + 'IntegerDigits') >= 0
    "#,
        "true",
    );
}

#[test]
fn super_writes_invoke_proxy_set() {
    check(
        r#"
        var count = 0;
        var object = {write() { super.x = 1; super['y'] = 2; }};
        Object.setPrototypeOf(object, new Proxy({}, {set: function () { count++; return true; }}));
        object.write();
        count
    "#,
        "2",
    );
}

#[test]
fn set_like_size_read_invokes_proxy_get() {
    check(
        r#"
        var log = [];
        var other = new Proxy(new Set([2]), {get: function (target, key) {
            log.push(key);
            if (key === 'size') return 1;
            if (key === 'has') return function (x) { return x === 2; };
            if (key === 'keys') return function () { return [2].values(); };
        }});
        var union = new Set([1]).union(other);
        union.size === 2 && log.join(',') === 'size,has,keys'
    "#,
        "true",
    );
}
