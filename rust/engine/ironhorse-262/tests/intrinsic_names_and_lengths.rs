//! Every built-in function reachable from the global object, or through
//! syntax from the iterator, generator and async prototypes, has XS's `name`
//! and `length`, except where XS contradicts the specification.
//!
//! The walk visits each object once, in key order, and lists every function
//! value and accessor as `path=name/length`. XS's completion value is bounded,
//! so the list is read a page at a time. Only paths both engines reach are
//! compared: a member one engine lacks is a missing intrinsic, recorded
//! elsewhere (`xs_departures.rs`), not a naming difference.

use std::collections::BTreeMap;

use ironhorse_262::{dual_run, Agreement};

const WALK: &str = r#"(function () { var seen = []; var out = [];
function key(k) { return typeof k === 'symbol' ? '[' + String(k.description) + ']' : String(k); }
function visit(o, path) {
  if (o === null || (typeof o !== 'object' && typeof o !== 'function')) return;
  if (seen.indexOf(o) >= 0) return;
  seen.push(o);
  var keys = Object.getOwnPropertyNames(o).concat(Object.getOwnPropertySymbols(o));
  keys.sort(function (a, b) { a = key(a); b = key(b); return a < b ? -1 : a > b ? 1 : 0; });
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i], d;
    try { d = Object.getOwnPropertyDescriptor(o, k); } catch (e) { continue; }
    if (!d) continue;
    var parts = 'value' in d ? [['', d.value]] : [['get ', d.get], ['set ', d.set]];
    for (var j = 0; j < parts.length; j++) {
      var f = parts[j][1];
      var p = path + '.' + parts[j][0] + key(k);
      if (typeof f === 'function') {
        var n, l;
        try { n = f.name; } catch (e) { n = '!'; }
        try { l = f.length; } catch (e) { l = '!'; }
        out.push(p + '=' + String(n) + '/' + String(l));
      }
      if (f && (typeof f === 'object' || typeof f === 'function') && k !== 'caller' && k !== 'arguments') visit(f, p);
    }
  }
  var proto = Object.getPrototypeOf(o);
  if (proto) visit(proto, path + '.__proto__');
}
var roots = [
  ['globalThis', globalThis],
  ['ArrayIterator', Object.getPrototypeOf([][Symbol.iterator]())],
  ['StringIterator', Object.getPrototypeOf(''[Symbol.iterator]())],
  ['MapIterator', Object.getPrototypeOf(new Map()[Symbol.iterator]())],
  ['SetIterator', Object.getPrototypeOf(new Set()[Symbol.iterator]())],
  ['RegExpStringIterator', Object.getPrototypeOf(/a/[Symbol.matchAll](''))],
  ['Generator', Object.getPrototypeOf(function* () {})],
  ['AsyncGenerator', Object.getPrototypeOf(async function* () {})],
  ['AsyncFunction', Object.getPrototypeOf(async function () {})],
  ['IteratorHelper', typeof Iterator === 'function' && Iterator.prototype.map ? Object.getPrototypeOf([].values().map(function (x) { return x; })) : null],
  ['WrapForValid', typeof Iterator === 'function' && Iterator.from ? Object.getPrototypeOf(Iterator.from({ next: function () {} })) : null],
];
for (var r = 0; r < roots.length; r++) visit(roots[r][1], roots[r][0]);
return out.length + '#' + out.slice(PAGE * PAGE_SIZE, (PAGE + 1) * PAGE_SIZE).join(';'); })()"#;

const PAGE_SIZE: usize = 150;

/// Paths where Ironhorse follows the specification (and V8) against XS:
/// (path, Ironhorse's `name/length`, XS's).
const DEPARTED: &[(&str, &str, &str)] = &[
    // %IteratorHelperPrototype%.next and .return take no arguments (ES2025
    // 27.1.2.1.1, 27.1.2.1.2); XS gives both length 1.
    ("IteratorHelper.next", "next/0", "next/1"),
    ("IteratorHelper.return", "return/0", "return/1"),
    // %WrapForValidIteratorPrototype%.next and .return likewise (27.1.3.2.1.1,
    // 27.1.3.2.1.2).
    ("WrapForValid.next", "next/0", "next/1"),
    ("WrapForValid.return", "return/0", "return/1"),
    // Annex B's RegExp.prototype.compile(pattern, flags) has length 2
    // (B.2.4.1); XS gives 0.
    (
        "globalThis.RegExp.prototype.compile",
        "compile/2",
        "compile/0",
    ),
];

fn page(source: &str) -> (usize, Vec<(String, String)>) {
    let (total, entries) = source.split_once('#').expect("the walk reports its total");
    let entries = entries
        .split(';')
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            let (path, value) = entry.rsplit_once('=').expect("path=name/length");
            (path.to_string(), value.to_string())
        })
        .collect();
    (total.parse().expect("a total"), entries)
}

#[test]
fn every_reachable_built_in_has_xss_name_and_length() {
    let mut ironhorse = BTreeMap::new();
    let mut xs = BTreeMap::new();
    let mut at = 0;
    loop {
        let source = format!("var PAGE = {at}, PAGE_SIZE = {PAGE_SIZE}; {WALK}");
        let run = dual_run(&source).expect("the pinned XS oracle machine must start");
        assert_eq!(run.agreement, Agreement::BothComplete, "page {at}: {run:?}");
        let (ironhorse_total, ironhorse_page) = page(&run.ironhorse_result);
        let (xs_total, xs_page) = page(&run.oracle_result);
        ironhorse.extend(ironhorse_page);
        xs.extend(xs_page);
        at += 1;
        if at * PAGE_SIZE >= ironhorse_total.max(xs_total) {
            break;
        }
    }
    let common: Vec<&String> = ironhorse
        .keys()
        .filter(|path| xs.contains_key(*path))
        .collect();
    assert!(
        common.len() > 500,
        "the walk reached only {} shared paths",
        common.len()
    );
    let mut differing = Vec::new();
    for path in common {
        let (mine, theirs) = (&ironhorse[path], &xs[path]);
        match DEPARTED.iter().find(|(departed, ..)| departed == path) {
            Some(&(_, expected_mine, expected_theirs)) => assert_eq!(
                (mine.as_str(), theirs.as_str()),
                (expected_mine, expected_theirs),
                "{path}: a recorded departure moved"
            ),
            None if mine != theirs => {
                differing.push(format!("{path}: ironhorse {mine}, xs {theirs}"))
            }
            None => {}
        }
    }
    assert!(
        differing.is_empty(),
        "names or lengths differ from XS:\n{}",
        differing.join("\n")
    );
    for (path, ..) in DEPARTED {
        assert!(
            ironhorse.contains_key(*path) && xs.contains_key(*path),
            "{path}: a recorded departure is no longer reached"
        );
    }
}
