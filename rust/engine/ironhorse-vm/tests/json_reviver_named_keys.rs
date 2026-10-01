//! A `JSON.parse` reviver can NAME a later sibling index mid-walk, and the
//! walk must still find it.
//!
//! The object branch of `InternalizeJSONProperty` snapshots its keys before
//! any reviver runs. An index key whose name the table has never held is
//! captured as an index; a reviver that redefines that sibling with an
//! accessor promotes it to a named slot, interning the name. Two lookups kept
//! using the form the key had on entry:
//!
//! - the child's `[[Get]]` read the index store the property had left, so the
//!   reviver saw `undefined` and the write-back then deleted the live
//!   property;
//! - the retained-source map was keyed by the form each key had when the
//!   object was entered, so a sibling named later lost its `context.source`
//!   although its value was unchanged.
//!
//! Every expected value below was measured on the XS oracle; Node agrees.

use ironhorse_vm::{run_program_with_symbols, RunOutcome};

fn run(source: &str) -> RunOutcome {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("source compiles");
    run_program_with_symbols(&bytecode, &symbols)
}

fn assert_result(source: &str, expected: &str) {
    let out = run(source);
    assert!(
        out.completed,
        "must complete; halt: {:?}\n  {source}",
        out.halt
    );
    assert_eq!(out.result, expected, "{source}");
}

/// Logs each visit as `key=value:source`, with `-` for no `source`.
const LOGGING_REVIVER: &str = "var log = []; function logged(k, val, ctx) { \
     log.push(k + '=' + JSON.stringify(val) + ':' + ('source' in ctx ? ctx.source : '-')); }";

#[test]
fn the_visit_reads_a_sibling_an_earlier_reviver_named() {
    assert_result(
        &format!(
            "{LOGGING_REVIVER} var v = JSON.parse('{{\"0\":1,\"2\":3}}', function (k, val, ctx) {{ \
                 logged(k, val, ctx); \
                 if (k === '0') Object.defineProperty(this, '2', {{ \
                     get: function () {{ return 30; }}, enumerable: true, configurable: true }}); \
                 return val; }}); \
             JSON.stringify(v) + ' | ' + log.join(' ')"
        ),
        r#"{"0":1,"2":30} | 0=1:1 2=30:- ={"0":1,"2":30}:-"#,
    );
}

#[test]
fn a_sibling_named_mid_walk_keeps_its_source() {
    assert_result(
        &format!(
            "{LOGGING_REVIVER} var v = JSON.parse('{{\"4\":40,\"5\":50}}', function (k, val, ctx) {{ \
                 logged(k, val, ctx); \
                 if (k === '4') Object.defineProperty(this, '5', {{ \
                     value: 50, writable: true, enumerable: true, configurable: true }}); \
                 return val; }}); \
             JSON.stringify(v) + ' | ' + log.join(' ')"
        ),
        r#"{"4":40,"5":50} | 4=40:40 5=50:50 ={"4":40,"5":50}:-"#,
    );
}

/// Both lookups, and the key order of a holder whose index a reviver promoted,
/// in one walk over nested objects and arrays.
#[test]
fn a_walk_that_names_indices_at_every_level_matches_xs() {
    let source = r#"
        var log = [];
        var v = JSON.parse('{"0":10,"1":{"2":[20,21]},"2":30,"3":"s","x":{"4":40,"5":50}}', function (k, val, ctx) {
          log.push(k + '=' + JSON.stringify(val) + ':' + ('source' in ctx ? ctx.source : '-') + ':' + Object.keys(this).join('+'));
          if (k === '0') Object.defineProperty(this, '2', { get: function () { log.push('get2'); return 30; }, enumerable: true, configurable: true });
          if (k === '4') { Object.defineProperty(this, '5', { value: 50, writable: true, enumerable: true, configurable: true }); this[9] = 'nine'; }
          if (k === '20') this[1] = 'x';
          return val;
        });
        [JSON.stringify(v), log.join(' ')].join(' | ')
    "#;
    assert_result(
        source,
        concat!(
            r#"{"0":10,"1":{"2":[20,21,30]},"2":30,"3":"s","x":{"4":40,"5":50,"9":"nine"}} | "#,
            r#"0=10:10:0+1+2+3+x 0=20:20:0+1 1=21:21:0+1+2 get2 2=[20,21,30]:-:2 get2 "#,
            r#"1={"2":[20,21,30]}:-:0+1+2+3+x get2 2=30:30:0+1+2+3+x 3="s":"s":0+1+2+3+x "#,
            r#"4=40:40:4+5 5=50:50:4+5+9 x={"4":40,"5":50,"9":"nine"}:-:0+1+2+3+x get2 "#,
            r#"={"0":10,"1":{"2":[20,21,30]},"2":30,"3":"s","x":{"4":40,"5":50,"9":"nine"}}:-: get2"#,
        ),
    );
}
