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

/// A walk over `json` whose reviver logs each visit, runs `mutate` with the
/// holder as `this` when it visits key `0`, and returns `ret`.
fn mutating_walk(json: &str, mutate: &str, ret: &str) -> String {
    format!(
        "{LOGGING_REVIVER} var v = JSON.parse('{json}', function (k, val, ctx) {{ \
             logged(k, val, ctx); if (k === '0') {{ {mutate} }} return {ret}; }}); \
         JSON.stringify(v) + ' | ' + log.join(' ')"
    )
}

/// An Array holder is walked by the same snapshot of indices, so a sibling an
/// earlier visit redefined is read as it now is: a data redefinition with the
/// parsed value keeps its source, an accessor's value has none.
#[test]
fn an_array_holder_reads_a_sibling_an_earlier_reviver_redefined() {
    assert_result(
        &mutating_walk(
            "[1,2,3]",
            "Object.defineProperty(this, '2', { value: 3, writable: true, enumerable: true, \
                 configurable: true });",
            "val",
        ),
        "[1,2,3] | 0=1:1 1=2:2 2=3:3 =[1,2,3]:-",
    );
    assert_result(
        &mutating_walk(
            "[1,2,3]",
            "Object.defineProperty(this, '2', { get: function () { return 33; }, \
                 enumerable: true, configurable: true });",
            "val",
        ),
        "[1,2,33] | 0=1:1 1=2:2 2=33:- =[1,2,33]:-",
    );
}

/// A sibling deleted before its turn is still visited, as `undefined` and
/// without a source, and the `undefined` the reviver returns deletes nothing
/// more. Re-added with its parsed value it keeps its source; with another
/// value it loses it.
#[test]
fn a_sibling_deleted_mid_walk_is_visited_as_undefined() {
    for (json, mutate, expected) in [
        (
            "[1,2,3]",
            "delete this[1];",
            "[1,null,3] | 0=1:1 1=undefined:- 2=3:3 =[1,null,3]:-",
        ),
        (
            r#"{"0":1,"1":2,"2":3}"#,
            "delete this[1];",
            r#"{"0":1,"2":3} | 0=1:1 1=undefined:- 2=3:3 ={"0":1,"2":3}:-"#,
        ),
        (
            r#"{"0":1,"1":2,"2":3}"#,
            "delete this[1]; this[1] = 2;",
            r#"{"0":1,"1":2,"2":3} | 0=1:1 1=2:2 2=3:3 ={"0":1,"1":2,"2":3}:-"#,
        ),
        (
            r#"{"0":1,"1":2,"2":3}"#,
            "delete this[1]; this[1] = 5;",
            r#"{"0":1,"1":5,"2":3} | 0=1:1 1=5:- 2=3:3 ={"0":1,"1":5,"2":3}:-"#,
        ),
    ] {
        assert_result(&mutating_walk(json, mutate, "val"), expected);
    }
}

/// A sibling made non-configurable and read-only before its turn refuses the
/// write-back silently: a replacement value is dropped, and an `undefined`
/// cannot delete it, so it is the one key left on the holder.
#[test]
fn a_sibling_made_read_only_mid_walk_keeps_its_value() {
    let freeze_one = "Object.defineProperty(this, '1', { value: 2, writable: false, \
         enumerable: true, configurable: false });";
    assert_result(
        &mutating_walk("[1,2,3]", freeze_one, "k === '1' ? 'changed' : val"),
        "[1,2,3] | 0=1:1 1=2:2 2=3:3 =[1,2,3]:-",
    );
    assert_result(
        &mutating_walk(
            r#"{"0":1,"1":2}"#,
            freeze_one,
            "k === '1' ? 'changed' : val",
        ),
        r#"{"0":1,"1":2} | 0=1:1 1=2:2 ={"0":1,"1":2}:-"#,
    );
    assert_result(
        &mutating_walk(r#"{"0":1,"1":2}"#, freeze_one, "undefined"),
        r#"undefined | 0=1:1 1=2:2 ={"1":2}:-"#,
    );
}

/// A sibling promoted to an accessor and turned back into data with its
/// parsed value before its turn keeps its source, as does one redefined
/// non-enumerable: the snapshot still lists it.
#[test]
fn a_sibling_redefined_and_restored_mid_walk_keeps_its_source() {
    assert_result(
        &mutating_walk(
            r#"{"0":1,"1":2,"9":9}"#,
            "Object.defineProperty(this, '1', { get: function () { return 22; }, \
                 enumerable: true, configurable: true }); \
             Object.defineProperty(this, '1', { value: 2, writable: true, enumerable: true, \
                 configurable: true });",
            "val",
        ),
        r#"{"0":1,"1":2,"9":9} | 0=1:1 1=2:2 9=9:9 ={"0":1,"1":2,"9":9}:-"#,
    );
    assert_result(
        &mutating_walk(
            r#"{"0":1,"1":2,"2":3}"#,
            "Object.defineProperty(this, '1', { value: 2, writable: true, enumerable: false, \
                 configurable: true });",
            "val",
        ),
        r#"{"0":1,"1":2,"2":3} | 0=1:1 1=2:2 2=3:3 ={"0":1,"1":2,"2":3}:-"#,
    );
}

/// In a nested holder, object or Array, a sibling replaced by a
/// non-enumerable getter is read through the getter and written back as an
/// ordinary enumerable data property, so the parent sees it.
#[test]
fn a_nested_sibling_replaced_by_a_hidden_getter_is_written_back() {
    let hide_one = "Object.defineProperty(this, '1', { get: function () { return 'g'; }, \
         enumerable: false, configurable: true });";
    assert_result(
        &mutating_walk(r#"{"a":{"0":1,"1":2}}"#, hide_one, "val"),
        r#"{"a":{"0":1,"1":"g"}} | 0=1:1 1="g":- a={"0":1,"1":"g"}:- ={"a":{"0":1,"1":"g"}}:-"#,
    );
    assert_result(
        &mutating_walk(r#"{"a":[1,2]}"#, hide_one, "val"),
        r#"{"a":[1,"g"]} | 0=1:1 1="g":- a=[1,"g"]:- ={"a":[1,"g"]}:-"#,
    );
}
