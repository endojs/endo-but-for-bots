use ironhorse_compile::{compile, LexError, LexErrorKind, ParseError, ParseErrorKind};

#[test]
fn lexer_diagnostics_have_bare_messages_and_one_display_location() {
    for (source, message, line) in [
        ("0x", "invalid number", 1),
        ("\n\n0x", "invalid number", 3),
        ("/*", "end of file in comment", 1),
        ("'a\nb'", "end of line in string", 1),
        ("\n'a\rb'", "end of line in string", 2),
        ("\n'a\r\nb'", "end of line in string", 2),
        ("`a\nb`; 0x", "invalid number", 2),
        ("`a\r\nb`; 0x", "invalid number", 2),
        ("'a\\\nb'; 0x", "invalid number", 2),
        ("'a\\\r\nb'; 0x", "invalid number", 2),
    ] {
        let error = compile(source).unwrap_err();
        assert!(matches!(error.kind, ParseErrorKind::Lex(_)), "{source:?}");
        assert_eq!(error.line, line, "{source:?}");
        assert_eq!(error.message, message, "{source:?}");
        assert_eq!(error.to_string(), format!("line {line}: {message}"));
    }
}

#[test]
fn kind_formatting_preserves_values_and_meter_classification() {
    for (kind, message) in [
        (LexErrorKind::InvalidCharacter(123), "invalid character 123"),
        (
            LexErrorKind::UnexpectedCharacter(456),
            "invalid character 456",
        ),
        (LexErrorKind::MeterLimit, "compilation meter limit"),
    ] {
        assert_eq!(kind.to_string(), message);
        let lexical = LexError { line: 7, kind };
        assert_eq!(lexical.to_string(), format!("line 7: {message}"));
        let parser = ParseError::from(lexical.clone());
        assert_eq!(parser.message, message);
        if lexical.kind == LexErrorKind::MeterLimit {
            assert_eq!(parser.kind, ParseErrorKind::MeterLimit);
        } else {
            assert_eq!(parser.kind, ParseErrorKind::Lex(lexical));
        }
    }
}
