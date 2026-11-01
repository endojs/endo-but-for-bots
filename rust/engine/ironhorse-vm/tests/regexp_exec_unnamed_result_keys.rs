//! `RegExpBuiltinExec` defines `index`, `input` and `groups` on every match
//! result, and `indices` (with its own `groups`) under the `d` flag, whether
//! or not the program's source spells those names.
//!
//! Link assigns the result-property ids only for names the program mentions,
//! so a program that reaches them reflectively (`Object.keys`, a computed key,
//! test262's `verifyProperty(indices, 'groups', …)`) found them missing: exec
//! skipped the store because it had no id to store under. Exec now seeds the
//! ids itself. test262 row:
//! `built-ins/RegExp/match-indices/indices-groups-object-undefined.js`.
//!
//! Every expected value below was measured on the XS oracle.

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

#[test]
fn the_result_lists_its_standard_keys_unnamed_in_source() {
    assert_result(
        "Object.getOwnPropertyNames(/./d.exec('a')).join()",
        "0,length,index,input,groups,indices",
    );
}

#[test]
fn the_indices_array_has_an_own_undefined_groups() {
    assert_result(
        "var i = /./d.exec('a')['ind' + 'ices']; \
         var d = Object.getOwnPropertyDescriptor(i, 'gro' + 'ups'); \
         [Object.keys(i).join(), d.value === undefined, d.writable, d.enumerable, d.configurable].join()",
        "0,groups,true,true,true,true",
    );
}

#[test]
fn a_plain_exec_reads_index_and_input_by_computed_key() {
    assert_result(
        "var r = /b/.exec('abc'); [r['ind' + 'ex'], r['in' + 'put'], 'gro' + 'ups' in r].join()",
        "1,abc,true",
    );
}
