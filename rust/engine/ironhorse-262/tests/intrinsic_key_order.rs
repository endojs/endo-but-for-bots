//! The own keys of every intrinsic, compared with the pinned XS: the same
//! keys in the same order, whatever the program's text names, what it
//! computes at run time, what it reflects on first, and whether it locks
//! down, and the same for a Compartment's global object.
//!
//! Ironhorse installs an intrinsic's members lazily, and once listed them in
//! the order they happened to be installed: a program naming `clear`, or
//! reflecting on `Reflect` first, reordered `Map.prototype`. Each member now
//! takes its place in the object's order as it is installed
//! (`ironhorse-vm/src/interp/intrinsic_order.rs`), and a global object's
//! standard bindings are all there before the program runs.
//!
//! [`WALKER`] lists `Reflect.ownKeys` of every object reachable from the
//! global object and from the intrinsics only syntax reaches, through own
//! property values, accessors and prototypes, naming each by its shortest
//! path. XS's answer is cut at about 16 KB, so it is read in pages.
//!
//! The engines' key sets still differ where XS has its own extensions, which
//! the specification leaves to the engine, and where Ironhorse lacks members
//! XS has: [`KEY_SET_DIFFERENCES`] records both, and fails once either moves.

use std::collections::BTreeMap;

use ironhorse_262::{dual_run, Agreement};

/// Lists `PATH = key+key+...` for every object reached, sorted, and answers
/// page `PAGE` of them with the page count first. `ROOT` is the global
/// object to start from.
const WALKER: &str = r#"
var __walk = (function () {
  var roots = [
    ['globalThis', ROOT],
    ['Object.prototype', Object.prototype],
    ['Function.prototype', Function.prototype],
    ['Iterator.prototype', Iterator.prototype],
    ['%GeneratorFunction%', Object.getPrototypeOf(function* () {}).constructor],
    ['%AsyncFunction%', Object.getPrototypeOf(async function () {}).constructor],
    ['%AsyncGeneratorFunction%', Object.getPrototypeOf(async function* () {}).constructor],
    ['%AsyncGeneratorPrototype%', Object.getPrototypeOf(async function* () {}).prototype],
    ['%AsyncIteratorPrototype%', Object.getPrototypeOf(Object.getPrototypeOf(async function* () {}).prototype)],
    ['%ArrayIteratorPrototype%', Object.getPrototypeOf([][Symbol.iterator]())],
    ['%StringIteratorPrototype%', Object.getPrototypeOf(''[Symbol.iterator]())],
    ['%MapIteratorPrototype%', Object.getPrototypeOf(new Map()[Symbol.iterator]())],
    ['%SetIteratorPrototype%', Object.getPrototypeOf(new Set()[Symbol.iterator]())],
    ['%RegExpStringIteratorPrototype%', Object.getPrototypeOf(/a/[Symbol.matchAll](''))],
    ['%IteratorHelperPrototype%', Object.getPrototypeOf([].values().map(function (x) { return x; }))],
    ['%WrapForValidIteratorPrototype%', Object.getPrototypeOf(Iterator.from({ next: function () {} }))],
    ['%TypedArray%', Object.getPrototypeOf(Uint8Array)],
    ['%ThrowTypeError%', Object.getOwnPropertyDescriptor(Function.prototype, 'caller').get],
  ];
  var seen = new Map();
  var depth = new Map();
  var queue = [];
  function visit(path, o, level) {
    if ((typeof o !== 'object' && typeof o !== 'function') || o === null) return;
    if (seen.has(o)) {
      if (depth.get(o) === level && path < seen.get(o)) seen.set(o, path);
      return;
    }
    seen.set(o, path);
    depth.set(o, level);
    queue.push(o);
  }
  for (var i = 0; i < roots.length; i++) visit(roots[i][0], roots[i][1], 0);
  var listed = new Map();
  for (var n = 0; n < queue.length; n++) {
    var o = queue[n];
    var level = depth.get(o);
    var path = seen.get(o);
    var keys = Reflect.ownKeys(o);
    listed.set(o, keys.map(String).join('+'));
    visit(path + '.__proto__', Object.getPrototypeOf(o), level + 1);
    for (var j = 0; j < keys.length; j++) {
      var k = keys[j];
      var name = typeof k === 'symbol' ? '[' + String(k) + ']' : k;
      // The conformance host is not an intrinsic.
      if (name === '$262') continue;
      var d = Object.getOwnPropertyDescriptor(o, k);
      if (!d) continue;
      if ('value' in d) visit(path + '.' + name, d.value, level + 1);
      if (d.get) visit(path + '.' + name + '<get>', d.get, level + 1);
      if (d.set) visit(path + '.' + name + '<set>', d.set, level + 1);
    }
  }
  var lines = [];
  for (var n = 0; n < queue.length; n++) {
    var line = listed.get(queue[n]);
    // A function with only its `length` and `name`: every method.
    if (line !== 'length+name') lines.push(seen.get(queue[n]) + ' = ' + line);
  }
  lines.sort();
  var pages = [[]];
  var size = 0;
  for (var n = 0; n < lines.length; n++) {
    if (size + lines[n].length > 6000) {
      pages.push([]);
      size = 0;
    }
    pages[pages.length - 1].push(lines[n]);
    size += lines[n].length + 1;
  }
  return pages;
})();
__walk.length + '\n' + (__walk[PAGE] || []).join('\n')
"#;

/// `(object, keys only Ironhorse has, keys only XS has)` on an object both
/// engines have. XS's own extensions (the `Math.idiv` family,
/// `String.prototype.compare`, `BigInt.bitLength`, the oracle host's
/// globals, ...) and `Math.random`, which Ironhorse omits by design, stay
/// here; the rest are members Ironhorse has not implemented yet, and leave
/// this table as they land. A Compartment's global object is checked
/// against [`COMPARTMENT_GLOBAL_DIFFERENCES`] instead.
const KEY_SET_DIFFERENCES: &[(&str, &[&str], &[&str])] = &[
    ("Iterator.prototype", &[], &["Symbol(Symbol.dispose)"]),
    (
        "%ArrayIteratorPrototype%",
        &[],
        &["Symbol(Symbol.toStringTag)"],
    ),
    (
        "%AsyncIteratorPrototype%",
        &[],
        &["Symbol(Symbol.asyncDispose)"],
    ),
    (
        "%TypedArray%.prototype",
        &[],
        &["toReversed", "toSorted", "with"],
    ),
    (
        "globalThis",
        &["Intl", "Temporal"],
        &[
            "ModuleSource",
            "TypedArray",
            "trace",
            "ModuleStuff",
            "Native",
            "native",
            "global",
            "mutabilities",
        ],
    ),
    ("globalThis.ArrayBuffer", &[], &["fromBigInt"]),
    (
        "globalThis.AsyncDisposableStack.prototype",
        &[],
        &["toString", "disposed"],
    ),
    ("globalThis.Atomics", &[], &["wake"]),
    ("globalThis.BigInt", &[], &["bitLength", "fromArrayBuffer"]),
    (
        "globalThis.Compartment.prototype",
        &[],
        &["import", "importNow"],
    ),
    (
        "globalThis.DisposableStack.prototype",
        &[],
        &["toString", "disposed"],
    ),
    (
        "globalThis.Math",
        &[],
        &[
            "idiv", "idivmod", "imod", "imuldiv", "irandom", "irem", "mod", "random",
        ],
    ),
    (
        "globalThis.RegExp.prototype",
        &[],
        &[
            "dotAll",
            "flags",
            "global",
            "hasIndices",
            "ignoreCase",
            "multiline",
            "source",
            "sticky",
            "unicode",
            "unicodeSets",
        ],
    ),
    ("globalThis.String.prototype", &[], &["compare"]),
];

/// A Compartment's global object: Ironhorse binds its hardening globals, and
/// the conformance harness's `$262`, in every compartment, where the XS
/// oracle binds them on the start global only.
const COMPARTMENT_GLOBAL_DIFFERENCES: (&[&str], &[&str]) = (
    &["Intl", "Temporal", "harden", "lockdown", "petrify", "$262"],
    &[
        "ModuleSource",
        "TypedArray",
        "trace",
        "ModuleStuff",
        "global",
    ],
);

/// Objects only one engine has, by path prefix: Ironhorse's Intl and
/// Temporal, and XS's own `ModuleSource`, separate
/// `%StringIteratorPrototype%` and oracle host functions.
const IRONHORSE_ONLY: &[&str] = &["globalThis.Intl", "globalThis.Temporal"];
const XS_ONLY: &[&str] = &[
    "%StringIteratorPrototype%",
    "globalThis.ModuleSource",
    "globalThis.ModuleStuff",
    "globalThis.trace",
];

type Listing = BTreeMap<String, Vec<String>>;

/// Run the walker after `prefix`, starting from the global object `root`,
/// and collect each engine's listing.
fn walk(prefix: &str, root: &str) -> (Listing, Listing) {
    let mut ironhorse = Listing::new();
    let mut xs = Listing::new();
    let mut page = 0;
    loop {
        let program = format!(
            "{prefix}\n{}",
            WALKER
                .replace("ROOT", root)
                .replace("PAGE", &page.to_string())
        );
        let run = dual_run(&program).expect("the pinned XS oracle machine must start");
        assert_eq!(
            run.agreement,
            Agreement::BothComplete,
            "page {page} after {prefix:?}: ironhorse {:?} {:?}, xs {:?}",
            run.ironhorse_halt,
            run.ironhorse_error,
            run.oracle_error
        );
        let mut pages = 0;
        for (answer, listing) in [
            (&run.ironhorse_result, &mut ironhorse),
            (&run.oracle_result, &mut xs),
        ] {
            let mut lines = answer.lines();
            let count: usize = lines.next().unwrap().parse().unwrap();
            pages = pages.max(count);
            for line in lines {
                let (path, keys) = line.split_once(" = ").unwrap();
                let keys = keys.split('+').map(str::to_string).collect();
                assert!(
                    listing.insert(path.to_string(), keys).is_none(),
                    "{path} twice"
                );
            }
        }
        page += 1;
        if page >= pages {
            return (ironhorse, xs);
        }
    }
}

/// `keys` but those in `dropped`.
fn without<'a>(keys: &'a [String], dropped: &[&str]) -> Vec<&'a str> {
    keys.iter()
        .map(String::as_str)
        .filter(|key| !dropped.contains(key))
        .collect()
}

/// The keys in `keys` that `others` lacks, in `keys`' order.
fn extra<'a>(keys: &'a [String], others: &[String]) -> Vec<&'a str> {
    keys.iter()
        .filter(|key| !others.contains(key))
        .map(String::as_str)
        .collect()
}

/// Every object both engines have lists the same keys in the same order, but
/// for the recorded differences; and only the recorded objects are missing
/// from either.
fn assert_matches_xs(ironhorse: &Listing, xs: &Listing, compartment_global: bool) {
    let mut bad = Vec::new();
    for path in ironhorse.keys().filter(|path| !xs.contains_key(*path)) {
        if !IRONHORSE_ONLY.iter().any(|prefix| path.starts_with(prefix)) {
            bad.push(format!("  {path}: only Ironhorse has it"));
        }
    }
    for path in xs.keys().filter(|path| !ironhorse.contains_key(*path)) {
        if !XS_ONLY.iter().any(|prefix| path.starts_with(prefix)) {
            bad.push(format!("  {path}: only XS has it"));
        }
    }
    for (path, keys) in ironhorse {
        let Some(xs_keys) = xs.get(path) else {
            continue;
        };
        let (ironhorse_only, xs_only): (&[&str], &[&str]) =
            if compartment_global && path == "globalThis" {
                COMPARTMENT_GLOBAL_DIFFERENCES
            } else {
                KEY_SET_DIFFERENCES
                    .iter()
                    .find(|(object, ..)| object == path)
                    .map_or((&[], &[]), |(_, ironhorse_only, xs_only)| {
                        (*ironhorse_only, *xs_only)
                    })
            };
        if extra(keys, xs_keys) != ironhorse_only || extra(xs_keys, keys) != xs_only {
            bad.push(format!(
                "  {path}: key sets moved\n    ironhorse only: {:?} (recorded {ironhorse_only:?})\n    xs only:        {:?} (recorded {xs_only:?})",
                extra(keys, xs_keys),
                extra(xs_keys, keys)
            ));
        } else if without(keys, ironhorse_only) != without(xs_keys, xs_only) {
            bad.push(format!(
                "  {path}: order differs\n    ironhorse: {}\n    xs:        {}",
                keys.join("+"),
                xs_keys.join("+")
            ));
        }
    }
    assert!(
        bad.is_empty(),
        "intrinsics that differ from XS:\n{}",
        bad.join("\n")
    );
}

/// Ironhorse's listing after a prefix is its bare listing, except where XS's
/// moved too.
fn assert_unmoved(prefix: &str, ironhorse: &Listing, xs: &Listing) {
    static BARE: std::sync::OnceLock<(Listing, Listing)> = std::sync::OnceLock::new();
    let (bare_ironhorse, bare_xs) = BARE.get_or_init(|| walk("", "globalThis"));
    let moved: Vec<_> = ironhorse
        .keys()
        .chain(bare_ironhorse.keys())
        .filter(|path| ironhorse.get(*path) != bare_ironhorse.get(*path))
        .filter(|path| xs.get(*path) == bare_xs.get(*path))
        .collect();
    assert!(
        moved.is_empty(),
        "after {prefix:?}, Ironhorse alone moved {moved:?}"
    );
}

fn check(prefix: &str) {
    let (ironhorse, xs) = walk(prefix, "globalThis");
    assert_matches_xs(&ironhorse, &xs, false);
    if !prefix.is_empty() {
        assert_unmoved(prefix, &ironhorse, &xs);
    }
}

#[test]
fn bare() {
    check("");
}

/// Members, and `constructor`, named in the program text: linked first, they
/// used to come first.
#[test]
fn named_in_the_text() {
    check("var q = { constructor: 1, clear: 1, get: 1, set: 1, size: 1, then: 1, next: 1, toString: 1, valueOf: 1, at: 1, from: 1, of: 1, dispose: 1, disposeAsync: 1, description: 1, name: 1, message: 1, stack: 1, iterator: 1, species: 1, add: 1, keys: 1, values: 1, entries: 1, apply: 1, call: 1, bind: 1, caller: 1, arguments: 1, byteLength: 1, buffer: 1, format: 1, isArray: 1, PI: 1, BYTES_PER_ELEMENT: 1, evaluate: 1, return: 1, throw: 1 };");
}

/// Member names computed at run time, interned while the program runs.
#[test]
fn computed_at_run_time() {
    check("var q = {}; ['cl' + 'ear', 'con' + 'structor', 'is' + 'Array', 'ow' + 'nKeys', 'thr' + 'ow', 'dis' + 'pose', 'ap' + 'ply'].forEach(function (k) { q[k] = 1; });");
}

/// Other intrinsics reflected on first, which interns their members for
/// every object that shares a name with them.
#[test]
fn others_reflected_first() {
    check("[Reflect, Set.prototype, Object.getPrototypeOf(function* () {}).prototype, Math, Promise, Date.prototype, Array, globalThis].forEach(function (o) { Reflect.ownKeys(o); });");
}

#[test]
fn locked_down() {
    check("lockdown();");
}

/// A Compartment's global object lists every standard binding, in order,
/// whatever its parent's program named.
#[test]
fn a_compartment_global() {
    let (ironhorse, xs) = walk("var c = new Compartment();", "c.globalThis");
    assert_matches_xs(&ironhorse, &xs, true);
}
