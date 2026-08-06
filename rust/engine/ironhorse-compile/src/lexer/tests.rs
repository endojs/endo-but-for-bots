//! Token-stream fixtures over the lexer's edge surface. Byte-identity is
//! not this child's bar; these pin the *classification and shape* the
//! parser downstream will depend on, and prove no byte sequence panics.

use crate::lexer::Lexer;
use crate::token::Token;
use crate::{tokenize, LexErrorKind};

/// A `&str` as UTF-16 code units — the lexer's cooked/raw string
/// representation, so a fixture can spell an expected value as text.
fn w(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// The token kinds of `source`, dropping the trailing EOF.
fn kinds(source: &str) -> Vec<Token> {
    let mut v: Vec<Token> = tokenize(source).expect("lex ok").into_iter().map(|l| l.token).collect();
    assert_eq!(v.pop(), Some(Token::Eof), "stream ends in EOF");
    v
}

#[test]
fn punctuators_maximal_munch() {
    use Token::*;
    assert_eq!(
        kinds(">>>= >>> >> > < <<= <= => === == = ! != !== ?? ??= ?. ..."),
        vec![
            UnsignedRightShiftAssign,
            UnsignedRightShift,
            SignedRightShift,
            More,
            Less,
            LeftShiftAssign,
            LessEqual,
            Arrow,
            StrictEqual,
            Equal,
            Assign,
            Not,
            NotEqual,
            StrictNotEqual,
            Coalesce,
            CoalesceAssign,
            Chain,
            Spread,
        ]
    );
}

#[test]
fn optional_chain_vs_number() {
    // `?.` is a chain, but `?.5` is question-mark then `.5`.
    assert_eq!(kinds("a?.b"), vec![Token::Identifier, Token::Chain, Token::Identifier]);
    assert_eq!(
        kinds("a?.5"),
        vec![Token::Identifier, Token::QuestionMark, Token::Number]
    );
}

#[test]
fn keywords_and_contextual() {
    assert_eq!(kinds("if else return"), vec![Token::If, Token::Else, Token::Return]);
    // `let` and `static` are keywords only in strict mode.
    assert_eq!(kinds("let static"), vec![Token::Identifier, Token::Identifier]);
    let mut lexer = Lexer::new("let yield await");
    lexer.set_strict(true);
    lexer.set_generator(true);
    lexer.set_async(true);
    let mut got = Vec::new();
    loop {
        let l = lexer.next().unwrap();
        if l.token == Token::Eof {
            break;
        }
        got.push(l.token);
    }
    assert_eq!(got, vec![Token::Let, Token::Yield, Token::Await]);
}

#[test]
fn member_name_after_dot_is_never_keyword() {
    // `a.default` — `default` is a member name, not the keyword.
    assert_eq!(
        kinds("a.default"),
        vec![Token::Identifier, Token::Dot, Token::Identifier]
    );
    assert_eq!(
        kinds("a?.class"),
        vec![Token::Identifier, Token::Chain, Token::Identifier]
    );
}

#[test]
fn escaped_identifier() {
    // `\u{62}` decodes to `b`, with the escaped flag set.
    let toks = tokenize(r"a \u{62}").unwrap();
    assert_eq!(toks[0].token, Token::Identifier);
    assert_eq!(toks[0].symbol.as_deref(), Some("a"));
    assert!(!toks[0].escaped);
    assert_eq!(toks[1].symbol.as_deref(), Some("b"));
    assert!(toks[1].escaped);
    // An escaped keyword still classifies as the keyword (the "escaped
    // keyword" error lives in a later pass, matching XS).
    let t = tokenize(r"\u{69}f").unwrap();
    assert_eq!(t[0].token, Token::If);
    assert!(t[0].escaped);
}

#[test]
fn private_identifier() {
    let toks = tokenize("#field").unwrap();
    assert_eq!(toks[0].token, Token::PrivateIdentifier);
    assert_eq!(toks[0].symbol.as_deref(), Some("#field"));
}

#[test]
fn unicode_identifier_astral() {
    // A supplementary-plane ID_Start (e.g. U+1D400 MATHEMATICAL BOLD A).
    let src = "\u{1D400}x";
    let toks = tokenize(src).unwrap();
    assert_eq!(toks[0].token, Token::Identifier);
    assert_eq!(toks[0].symbol.as_deref(), Some("\u{1D400}x"));
}

#[test]
fn numbers_bases_and_bigint() {
    use Token::*;
    assert_eq!(kinds("0"), vec![Integer]);
    assert_eq!(kinds("42"), vec![Integer]);
    assert_eq!(kinds("3.14"), vec![Number]);
    assert_eq!(kinds("0."), vec![Number]);
    assert_eq!(kinds(".5"), vec![Number]);
    assert_eq!(kinds("1e10"), vec![Number]);
    assert_eq!(kinds("0xFF"), vec![Integer]);
    assert_eq!(kinds("0b1010"), vec![Integer]);
    assert_eq!(kinds("0o777"), vec![Integer]);
    assert_eq!(kinds("1_000"), vec![Integer]);
    assert_eq!(kinds("0xdead_beef"), vec![Number]); // exceeds i32 -> NUMBER
    assert_eq!(kinds("123n"), vec![Bigint]);
    assert_eq!(kinds("0x1fn"), vec![Bigint]);
}

#[test]
fn number_values() {
    let toks = tokenize("0xFF 10 3.5 1e3").unwrap();
    assert_eq!(toks[0].integer, 255);
    assert_eq!(toks[1].integer, 10);
    assert_eq!(toks[2].number, 3.5);
    assert_eq!(toks[3].number, 1000.0);
}

#[test]
fn legacy_octal_sloppy_only() {
    // Sloppy mode: leading-zero octal is a number.
    assert_eq!(kinds("0777"), vec![Token::Integer]);
    assert_eq!(tokenize("0777").unwrap()[0].integer, 511);
    // `08` degrades to decimal 8 (base bumps on the 8).
    assert_eq!(tokenize("08").unwrap()[0].integer, 8);
    // Strict mode: an error, not a panic.
    let mut lexer = Lexer::new("0777");
    lexer.set_strict(true);
    assert!(matches!(
        lexer.next().unwrap_err().kind,
        LexErrorKind::StrictOctal
    ));
}

#[test]
fn separator_errors() {
    // `_1` is NOT here: a leading `_` is an identifier start, not a number.
    for bad in ["1__0", "1_", "0x_1", "1_.0"] {
        assert!(tokenize(bad).is_err(), "{bad} should be an invalid number");
    }
    // `_1` lexes as an identifier.
    assert_eq!(kinds("_1"), vec![Token::Identifier]);
}

#[test]
fn strings_and_escapes() {
    let toks = tokenize(r#" "a\n\t\x41B\u{1F600}" "#).unwrap();
    assert_eq!(toks[0].string.as_deref(), Some(w("a\n\tAB\u{1F600}").as_slice()));
    assert!(toks[0].escaped);
    // Raw keeps the escapes verbatim.
    assert_eq!(toks[0].raw.as_deref(), Some(w(r"a\n\t\x41B\u{1F600}").as_slice()));
}

#[test]
fn string_legacy_octal_escape() {
    // `\101` is 'A' with the legacy flag; `\0` alone is NUL, no flag.
    let toks = tokenize(r#" "\101" "\0" "#).unwrap();
    assert_eq!(toks[0].string.as_deref(), Some(w("A").as_slice()));
    assert!(toks[0].legacy_octal);
    assert_eq!(toks[1].string.as_deref(), Some(w("\0").as_slice()));
    assert!(!toks[1].legacy_octal);
}

#[test]
fn string_surrogate_pair_escape() {
    // Two \u escapes forming a surrogate pair combine into one astral char.
    let toks = tokenize(r#" "😀" "#).unwrap();
    assert_eq!(toks[0].string.as_deref(), Some(w("\u{1F600}").as_slice()));
}

#[test]
fn bad_escape_flags_error_not_panic() {
    // `\x4` (short hex) sets the error flag but still yields a String token.
    let toks = tokenize(r#" "\xZZ" "#).unwrap();
    assert_eq!(toks[0].token, Token::String);
    assert!(toks[0].string_error);
}

#[test]
fn unterminated_string_errors() {
    assert!(matches!(
        tokenize("\"abc").unwrap_err().kind,
        LexErrorKind::UnterminatedString
    ));
    assert!(matches!(
        tokenize("'a\nb'").unwrap_err().kind,
        LexErrorKind::LineTerminatorInString
    ));
}

#[test]
fn template_head_and_parts() {
    // `\`a${` -> TemplateHead, then continue after the substitution.
    let mut lexer = Lexer::new("`a${x}b${y}c`");
    let head = lexer.next().unwrap();
    assert_eq!(head.token, Token::TemplateHead);
    assert_eq!(head.string.as_deref(), Some(w("a").as_slice()));
    let x = lexer.next().unwrap();
    assert_eq!(x.token, Token::Identifier);
    // The parser, having consumed `x` and the `}`, re-enters for the middle.
    let rbrace = lexer.next().unwrap();
    assert_eq!(rbrace.token, Token::RightBrace);
    let middle = lexer.next_template_part().unwrap();
    assert_eq!(middle.token, Token::TemplateMiddle);
    assert_eq!(middle.string.as_deref(), Some(w("b").as_slice()));
    let y = lexer.next().unwrap();
    assert_eq!(y.token, Token::Identifier);
    let rbrace2 = lexer.next().unwrap();
    assert_eq!(rbrace2.token, Token::RightBrace);
    let tail = lexer.next_template_part().unwrap();
    assert_eq!(tail.token, Token::TemplateTail);
    assert_eq!(tail.string.as_deref(), Some(w("c").as_slice()));
}

#[test]
fn plain_template_no_substitution() {
    let toks = tokenize("`hello`").unwrap();
    assert_eq!(toks[0].token, Token::Template);
    assert_eq!(toks[0].string.as_deref(), Some(w("hello").as_slice()));
}

#[test]
fn template_multiline_raw_cooked() {
    // A `\r\n` in a template cooks to `\n` in both raw and cooked; a
    // line continuation `\<newline>` disappears from the cooked value.
    let toks = tokenize("`a\r\nb\\\nc`").unwrap();
    assert_eq!(toks[0].string.as_deref(), Some(w("a\nbc").as_slice()));
}

#[test]
fn regexp_vs_divide() {
    // Standalone, the scanner returns Divide for `/`; the parser decides
    // regexp by re-entering read_regexp when in expression position.
    let mut lexer = Lexer::new("/ab[/]cd/gi");
    let slash = lexer.next().unwrap();
    assert_eq!(slash.token, Token::Divide);
    let re = lexer.read_regexp(false).unwrap();
    assert_eq!(re.token, Token::Regexp);
    assert_eq!(re.string.as_deref(), Some(w("ab[/]cd").as_slice()));
    assert_eq!(re.modifier.as_deref(), Some("gi"));
}

#[test]
fn regexp_after_divide_assign() {
    // `/=.../ ` — the `=` is part of the regexp body, re-inserted.
    let mut lexer = Lexer::new("/=x/g");
    let t = lexer.next().unwrap();
    assert_eq!(t.token, Token::DivideAssign);
    let re = lexer.read_regexp(true).unwrap();
    assert_eq!(re.string.as_deref(), Some(w("=x").as_slice()));
    assert_eq!(re.modifier.as_deref(), Some("g"));
}

#[test]
fn comments_and_asi_newline_flag() {
    // Line and block comments are skipped; the crlf flag records that a
    // newline was crossed before the token that follows.
    let toks = tokenize("a // comment\nb /* c */ c\nd").unwrap();
    let kinds: Vec<_> = toks.iter().map(|t| t.token).collect();
    assert_eq!(
        kinds,
        vec![
            Token::Identifier,
            Token::Identifier,
            Token::Identifier,
            Token::Identifier,
            Token::Eof
        ]
    );
    // `b` follows a newline; `c` on the same line as the block comment end
    // does not; `d` does.
    assert!(toks[1].crlf, "b crossed a newline");
    assert!(!toks[2].crlf, "c did not cross a newline");
    assert!(toks[3].crlf, "d crossed a newline");
}

#[test]
fn line_pragma_resets_line() {
    // `//@line 100` sets the next token's line.
    let toks = tokenize("a\n//@line 100\nb").unwrap();
    assert_eq!(toks[1].token, Token::Identifier);
    assert_eq!(toks[1].line, 100);
}

#[test]
fn line_counting() {
    let toks = tokenize("a\nb\r\nc").unwrap();
    assert_eq!(toks[0].line, 1);
    assert_eq!(toks[1].line, 2);
    assert_eq!(toks[2].line, 3);
}

#[test]
fn host_token_gated() {
    // `@` errors as ordinary JS, is a Host token in host mode.
    assert!(matches!(
        tokenize("@").unwrap_err().kind,
        LexErrorKind::InvalidAtSign
    ));
    let mut lexer = Lexer::new("@");
    lexer.set_host(true);
    assert_eq!(lexer.next().unwrap().token, Token::Host);
}

#[test]
fn parse_meter_advances_per_token() {
    let mut lexer = Lexer::new("a + b");
    let mut count = 0;
    loop {
        let l = lexer.next().unwrap();
        count += 1;
        if l.token == Token::Eof {
            break;
        }
    }
    // a, +, b, EOF = 4 tokens.
    assert_eq!(count, 4);
    assert_eq!(lexer.meter().computrons(), 4);
    assert_eq!(crate::meter::PARSE_METER_RELEASE, "ironhorse-meter-0");
}

#[test]
fn token_ordinals_match_xs_enum() {
    // Spot-check discriminants against the C xsScript.h ordering.
    assert_eq!(Token::NoToken.ordinal(), 0);
    assert_eq!(Token::Access.ordinal(), 1);
    assert_eq!(Token::Eof.ordinal(), 52);
    assert_eq!(Token::Yield.ordinal(), 171);
}

#[test]
fn no_panic_on_arbitrary_bytes() {
    // A light fuzz: the lexer must return Ok or Err, never panic, on any
    // input (child 7 arms the real fuzz target; this is the smoke test).
    let samples = [
        "",
        "\u{0}\u{1}\u{2}",
        "\\",
        "\\u",
        "\\u{",
        "0x",
        "0b",
        "'",
        "`${",
        "/*",
        "//",
        "0xg",
        "..",
        "?",
        "\u{FEFF}\u{2028}\u{2029}",
        "1e",
        "1_",
        "\u{1F600}",
        "'\\",
        "`a${b",
    ];
    for s in samples {
        let _ = super::super::tokenize(s); // must not panic
    }
}
