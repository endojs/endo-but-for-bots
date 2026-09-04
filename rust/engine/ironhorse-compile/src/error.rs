//! Structured lexer errors. XS reports through `fxReportParserError` /
//! `fxReportMemoryError` (which longjmp out); ironhorse surfaces the same
//! conditions as data so no byte sequence can panic the lexer (the fuzz
//! target in child 7 depends on this — a lex error is a `Result::Err`,
//! never an `unwrap`).

use core::fmt;

/// The line (1-based, as XS counts) a lexing error occurred on, paired
/// with a human-readable message mirroring XS's wording where practical.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LexError {
    /// Source line, matching XS's `parser->states[_].line`.
    pub line: u32,
    /// The condition. Kinds mirror XS's report sites.
    pub kind: LexErrorKind,
}

/// The classified lexing failure. Each corresponds to a
/// `fxReportParserError` / `fxReportMemoryError` site in `xsLexical.c`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LexErrorKind {
    /// A byte sequence that is not a legal UTF-8 lead/continuation as XS
    /// decodes it (`fxGetNextCode`, "invalid character").
    InvalidCharacter(u32),
    /// A `\` escape in identifier position that did not resolve to a
    /// legal identifier code point (`fxGetNextTokenAux` default case).
    InvalidEscape,
    /// A malformed numeric literal: bad separator placement, an
    /// identifier char abutting the number, a legacy-octal `_`/`n`, etc.
    /// (the `fxGetNextNumber*` "invalid number" sites).
    InvalidNumber,
    /// A legacy (leading-zero) octal literal in strict mode.
    StrictOctal,
    /// End of input inside a string literal.
    UnterminatedString,
    /// A raw line terminator inside a non-template string literal.
    LineTerminatorInString,
    /// End of input inside a block comment.
    UnterminatedComment,
    /// End of input inside a regular-expression literal.
    UnterminatedRegExp,
    /// A line terminator inside a regular-expression literal.
    LineTerminatorInRegExp,
    /// A `*` immediately after the opening `/` of a regexp (would open a
    /// comment), per XS's `fxGetNextRegExp` guard.
    InvalidRegExp,
    /// A `@` outside XS's host (`mxCFlag`) mode.
    InvalidAtSign,
    /// A single `\` (or `\` not followed by `.`) where XS expects `\u`.
    UnexpectedCharacter(u32),
    /// A buffer that would overflow XS's fixed scan buffer. Kept for
    /// fidelity with XS's memory-error sites; ironhorse's buffers grow, so
    /// this is not raised in practice.
    Overflow,
}

impl fmt::Display for LexError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        use LexErrorKind::*;
        write!(f, "line {}: ", self.line)?;
        match &self.kind {
            InvalidCharacter(c) => write!(f, "invalid character {}", c),
            InvalidEscape => write!(f, "invalid escape"),
            InvalidNumber => write!(f, "invalid number"),
            StrictOctal => write!(f, "octal number (strict mode)"),
            UnterminatedString => write!(f, "end of file in string"),
            LineTerminatorInString => write!(f, "end of line in string"),
            UnterminatedComment => write!(f, "end of file in comment"),
            UnterminatedRegExp => write!(f, "end of file in regular expression"),
            LineTerminatorInRegExp => write!(f, "end of line in regular expression"),
            InvalidRegExp => write!(f, "invalid regular expression"),
            InvalidAtSign => write!(f, "invalid character @"),
            UnexpectedCharacter(c) => write!(f, "invalid character {}", c),
            Overflow => write!(f, "buffer overflow"),
        }
    }
}

impl std::error::Error for LexError {}
