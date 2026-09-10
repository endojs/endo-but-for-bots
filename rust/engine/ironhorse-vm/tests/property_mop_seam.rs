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
                "instance_get" | "instance_has" | "instance_put" | "resolve_get" => false,
                "mop_get_option_field" => matches!(
                    relative,
                    "interp/property.rs" | "interp/natives/intl.rs" | "interp/natives/temporal.rs"
                ),
                "symbol_ids" => !matches!(
                    relative,
                    "interp/natives/intl.rs" | "interp/natives/temporal.rs"
                ),
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

fn public_restore_bypasses(source: &str, session_module: bool) -> Vec<String> {
    use ironhorse_vm::source_scan::{code_only, literal_end, matching_delimiter, tokens};
    let code = code_only(source);
    let scanned = tokens(&code);
    let session_impls: Vec<_> = scanned
        .windows(3)
        .enumerate()
        .filter(|(_, window)| {
            session_module
                && window[0].text == "impl"
                && window[1].text == "RestoreSession"
                && window[2].text == "{"
        })
        .map(|(i, _)| i + 2..matching_delimiter(&scanned, i + 2) + 1)
        .collect();
    let mut violations = Vec::new();
    for (i, pair) in scanned.windows(2).enumerate() {
        if pair[0].text != "fn" || !pair[1].text.starts_with("restore_") {
            continue;
        }
        let visibility = scanned[..i].iter().rev().find(|token| {
            !matches!(token.text, "async" | "unsafe" | "const" | "extern")
                && literal_end(token.text, 0).is_none()
        });
        if visibility.is_some_and(|token| token.text == "pub")
            && !session_impls.iter().any(|body| body.contains(&i))
        {
            violations.push(pair[1].text.to_owned());
        }
    }
    violations
}

#[test]
fn public_restore_guard_checks_the_receiver_and_abi_modifiers() {
    for declaration in [
        "pub fn restore_bad",
        "pub extern \"C\" fn restore_bad",
        "pub unsafe extern \"C\" fn restore_bad",
    ] {
        let source = format!("impl RestoreSession {{ pub fn restore_good(&mut self) {{}} }} impl Interp {{ {declaration}(&mut self) {{}} }}");
        assert_eq!(public_restore_bypasses(&source, true), vec!["restore_bad"]);
    }
    assert!(public_restore_bypasses(
        "impl Interp { pub(super) fn restore_private(&mut self) {} }",
        false
    )
    .is_empty());
}

#[test]
fn public_restore_verbs_are_confined_to_the_owned_session() {
    use ironhorse_vm::source_scan::rs_files;
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut violations = Vec::new();
    for path in rs_files(&root) {
        let relative = path.strip_prefix(&root).unwrap().to_str().unwrap();
        let source = std::fs::read_to_string(&path).unwrap();
        for name in public_restore_bypasses(&source, relative == "interp/restore.rs") {
            violations.push(format!("{relative}: {name}"));
        }
    }
    assert!(
        violations.is_empty(),
        "public restore bypasses: {violations:?}"
    );
}

fn restore_row_contract_violations(source: &str, rows: &[&str]) -> Vec<String> {
    use ironhorse_vm::source_scan::{code_only, literal_end, matching_delimiter, tokens};
    let code = code_only(source);
    let scanned = tokens(&code);
    let mut remaining: std::collections::BTreeSet<_> = rows.iter().copied().collect();
    let mut violations = Vec::new();
    if remaining.len() != rows.len() {
        violations.push("duplicate row registration".into());
    }
    for (i, pair) in scanned.windows(2).enumerate() {
        if pair[0].text != "fn" {
            continue;
        }
        let Some(row) = pair[1].text.strip_prefix("restore_") else {
            continue;
        };
        // restore_row_bit is private machinery, not a row verb.
        let visibility = scanned[..i].iter().rev().find(|token| {
            !matches!(token.text, "async" | "unsafe" | "const" | "extern")
                && literal_end(token.text, 0).is_none()
        });
        if !visibility.is_some_and(|token| token.text == "pub") {
            continue;
        }
        if !remaining.remove(row) {
            violations.push(format!("unregistered or repeated verb: {row}"));
        }
        let params = i + 2;
        if scanned[params].text != "(" {
            violations.push(format!("unexpected generic verb: {row}"));
            continue;
        }
        let end = matching_delimiter(&scanned, params);
        let body = end
            + 1
            + scanned[end + 1..]
                .iter()
                .position(|t| t.text == "{")
                .unwrap();
        let result: Vec<_> = scanned[end + 1..body].iter().map(|t| t.text).collect();
        if result != ["-", ">", "Result", "<", "(", ")", ",", "RestoreError", ">"] {
            violations.push(format!("nonuniform return type: {row}"));
        }
        let first: Vec<_> = scanned[body + 1..].iter().take(8).map(|t| t.text).collect();
        let literal = format!("\"{row}\"");
        if first != ["self", ".", "admit", "(", &literal, ")", "?", ";"] {
            violations.push(format!("verb must admit its own row first: {row}"));
        }
    }
    violations.extend(
        remaining
            .into_iter()
            .map(|row| format!("row has no verb: {row}")),
    );
    violations
}

#[test]
fn restore_row_guard_rejects_unregistered_and_nonuniform_verbs() {
    let good = "pub fn restore_sample(&mut self) -> Result<(), RestoreError> { self.admit(\"sample\")?; Ok(()) }";
    assert!(restore_row_contract_violations(good, &["sample"]).is_empty());
    for bad in [
        good.replace("Result<(), RestoreError>", "bool"),
        good.replace("pub fn", "pub unsafe extern \"C\" fn")
            .replace("Result<(), RestoreError>", "bool"),
        good.replace("self.admit(\"sample\")?;", ""),
        good.replace("self.admit(\"sample\")?;", "self.admit(\"other\")?;"),
        good.replace("restore_sample", "restore_other"),
    ] {
        assert!(
            !restore_row_contract_violations(&bad, &["sample"]).is_empty(),
            "{bad}"
        );
    }
    assert!(!restore_row_contract_violations(good, &["sample", "sample"]).is_empty());
    assert!(!restore_row_contract_violations("", &["sample"]).is_empty());
}

#[test]
fn every_restore_verb_has_one_required_row_and_uniform_result() {
    use ironhorse_vm::source_scan::{code_only, matching_delimiter, tokens};
    let source = include_str!("../src/interp/restore.rs");
    let code = code_only(source);
    let scanned = tokens(&code);
    let registration = scanned
        .windows(2)
        .position(|pair| pair[0].text == "const" && pair[1].text == "RESTORE_ROWS")
        .unwrap();
    let equal = registration
        + scanned[registration..]
            .iter()
            .position(|t| t.text == "=")
            .unwrap();
    let open = equal + scanned[equal..].iter().position(|t| t.text == "[").unwrap();
    let close = matching_delimiter(&scanned, open);
    let rows: Vec<_> = scanned[open + 1..close]
        .iter()
        .filter(|t| t.text != ",")
        .map(|t| t.text.strip_prefix('"').unwrap().strip_suffix('"').unwrap())
        .collect();
    let violations = restore_row_contract_violations(source, &rows);
    assert!(
        violations.is_empty(),
        "restore row contract: {violations:?}"
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

#[test]
fn lossy_utf16_text_is_diagnostic_only() {
    use ironhorse_vm::source_scan::{code_only, rs_files, token_body, tokens};
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut violations = Vec::new();
    for path in rs_files(&root) {
        let relative = path.strip_prefix(&root).unwrap().to_str().unwrap();
        let source = std::fs::read_to_string(&path).unwrap();
        let code = code_only(&source);
        let tokens = tokens(&code);
        let allowed_functions: &[&str] = match relative {
            "interp/strings.rs" => &["str_text_lossy"],
            "interp/render.rs" => &[
                "render_at",
                "render_uncaught",
                "string_tag_of",
                "render_symbol_lossy",
            ],
            "interp/property.rs" => &["property_debug_name"],
            _ => &[],
        };
        let ranges: Vec<_> = allowed_functions
            .iter()
            .map(|name| token_body(&tokens, &format!("fn {name}")))
            .collect();
        for (index, token) in tokens.iter().enumerate() {
            let allowed = match token.text {
                "str_text" | "to_string_bytes_metered" | "value_to_string" => false,
                "str_text_lossy" => {
                    ranges.iter().any(|range| range.contains(&index))
                        || (relative == "interp/strings.rs"
                            && index > 0
                            && tokens[index - 1].text == "fn")
                }
                "from_utf16_lossy" => {
                    relative != "interp/property.rs"
                        && ranges.iter().any(|range| range.contains(&index))
                }
                "string_tag_of" => relative == "interp/render.rs",
                _ => true,
            };
            if !allowed {
                violations.push(format!("{relative}: {}", token.text));
            }
        }
    }
    assert!(violations.is_empty(), "lossy value text: {violations:?}");
}

#[test]
fn absent_option_names_still_reach_inherited_proxy_gets() {
    check(
        r#"
        var receiver;
        var options = Object.create(new Proxy({}, {get(target, key, actual) {
            if (key === 'locale' + 'Matcher') receiver = actual;
            return undefined;
        }}));
        new Intl.NumberFormat('en', options);
        receiver === options
    "#,
        "true",
    );
}

#[test]
fn host_sentinel_inspection_does_not_treat_an_accessor_as_data() {
    for declaration in ["globalThis.signal = 3;", "var signal = 3;"] {
        let (code, atoms) = ironhorse_compile::compile_atoms(&format!(
            r#"
        {declaration}
        Object.defineProperty(globalThis, 'signal', {{get() {{ throw 4; }}}});
        0
    "#
        ))
        .unwrap();
        let mut vm = Interp::new();
        // A newly declared global var is nonconfigurable. Seed a configurable
        // property in an earlier crank so replacing the declared alias is legal.
        let (setup, setup_atoms) =
            ironhorse_compile::compile_atoms("globalThis.signal = 1;").unwrap();
        vm.link_intrinsics(&ironhorse_vm::parse_symbols(&setup_atoms));
        assert!(vm.run(&setup).completed);
        let code = vm
            .relink_crank(&code, &ironhorse_vm::parse_symbols(&atoms))
            .unwrap();
        let outcome = vm.run(&code);
        assert!(outcome.completed, "{declaration}: {:?}", outcome.halt);
        assert_eq!(vm.global_string("signal"), None);
    }
}
