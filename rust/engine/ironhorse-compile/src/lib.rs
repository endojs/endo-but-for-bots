//! `ironhorse-compile` — the oracle-locked transliteration of the XS
//! compiler (design `designs/ironhorse-engine.md` § roadmap row 5).
//!
//! Stage 5 of the XS→Rust port replaces the differential-oracle compiler
//! with a pure-Rust one built in the shape of XS: lexer → parser →
//! scoper → coder, held to a **byte-identical-bytecode** bar against
//! XS on the conformance corpus. This crate is that pipeline; child 1
//! lands the first stratum, the **lexer** ([`lexer`], [`token`]), plus
//! the deterministic parse meter ([`meter`]) threaded from the first
//! token and the structured error surface ([`error`]) the fuzz target
//! will lean on.
//!
//! Everything here is `#![forbid(unsafe_code)]`, like every engine crate
//! except the audited `xs-oracle` FFI seam.

#![forbid(unsafe_code)]

pub mod ast;
pub mod coder;
pub mod error;
pub mod lexer;
pub mod meter;
pub mod opcodes;
pub mod parser;
pub mod scoper;
pub mod token;
pub mod token_flags;
/// Unicode `ID_Start` / `ID_Continue` classification. The single source
/// of truth lives in the leaf `ironhorse-regexp` crate (the regexp
/// group-name validator needs the same tables), re-exported here so the
/// lexer's `crate::unicode` path is unchanged.
pub use ironhorse_regexp::unicode;

pub use ast::{Item, Node, TREE_DEPTH_LIMIT};
pub use coder::{
    compile, compile_atoms, compile_atoms_goal, compile_atoms_with, compile_module,
    compile_module_atoms, compile_with, declares_top_level_var_or_function,
    script_goal_deviates,
};
pub use error::{LexError, LexErrorKind};
pub use lexer::{BigIntLiteral, Lexeme, Lexer};
pub use meter::ParseMeter;
pub use parser::{
    ParseError, ParseErrorKind, Parser, CASCADE_COST, OPERAND_COST, PARSER_STACK_BUDGET,
    STATEMENT_COST,
};
pub use scoper::{scope_module, scope_program, Goal, ScopeTree};
pub use token::Token;

/// Parse `source` as a Script and return the whole-parse **parse-meter
/// computrons** ([`meter::ParseMeter::computrons`]) on success, or `None`
/// if it does not parse. This is ironhorse's own release-versioned parse cost
/// ([`meter::PARSE_METER_RELEASE`]), the figure the parse-metering
/// determinism bar locks: deterministic per build for a given source
/// (design § Metering; the accuracy-over-parity doctrine). The `strict`
/// argument mirrors [`compile_with`]'s Script strictness.
pub fn parse_computrons(source: &str, strict: bool) -> Option<u64> {
    let mut parser = Parser::new(source, strict, false).ok()?;
    parser.parse_program(strict).ok()?;
    Some(parser.meter().computrons())
}

/// Scan `source` to completion, returning every [`Lexeme`] up to and
/// including [`Token::Eof`]. A convenience over driving [`Lexer::next`];
/// the parser drives the lexer pull-style (with template/regexp
/// re-entry), so this is primarily for tests and tooling.
pub fn tokenize(source: &str) -> Result<Vec<Lexeme>, LexError> {
    let mut lexer = Lexer::new(source);
    let mut out = Vec::new();
    loop {
        let lexeme = lexer.next()?;
        let eof = lexeme.token == Token::Eof;
        out.push(lexeme);
        if eof {
            break;
        }
    }
    Ok(out)
}
