//! StringToNumber, `parseInt` and `parseFloat` skip every WhiteSpace and
//! LineTerminator code point (ES2024 7.1.4.1.1), not only the ASCII ones
//! (ledger F100); XS's `fxSkipSpaces` and V8 agree. U+180E is not
//! whitespace.

use ironhorse_262::dual_run;

const SPACES: &[&str] = &[
    "\\t", "\\n", "\\v", "\\f", "\\r", " ", "\\u00a0", "\\ufeff", "\\u1680", "\\u2000", "\\u2005",
    "\\u200a", "\\u2028", "\\u2029", "\\u202f", "\\u205f", "\\u3000", "\\u180e", "\\u200b",
    "\\u0085",
];

#[test]
fn every_whitespace_code_point_is_skipped_around_a_number() {
    for space in SPACES {
        let run = dual_run(&format!(
            "var s = '{space}'; [parseInt(s + '12'), parseInt(s + s + '0x1f'), parseFloat(s + '1.5e1'), \
             Number(s + '7' + s), Number(s), Number(s + s + '0b11' + s), +(s + 'Infinity'), \
             Number('1' + s + '1'), parseFloat(s + '-.5' + s + 'x'), Number(s + '-0') === 0, \
             1 / Number(s + '-0')].join()"
        ))
        .expect("the XS oracle machine must start");
        assert!(run.observables_agree(), "{space}: {run:?}");
    }
}
