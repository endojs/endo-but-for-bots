//! Pure-Rust JavaScript compiler: lexer, parser, scoper and coder.
//!
//! [`compile_atoms`] emits bytecode and a CESU-8 symbol atom for the VM.
//! Budgeted entry points charge source admission and incremental compiler work;
//! [`meter::PARSE_METER_RELEASE`] aliases the shared runtime meter release.
//! The private budget-stop unwind requires `panic=unwind`; unrelated panics propagate.
//!
//! The compilation pipeline is lexer → parser → scoper → coder.
//! Its top-level re-exports are the supported entry points and data types.
//! The parser, opcode definitions, and parse meter also remain available by
//! module path for compiler tooling and conformance harnesses.
//! Internal passes use the shared identifier tables directly from
//! `ironhorse-regexp`; this crate does not expose that dependency's module.
//!
//! The byte-identity reference is XS pin `23b4d6b0a65f` built on x86_64
//! with signed plain C `char`. XS hashes symbol spellings through `char*`,
//! so an unsigned-char build can assign different symbol IDs for non-ASCII
//! names. Ironhorse always hashes CESU-8 bytes with signed-byte promotion,
//! independently of host architecture; it does not adopt the host C ABI.
//!
//! Byte identity against the pinned XS compiler is tested on named corpora, not
//! implied for every input by this crate's existence. The default build is oracle-free;
//! the optional oracle integration supplies differential tests.
//! See `rust/engine/ARCHITECTURE.md` for the SourceCompiler seam and
//! `rust/engine/README.md` for the current acceptance status.
//! This crate forbids unsafe Rust.

#![forbid(unsafe_code)]

#[cfg(panic = "abort")]
compile_error!("ironhorse-compile requires panic=unwind to contain budget refusal");

pub(crate) mod ast;
pub(crate) mod coder;
pub(crate) mod error;
pub(crate) mod lexer;
pub mod meter;
pub mod opcodes;
pub mod parser;
pub(crate) mod scoper;
pub(crate) mod token;
pub(crate) mod token_flags;
pub use ast::{Item, Node, Value, TREE_DEPTH_LIMIT};
pub use coder::{
    compile, compile_atoms, compile_atoms_budgeted, compile_atoms_budgeted_with_limit,
    compile_atoms_goal, compile_atoms_goal_with_meter, compile_atoms_with,
    compile_atoms_with_budget, compile_atoms_with_meter, compile_module, compile_module_atoms,
    compile_with, declares_top_level_var_or_function, script_goal_deviates, CompileError,
    CompileReport, CompiledAtoms,
};
pub use error::{LexError, LexErrorKind};
pub use lexer::{BigIntLiteral, Lexeme, Lexer};
pub use meter::ParseMeter;
pub use parser::{
    ParseError, ParseErrorKind, Parser, CASCADE_COST, OPERAND_COST, PARSER_STACK_BUDGET,
    STATEMENT_COST,
};
pub use scoper::{
    scope_module, scope_program, AccessRecord, Declare, DefineEntry, ExportSpec, Goal, ImportSpec,
    MemberAccess, Scope, ScopeTree, Sym,
};
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
