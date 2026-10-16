//! A native reads some intrinsic members implicitly: `JSON.stringify` reads
//! `toJSON`, and `Date.prototype.toJSON` reads `toISOString`. Ironhorse installs
//! an intrinsic's members lazily, so such a member must be present however the
//! program first reaches its owner: in the unit that names it, in a later
//! crank, through `eval` or `Function`, inside a Compartment, or through a
//! computed name. Each row runs its cranks on one XS machine and one relinking
//! Ironhorse machine and compares every crank's result.

use ironhorse_262::{dual_run_cranks, Agreement};

/// `(label, cranks)`. The first crank of each "later" row names nothing the
/// last one reaches.
const ROWS: &[(&str, &[&str])] = &[
    // `Date.prototype.toJSON`, reached by `JSON.stringify`.
    ("date: same unit", &["JSON.stringify(new Date(0))"]),
    ("date: later crank", &["0", "JSON.stringify(new Date(0))"]),
    (
        "date: later crank, nested",
        &["0", "JSON.stringify({ d: new Date(0) })"],
    ),
    ("date: eval", &["eval('JSON.stringify(new Date(0))')"]),
    (
        "date: Function",
        &["Function('return JSON.stringify(new Date(0))')()"],
    ),
    (
        "date: compartment",
        &["new Compartment().evaluate('JSON.stringify(new Date(0))')"],
    ),
    (
        "date: computed name",
        &["JSON.stringify(new globalThis['Da' + 'te'](0))"],
    ),
    (
        "date: computed name, later crank",
        &["0", "JSON.stringify(new globalThis['Da' + 'te'](0))"],
    ),
    // `Date.prototype.toISOString`, reached by `toJSON`.
    ("date: toJSON, later crank", &["0", "new Date(0).toJSON()"]),
    (
        "date: toJSON, eval",
        &["eval('new Date(0).toJSON()')"],
    ),
    // The rest of `Date`'s implicit reach: `@@toPrimitive`, then
    // `toString`/`valueOf`, which every link interns.
    ("date: to primitive, later crank", &["0", "new Date(0) - 0"]),
    (
        "date: to string, later crank",
        &["0", "typeof (new Date(0) + '')"],
    ),
    (
        "date: own toJSON by string, later crank",
        &["0", "Date.prototype.hasOwnProperty('to' + 'JSON')"],
    ),
    (
        "date: own keys, later crank",
        &["0", "Object.getOwnPropertyNames(Date.prototype).length"],
    ),
    // A guest's deletion of the member survives a later unit that names the
    // owner.
    (
        "date: deleted toJSON stays deleted",
        &[
            "delete Date.prototype.toJSON; 0",
            "JSON.stringify(new Date(0))",
            "eval('JSON.stringify(new Date(0))')",
        ],
    ),
    // A typed array's implicit reach: `@@iterator`, `@@toStringTag` and
    // `join`.
    (
        "typed array: later crank",
        &[
            "0",
            "[JSON.stringify(new Uint8Array([1, 2])), Object.prototype.toString.call(new Uint8Array(1)), String(new Uint8Array([1, 2])), Array.from(new Uint8Array([3])).length].join('|')",
        ],
    ),
    (
        "typed array: eval",
        &["eval('[JSON.stringify(new Uint8Array([1, 2])), String(new Uint8Array([1, 2]))].join(\"|\")')"],
    ),
    // IteratorClose reads `return`: a native that closes a generator early
    // runs its `finally`.
    (
        "generator close: later crank",
        &[
            "var log = []; var g = 0; g = function* () { try { yield 1; yield 2; } finally { log.push('closed'); } }; 0",
            "try { Array.from(g(), function () { throw 0; }); } catch (e) {} try { new Map(g()); } catch (e) {} try { Object.fromEntries(g()); } catch (e) {} log.join()",
        ],
    ),
    (
        "generator close: eval",
        &["eval('var log = []; function* g() { try { yield 1; } finally { log.push(1); } } try { new Set(g()).union(0); } catch (e) {} try { Array.from(g(), function () { throw 0; }); } catch (e) {} log.length')"],
    ),
    // Symbol-keyed members a native reads: `@@replace`, `@@split`,
    // `@@match`, `@@iterator`, `@@toStringTag`, `@@isConcatSpreadable`.
    (
        "symbol members: later crank",
        &[
            "0",
            "['aXa'.replace(/a/g, 'b'), 'a1b'.split(/1/).length, 'abc'.match(/b/).index, [...new Map([[1, 2]])].length, Array.from(new Set([1, 2])).length, Object.prototype.toString.call(new Map()), [].concat([1], 2).length].join('|')",
        ],
    ),
    (
        "symbol members: computed name",
        &["var R = globalThis['Reg' + 'Exp']; ['aXa'.replace(new R('a', 'g'), 'b'), 'a1b'.split(new R('1')).length].join('|')"],
    ),
    // An Error's: `name` and `message`, which every link interns.
    (
        "error: later crank",
        &[
            "0",
            "[String(new RangeError('x')), Object.prototype.toString.call(new TypeError())].join('|')",
        ],
    ),
];

/// Run every row and list each crank whose result differs from XS's.
fn differences() -> Vec<String> {
    let mut out = Vec::new();
    for (label, cranks) in ROWS {
        let runs = dual_run_cranks(cranks).expect("the XS oracle machine must start");
        assert_eq!(runs.len(), cranks.len(), "{label}: every crank ran");
        for (index, run) in runs.iter().enumerate() {
            if run.agreement != Agreement::BothComplete || !run.result_agrees {
                out.push(format!(
                    "{label} (crank {index}): ironhorse {:?} {:?}, xs {:?}",
                    run.agreement, run.ironhorse_result, run.oracle_result
                ));
            }
        }
    }
    out
}

#[test]
fn implicitly_read_members_are_reached_on_every_path() {
    let differences = differences();
    assert!(
        differences.is_empty(),
        "results that differ from XS:\n  {}",
        differences.join("\n  ")
    );
}
