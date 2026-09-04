//! Oracle-backed coverage for the CESU-8 matcher boundary and ECMAScript's
//! UTF-16 RegExp indices.

use ironhorse_262::{dual_run, Agreement};

fn agrees(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (halt: {:?})",
        run.ironhorse_halt,
    );
    assert!(
        run.result_agrees,
        "`{source}` diverged: oracle={:?} ironhorse={:?}",
        run.oracle_result, run.ironhorse_result,
    );
}

#[test]
fn stateful_matching_reports_utf16_indices() {
    for source in [
        "var s='aéé';var r=/é/g;var a=r.exec(s);var b=r.exec(s);a.index+':'+b.index+':'+r.lastIndex",
        "var s='\\0é';var r=/é/g;var m=r.exec(s);m.index+':'+r.lastIndex",
        "var s=String.fromCodePoint(0x1F600)+'x';var r=/./gu;var a=r.exec(s);var b=r.exec(s);a[0].length+':'+a.index+':'+b.index+':'+r.lastIndex",
        "var s=String.fromCodePoint(0x1F600);var r=/./g;var a=r.exec(s);var b=r.exec(s);a[0].charCodeAt(0)+':'+b[0].charCodeAt(0)+':'+r.lastIndex",
        "var r=/é/y;r.lastIndex=1;var m=r.exec('aéx');m.index+':'+r.lastIndex",
        "var r=/é/g;r.lastIndex=9;var m=r.exec('aé');(m===null)+':'+r.lastIndex",
        "var s=String.fromCodePoint(0x1F600)+'é';s.search(/é/)",
        "var s=String.fromCodePoint(0x1F600)+'é';/(?<=😀)é/u.exec(s).index",
    ] {
        agrees(source);
    }
}

#[test]
fn unicode_last_index_inside_a_surrogate_pair_rounds_to_its_start() {
    for flags in ["gu", "yu", "gv", "yv"] {
        let source = format!(
            "var s=String.fromCodePoint(0x1F600);var r=new RegExp('.',\
             '{flags}');r.lastIndex=1;var m=r.exec(s);\
             m[0].charCodeAt(0)+':'+m.index+':'+r.lastIndex"
        );
        let run = dual_run(&source).expect("the XS oracle machine must start");
        assert_eq!(run.agreement, Agreement::BothComplete, "`{source}`");
        assert_eq!(run.ironhorse_result, "55357:0:2", "`{source}`");
        // GetStringIndex maps the UTF-16 index of a trailing surrogate back
        // to the code point's leading boundary. Moddable 8.3.1 instead begins
        // at the trailing surrogate and reports `56832:1:2`.
    }
}

#[test]
fn match_indices_are_utf16_offsets() {
    let cases = [
        (
            "var m=/(é)(.)/du.exec('xé'+String.fromCodePoint(0x1F600));m.index+':'+JSON.stringify(m.indices)",
            "1:[[1,4],[1,2],[2,4]]",
        ),
        (
            "var m=/(.)(.)/d.exec(String.fromCodePoint(0x1F600));JSON.stringify(m.indices)+':'+m[1].charCodeAt(0)+':'+m[2].charCodeAt(0)",
            "[[0,2],[0,1],[1,2]]:55357:56832",
        ),
    ];
    for (source, expected) in cases {
        let run = dual_run(source).expect("the XS oracle machine must start");
        assert_eq!(run.agreement, Agreement::BothComplete);
        assert_eq!(run.ironhorse_result, expected, "`{source}`");
        // Moddable 8.3.1's `d`-flag path mistakenly applies a converted UTF-16
        // start as a byte offset when converting the capture length. It can
        // therefore report an end before its start for a non-ASCII capture.
        // IronHorse follows MakeMatchIndicesIndexPairArray instead.
    }
}

#[test]
fn regexp_split_handles_non_ascii_and_unicode_advance() {
    for source in [
        "JSON.stringify('aébé'.split(/é/))",
        "var s='A'+String.fromCodePoint(0x1F600)+'B';var a=s.split(/(?:)/u);a.length+':'+a[0]+':'+a[1].length+':'+a[2]",
        "var s=String.fromCodePoint(0x1F600);var a=s.split(/(?:)/);a.length+':'+a[0].charCodeAt(0)+':'+a[1].charCodeAt(0)",
        "JSON.stringify('α1β2γ'.split(/(\\d)/))",
    ] {
        agrees(source);
    }
}

#[test]
fn regexp_replace_uses_utf16_positions_and_slices() {
    for source in [
        "'aéé'.replace(/é/g,'Ω')",
        "var s='A'+String.fromCodePoint(0x1F600)+'B';s.replace(/./gu,function(m,p){return '['+p+']'})",
        "var seen=[];var s=String.fromCodePoint(0x1F600);var out=s.replace(/(?:)/gu,function(m,p){seen.push(p);return '-'});out.length+':'+seen.join(',')",
        "var s='é'+String.fromCodePoint(0x1F600);s.replace(/(é)(.)/u,'$2$1').charCodeAt(0)",
        "'αéβ'.replace(/é/,\"<$`|$&|$'>\")",
        "'αéβ'.replace(/(é)/,'[$1]')",
    ] {
        agrees(source);
    }
}

#[test]
fn astral_literal_patterns_work_in_both_modes() {
    for source in [
        "var s=String.fromCodePoint(0x1F600);/😀/.test(s)",
        "var s=String.fromCodePoint(0x1F600);/😀/u.test(s)",
        "var s='x'+String.fromCodePoint(0x1F600);var r=/😀/g;var m=r.exec(s);m.index+':'+r.lastIndex",
        "var s=String.fromCharCode(0xD800);/./.exec(s)[0].charCodeAt(0)",
        "var s=String.fromCharCode(0xDC00);/./u.exec(s)[0].charCodeAt(0)",
        "var s=String.fromCharCode(0xD800);/\\uD800/.test(s)",
    ] {
        agrees(source);
    }
}

#[test]
fn empty_global_matches_advance_by_mode() {
    for source in [
        "var s=String.fromCodePoint(0x1F600);s.match(/(?:)/gu).length",
        "var s=String.fromCodePoint(0x1F600);s.match(/(?:)/g).length",
    ] {
        agrees(source);
    }
}
