//! The statement / declaration grammar — the second half of the parser
//! (stage-5 child 3), a transliteration of the statement, binding,
//! function, class, and module productions in `xsSyntaxical.c` at the
//! oracle pin. It builds directly on the expression grammar in the parent
//! module ([`super`]); the node stack, token window, and mode-flag
//! discipline are shared.
//!
//! Scope: program / module goals with directive prologue and strict-mode
//! propagation; blocks, `var`/`let`/`const`, expression statements, `if`,
//! every loop form (`for`, `for-in`, `for-of`, `for await-of`, `while`,
//! `do`), `switch`, labels, `break`/`continue`, `return`, `throw`,
//! `try`/`catch`/`finally`, `with`, `debugger`, the empty statement;
//! function / generator declarations and expressions (plain / async);
//! arrow functions (single-identifier and the group cover reparse);
//! the destructuring binding subsystem (`fxBinding` and the
//! `…FromExpression` cover conversions); classes; and `import` / `export`
//! in every form the pin supports.
//!
//! Two deliberate folds, documented for the coder child (byte-identity is
//! its bar, not this child's):
//!   * `using` / `await using` declarations — the pin builds with
//!     `mxExplicitResourceManagement == 0`, so the oracle rejects them and
//!     we do too; the productions are omitted.
//!   * the class field / static-block → init-function surgery
//!     (`fxClassExpression`'s second half) rearranges parsed members into
//!     synthesized `constructorInit` / `instanceInit` function bodies via
//!     C pointer aliasing. We parse every member faithfully (identical
//!     early errors and token consumption) and keep them in the class
//!     `items` list in source order, leaving the init slots null; the
//!     desugaring moves to the coder.

use crate::ast::{flags, Item, Node, Value};
use crate::parser::{ParseError, Parser};
use crate::token::{classify_word, Token};
use crate::token_flags::{has_flag, BEGIN_BINDING, BEGIN_EXPRESSION, BEGIN_STATEMENT, END_STATEMENT, IDENTIFIER_NAME};

type PResult<T> = Result<T, ParseError>;

/// The token of an `Item` if it is a real node, else `None`.
fn item_token(item: &Item) -> Option<Token> {
    match item {
        Item::Node(n) => Some(n.token),
        _ => None,
    }
}

impl Parser {
    // ================= entry points =================

    /// Parse a whole **Script** (`fxProgram`), returning the `Program`
    /// node. `strict` seeds `mxStrictFlag` (e.g. an indirect eval already
    /// in strict context); a `"use strict"` prologue upgrades it.
    pub fn parse_program(&mut self, strict: bool) -> PResult<Item> {
        if strict {
            self.flags |= flags::STRICT;
        }
        self.flags |= flags::PROGRAM;
        self.program()?;
        self.expect_eof()?;
        Ok(self.pop())
    }

    /// Parse a whole **Module** (`fxModule`), returning the `Module` node.
    /// A module is always strict and async at top level.
    pub fn parse_module(&mut self) -> PResult<Item> {
        self.flags |= flags::STRICT | flags::ASYNC;
        self.module_program()?;
        self.expect_eof()?;
        Ok(self.pop())
    }

    // ================= program / module / body =================

    /// `fxProgram`.
    fn program(&mut self) -> PResult<()> {
        let count0 = self.stack.len();
        let line = self.cur.line;
        // Directive prologue: parse statements while each is a string
        // directive; `"use strict"` flips strict mode.
        while self.cur.token != Token::Eof {
            self.statement(-1)?;
            if !self.consume_directive()? {
                break;
            }
        }
        while self.cur.token != Token::Eof {
            self.statement(-1)?;
        }
        let count = self.stack.len() - count0;
        self.wrap_statements(count, line)?;
        self.push_node_struct(1, Token::Program, line)?;
        let root_flags = self.flags & flags::STRICT;
        self.set_root_flags(root_flags);
        Ok(())
    }

    /// `fxModule` — the module top level (goal-sensitive: `import` /
    /// `export` declarations, otherwise ordinary statements, with
    /// top-level `return` / `yield` rejected).
    fn module_program(&mut self) -> PResult<()> {
        let count0 = self.stack.len();
        let line = self.cur.line;
        while self.cur.token != Token::Eof {
            match self.cur.token {
                Token::Export => self.export_declaration()?,
                Token::Import => {
                    self.look_ahead_once()?;
                    let ahead = self.ahead_token();
                    if ahead == Token::Dot || ahead == Token::LeftParenthesis {
                        self.statement(1)?;
                    } else {
                        self.import_declaration()?;
                    }
                }
                Token::Return => {
                    let e = self.error("invalid return");
                    return Err(e);
                }
                Token::Yield => {
                    let e = self.error("invalid yield");
                    return Err(e);
                }
                _ => self.statement(1)?,
            }
        }
        let count = self.stack.len() - count0;
        self.wrap_statements(count, line)?;
        self.push_node_struct(1, Token::Module, line)?;
        let root_flags = self.flags & (flags::STRICT | flags::AWAITING);
        self.set_root_flags(root_flags);
        Ok(())
    }

    /// `fxBody` — a function body: statements with a directive prologue,
    /// leaving a single body-content node (a `Statements`, a lone
    /// statement, or a `Statement(Undefined)`) on the stack.
    fn body(&mut self) -> PResult<()> {
        let count0 = self.stack.len();
        let line = self.cur.line;
        while self.cur.token != Token::Eof && self.cur.token != Token::RightBrace {
            self.statement(1)?;
            if !self.consume_directive()? {
                break;
            }
        }
        while self.cur.token != Token::Eof && self.cur.token != Token::RightBrace {
            self.statement(1)?;
        }
        let count = self.stack.len() - count0;
        self.wrap_body(count, line)?;
        Ok(())
    }

    /// `fxStatements` — a `{ … }` interior: always wrapped in a
    /// `Statements` node (even for zero or one statement).
    fn statements(&mut self) -> PResult<()> {
        let count0 = self.stack.len();
        let line = self.cur.line;
        while self.cur.token != Token::Eof && self.cur.token != Token::RightBrace {
            self.statement(1)?;
        }
        let count = self.stack.len() - count0;
        self.push_node_list(count)?;
        self.push_node_struct(1, Token::Statements, line)?;
        Ok(())
    }

    /// `fxBlock` — `{ statements }` → `Block`.
    fn block(&mut self) -> PResult<()> {
        let line = self.cur.line;
        self.match_token(Token::LeftBrace)?;
        self.statements()?;
        self.match_token(Token::RightBrace)?;
        self.push_node_struct(1, Token::Block, line)
    }

    /// The directive-prologue check shared by `fxProgram` / `fxBody`: the
    /// statement just parsed is on the stack top; if it is a
    /// `Statement(String)` that is unescaped `"use strict"`, flip strict
    /// mode. Returns `true` while the prologue continues.
    fn consume_directive(&mut self) -> PResult<bool> {
        let is_use_strict = match self.stack.last() {
            Some(Item::Node(stmt)) if stmt.token == Token::Statement => match stmt.children.first() {
                Some(Item::Node(expr)) if expr.token == Token::String => {
                    // `mxStringEscapeFlag` is bit 0 of the String node.
                    let escaped = expr.flags & 1 != 0;
                    !escaped
                        && matches!(&expr.value, Value::Str(s) if crate::ast::units_to_string(s) == "use strict")
                }
                _ => return Ok(false),
            },
            _ => return Ok(false),
        };
        if is_use_strict {
            // `fxBody`: the non-simple-parameter-list check fires on every
            // `"use strict"` directive, INDEPENDENT of whether strict mode is
            // already on — a class/method body is already strict, yet a
            // non-simple parameter list plus a `"use strict"` prologue is
            // still a Syntax Error. (`fxProgram` never sets the flag, so the
            // shared helper stays faithful for the top-level program.)
            if self.flags & flags::NOT_SIMPLE_PARAMETERS != 0 {
                return Err(self.error("invalid directive"));
            }
            if self.flags & flags::STRICT == 0 {
                self.flags |= flags::STRICT;
                if self.cur.token == Token::Identifier {
                    self.check_strict_keyword()?;
                }
            }
        }
        Ok(true)
    }

    /// `fxCheckStrictKeyword` — once strict turns on mid-prologue, an
    /// identifier that is a strict reserved word must be reclassified.
    fn check_strict_keyword(&mut self) -> PResult<()> {
        if let Some(sym) = self.cur.symbol.clone() {
            let t = classify_word(&sym, true, false, false);
            if t != Token::Identifier {
                self.cur.token = t;
            }
        }
        if self.cur.escaped {
            return Err(self.error("escaped keyword"));
        }
        Ok(())
    }

    /// `count>1` → `Statements`; `count==0` → `Statement(Undefined)`;
    /// `count==1` leaves the single statement. (`fxBody` / `fxProgram` /
    /// `fxModule` tail.)
    fn wrap_body(&mut self, count: usize, line: u32) -> PResult<()> {
        if count > 1 {
            self.push_node_list(count)?;
            self.push_node_struct(1, Token::Statements, line)?;
        } else if count == 0 {
            self.push_node_struct(0, Token::Undefined, line)?;
            self.push_node_struct(1, Token::Statement, line)?;
        }
        Ok(())
    }

    /// Same as [`Self::wrap_body`]; named for the program/module tails.
    fn wrap_statements(&mut self, count: usize, line: u32) -> PResult<()> {
        self.wrap_body(count, line)
    }

    // ================= statements =================

    /// `fxStatement`. `block_it` mirrors XS: `1` = a block context (lexical
    /// declarations allowed), `0` = a single-statement slot (loop/if body,
    /// label), `-1` = program/case body.
    pub(crate) fn statement(&mut self, block_it: i32) -> PResult<()> {
        let line = self.cur.line;
        match self.cur.token {
            Token::Semicolon => {
                self.get_next_token()?;
                if block_it == 0 {
                    self.push_node_struct(0, Token::Undefined, line)?;
                    self.push_node_struct(1, Token::Statement, line)?;
                }
            }
            Token::Break => {
                self.break_statement()?;
                self.semicolon()?;
            }
            Token::Continue => {
                self.continue_statement()?;
                self.semicolon()?;
            }
            Token::Debugger => {
                let l = self.cur.line;
                self.match_token(Token::Debugger)?;
                self.push_node_struct(0, Token::Debugger, l)?;
                self.semicolon()?;
            }
            Token::Class => {
                if block_it == 0 {
                    return Err(self.error("no block"));
                }
                let mut symbol = None;
                self.class_expression(line, Some(&mut symbol))?;
                if let Some(sym) = symbol {
                    self.push_symbol(sym);
                    self.push_node_struct(1, Token::Let, line)?;
                    self.swap_nodes();
                    self.push_node_struct(2, Token::Binding, line)?;
                } else {
                    return Err(self.error("missing identifier"));
                }
            }
            Token::Const => {
                if block_it == 0 {
                    return Err(self.error("no block"));
                }
                self.variable_statement(Token::Const)?;
                self.semicolon()?;
            }
            Token::Let => {
                if block_it == 0 {
                    return Err(self.error("no block"));
                }
                self.variable_statement(Token::Let)?;
                self.semicolon()?;
            }
            Token::Var => {
                self.variable_statement(Token::Var)?;
                self.semicolon()?;
            }
            Token::Do => self.do_statement()?,
            Token::For => self.for_statement()?,
            Token::Function => self.function_statement(block_it, 0, line)?,
            Token::If => self.if_statement()?,
            Token::Return => {
                if self.flags & (flags::ARROW | flags::FUNCTION | flags::GENERATOR) == 0 {
                    return Err(self.error("invalid return"));
                }
                self.return_statement()?;
                self.semicolon()?;
            }
            Token::LeftBrace => self.block()?,
            Token::Switch => self.switch_statement()?,
            Token::Throw => {
                self.throw_statement()?;
                self.semicolon()?;
            }
            Token::Try => self.try_statement()?,
            Token::While => self.while_statement()?,
            Token::With => {
                if self.flags & flags::STRICT != 0 {
                    return Err(self.error("with (strict code)"));
                }
                self.with_statement()?;
            }
            Token::Identifier => self.identifier_statement(block_it, line)?,
            _ => self.expression_statement(line)?,
        }
        Ok(())
    }

    /// The `XS_TOKEN_IDENTIFIER` arm of `fxStatement`: labeled statements,
    /// `async function` declarations, and the `let`-as-declaration
    /// disambiguation, else an expression statement.
    fn identifier_statement(&mut self, block_it: i32, line: u32) -> PResult<()> {
        self.look_ahead_once()?;
        if self.ahead_token() == Token::Colon {
            let sym = self.cur.symbol.clone().unwrap_or_default();
            self.push_symbol(sym);
            self.get_next_token()?;
            self.match_token(Token::Colon)?;
            if self.cur.token == Token::Function {
                return Err(self.error("labeled function"));
            }
            self.statement(0)?;
            self.push_node_struct(2, Token::Label, line)?;
            return Ok(());
        }
        let sym = self.cur.symbol.clone().unwrap_or_default();
        let escaped = self.cur.escaped;
        if sym == "async" && !escaped && !self.ahead_crlf() && self.ahead_token() == Token::Function {
            self.get_next_token()?;
            return self.function_statement(block_it, flags::ASYNC, line);
        }
        if sym == "let" && !escaped {
            let ahead = self.ahead_token();
            let ahead_crlf = self.ahead_crlf();
            if (has_flag(ahead, BEGIN_BINDING) || ahead == Token::Await || ahead == Token::Yield)
                && (block_it != 0 || !ahead_crlf || ahead == Token::LeftBracket)
            {
                self.cur.token = Token::Let;
                if block_it == 0 {
                    return Err(self.error("no block"));
                }
                self.variable_statement(Token::Let)?;
                self.semicolon()?;
                return Ok(());
            }
        }
        self.expression_statement(line)
    }

    /// An expression statement (`fxCommaExpression; Statement; ;`).
    fn expression_statement(&mut self, line: u32) -> PResult<()> {
        if has_flag(self.cur.token, BEGIN_EXPRESSION) {
            self.comma_expression()?;
            self.push_node_struct(1, Token::Statement, line)?;
            self.semicolon()
        } else {
            Err(self.error("invalid token"))
        }
    }

    /// A `function` declaration (`again:` target of `fxStatement`), shared
    /// by the plain and `async` (`flag`) forms.
    fn function_statement(&mut self, block_it: i32, flag: u32, line: u32) -> PResult<()> {
        if block_it == 0 {
            return Err(self.error("no block (strict code)"));
        }
        self.match_token(Token::Function)?;
        let mut symbol = None;
        if self.cur.token == Token::Multiply {
            self.get_next_token()?;
            self.generator_expression(line, Some(&mut symbol), flag)?;
        } else {
            self.function_expression(line, Some(&mut symbol), flag)?;
        }
        if let Some(sym) = symbol {
            self.push_define(sym, line);
            Ok(())
        } else {
            Err(self.error("missing identifier"))
        }
    }

    /// `fxSemicolon` — automatic semicolon insertion at a statement end.
    fn semicolon(&mut self) -> PResult<()> {
        if self.cur.crlf || has_flag(self.cur.token, END_STATEMENT) {
            if self.cur.token == Token::Semicolon {
                self.get_next_token()?;
            }
            Ok(())
        } else {
            Err(self.error("missing ;"))
        }
    }

    fn break_statement(&mut self) -> PResult<()> {
        let line = self.cur.line;
        self.match_token(Token::Break)?;
        if !self.cur.crlf && self.cur.token == Token::Identifier {
            let sym = self.cur.symbol.clone().unwrap_or_default();
            self.push_symbol(sym);
            self.get_next_token()?;
        } else {
            self.push_null();
        }
        self.push_node_struct(1, Token::Break, line)
    }

    fn continue_statement(&mut self) -> PResult<()> {
        let line = self.cur.line;
        self.match_token(Token::Continue)?;
        if !self.cur.crlf && self.cur.token == Token::Identifier {
            let sym = self.cur.symbol.clone().unwrap_or_default();
            self.push_symbol(sym);
            self.get_next_token()?;
        } else {
            self.push_null();
        }
        self.push_node_struct(1, Token::Continue, line)
    }

    fn do_statement(&mut self) -> PResult<()> {
        let line = self.cur.line;
        self.push_null();
        self.match_token(Token::Do)?;
        self.statement(0)?;
        self.match_token(Token::While)?;
        self.match_token(Token::LeftParenthesis)?;
        self.comma_expression()?;
        self.match_token(Token::RightParenthesis)?;
        if self.cur.token == Token::Semicolon {
            self.get_next_token()?;
        }
        self.push_node_struct(2, Token::Do, line)?;
        self.push_node_struct(2, Token::Label, line)
    }

    fn if_statement(&mut self) -> PResult<()> {
        let line = self.cur.line;
        self.match_token(Token::If)?;
        self.match_token(Token::LeftParenthesis)?;
        self.comma_expression()?;
        self.match_token(Token::RightParenthesis)?;
        self.statement(0)?;
        if self.cur.token == Token::Else {
            self.match_token(Token::Else)?;
            self.statement(0)?;
        } else {
            self.push_null();
        }
        self.push_node_struct(3, Token::If, line)
    }

    fn return_statement(&mut self) -> PResult<()> {
        let line = self.cur.line;
        self.match_token(Token::Return)?;
        if !self.cur.crlf && has_flag(self.cur.token, BEGIN_EXPRESSION) {
            self.comma_expression()?;
        } else {
            self.push_null();
        }
        self.push_node_struct(1, Token::Return, line)
    }

    fn throw_statement(&mut self) -> PResult<()> {
        let line = self.cur.line;
        self.match_token(Token::Throw)?;
        if !self.cur.crlf && has_flag(self.cur.token, BEGIN_EXPRESSION) {
            self.comma_expression()?;
        } else {
            return Err(self.error("missing expression"));
        }
        self.push_node_struct(1, Token::Throw, line)
    }

    fn switch_statement(&mut self) -> PResult<()> {
        let line = self.cur.line;
        let mut count = 0usize;
        let mut default_flag = false;
        self.match_token(Token::Switch)?;
        self.match_token(Token::LeftParenthesis)?;
        self.comma_expression()?;
        self.match_token(Token::RightParenthesis)?;
        self.match_token(Token::LeftBrace)?;
        while self.cur.token == Token::Case || self.cur.token == Token::Default {
            let case_line = self.cur.line;
            if self.cur.token == Token::Case {
                self.match_token(Token::Case)?;
                self.comma_expression()?;
                self.match_token(Token::Colon)?;
            } else {
                self.match_token(Token::Default)?;
                if default_flag {
                    return Err(self.error("invalid default"));
                }
                self.push_null();
                self.match_token(Token::Colon)?;
                default_flag = true;
            }
            let body0 = self.stack.len();
            while has_flag(self.cur.token, BEGIN_STATEMENT) {
                self.statement(-1)?;
            }
            let case_count = self.stack.len() - body0;
            if case_count > 1 {
                self.push_node_list(case_count)?;
                self.push_node_struct(1, Token::Statements, case_line)?;
            } else if case_count == 0 {
                self.push_null();
            }
            self.push_node_struct(2, Token::Case, case_line)?;
            count += 1;
        }
        self.match_token(Token::RightBrace)?;
        self.push_node_list(count)?;
        self.push_node_struct(2, Token::Switch, line)
    }

    fn try_statement(&mut self) -> PResult<()> {
        let line = self.cur.line;
        let mut ok = false;
        self.match_token(Token::Try)?;
        self.block()?;
        if self.cur.token == Token::Catch {
            let catch_line = self.cur.line;
            self.match_token(Token::Catch)?;
            if self.cur.token == Token::LeftParenthesis {
                self.match_token(Token::LeftParenthesis)?;
                self.binding(Token::Let, 1)?;
                self.match_token(Token::RightParenthesis)?;
            } else {
                self.push_null();
            }
            self.match_token(Token::LeftBrace)?;
            self.statements()?;
            self.match_token(Token::RightBrace)?;
            self.push_node_struct(2, Token::Catch, catch_line)?;
            ok = true;
        } else {
            self.push_null();
        }
        if self.cur.token == Token::Finally {
            self.match_token(Token::Finally)?;
            self.block()?;
            ok = true;
        } else {
            self.push_null();
        }
        if !ok {
            return Err(self.error("missing catch or finally"));
        }
        self.push_node_struct(3, Token::Try, line)
    }

    fn while_statement(&mut self) -> PResult<()> {
        let line = self.cur.line;
        self.push_null();
        self.match_token(Token::While)?;
        self.match_token(Token::LeftParenthesis)?;
        self.comma_expression()?;
        self.match_token(Token::RightParenthesis)?;
        self.statement(0)?;
        self.push_node_struct(2, Token::While, line)?;
        self.push_node_struct(2, Token::Label, line)
    }

    fn with_statement(&mut self) -> PResult<()> {
        let line = self.cur.line;
        self.match_token(Token::With)?;
        self.match_token(Token::LeftParenthesis)?;
        self.comma_expression()?;
        self.match_token(Token::RightParenthesis)?;
        self.statement(0)?;
        self.push_node_struct(2, Token::With, line)
    }

    /// `fxVariableStatement` — `var`/`let`/`const` binding list. Leaves the
    /// single binding node, or a `Statements` wrapping several.
    pub(crate) fn variable_statement(&mut self, token: Token) -> PResult<()> {
        let line = self.cur.line;
        let mut comma_flag = false;
        let mut count = 0usize;
        self.match_token(token)?;
        while has_flag(self.cur.token, BEGIN_BINDING) {
            comma_flag = false;
            self.binding(token, 1)?;
            count += 1;
            if self.cur.token == Token::Comma {
                self.flags &= !flags::FOR;
                self.get_next_token()?;
                comma_flag = true;
            } else {
                break;
            }
        }
        if count == 0 || comma_flag {
            self.push_null();
            self.push_null();
            self.push_node_struct(2, token, line)?;
            return Err(self.error("missing identifier"));
        }
        if count > 1 {
            self.push_node_list(count)?;
            self.push_node_struct(1, Token::Statements, line)?;
        }
        Ok(())
    }

    // ================= for =================

    fn for_statement(&mut self) -> PResult<()> {
        let line = self.cur.line;
        let mut await_flag = false;
        let mut expression_flag = false;
        self.push_null();
        self.match_token(Token::For)?;
        if self.cur.token == Token::Await {
            await_flag = true;
            self.match_token(Token::Await)?;
        }
        self.match_token(Token::LeftParenthesis)?;
        self.look_ahead_once()?;
        self.flags |= flags::FOR;
        if self.cur.token == Token::Semicolon {
            self.push_null();
        } else if self.cur.token == Token::Const {
            self.variable_statement(Token::Const)?;
        } else if self.cur.token == Token::Let {
            self.variable_statement(Token::Let)?;
        } else if self.is_keyword("let")? && has_flag(self.ahead_token(), BEGIN_BINDING) {
            self.cur.token = Token::Let;
            self.variable_statement(Token::Let)?;
        } else if self.cur.token == Token::Var {
            self.variable_statement(Token::Var)?;
        } else {
            self.comma_expression()?;
            expression_flag = true;
        }
        self.flags &= !flags::FOR;
        if await_flag && !self.is_keyword("of")? {
            return Err(self.error("invalid for await"));
        }
        if self.cur.token == Token::In || self.is_keyword("of")? {
            if expression_flag {
                if !self.check_reference(Token::Assign)? {
                    return Err(self.error("no reference"));
                }
            } else if self.top_token() == Some(Token::Binding) {
                // A `for (const x = 1 in …)` head — an initializer on the
                // loop binding is an early error.
                return Err(self.error("invalid binding initializer"));
            }
            let a_token = self.cur.token;
            self.get_next_token()?;
            if a_token == Token::In {
                self.comma_expression()?;
            } else {
                self.assignment_expression()?;
            }
            self.match_token(Token::RightParenthesis)?;
            self.statement(0)?;
            if await_flag {
                self.push_node_struct(3, Token::ForAwaitOf, line)?;
                // Mirror (moddable 8.3 `c41a35d165` "for await in module body",
                // xsSyntaxical.c): after pushing the ForAwaitOf node, set
                // `parser->flags |= mxAwaitingFlag` so a top-level `for await`
                // marks the enclosing module body as awaiting. Landed with the
                // oracle bump to 8.3.1 (`23b4d6b0a65f`); the pin (8.2.3) oracle
                // did NOT do this (see rust/engine/README.md § Upstream
                // moddable delta tracking, item 2).
                self.flags |= flags::AWAITING;
            } else if a_token == Token::In {
                self.push_node_struct(3, Token::ForIn, line)?;
            } else {
                self.push_node_struct(3, Token::ForOf, line)?;
            }
        } else {
            if expression_flag {
                self.push_node_struct(1, Token::Statement, line)?;
            }
            self.match_token(Token::Semicolon)?;
            if has_flag(self.cur.token, BEGIN_EXPRESSION) {
                self.comma_expression()?;
            } else {
                self.push_null();
            }
            self.match_token(Token::Semicolon)?;
            if has_flag(self.cur.token, BEGIN_EXPRESSION) {
                self.comma_expression()?;
            } else {
                self.push_null();
            }
            self.match_token(Token::RightParenthesis)?;
            self.statement(0)?;
            self.push_node_struct(4, Token::For, line)?;
        }
        self.push_node_struct(2, Token::Label, line)
    }

    // ================= bindings =================

    /// `fxBinding` — one binding target (identifier / object / array),
    /// optionally with an `= initializer`. `flags_arg & 1` enables the
    /// initializer.
    pub(crate) fn binding(&mut self, token: Token, flags_arg: u32) -> PResult<()> {
        let line = self.cur.line;
        if self.cur.token == Token::Identifier {
            let sym = self.cur.symbol.clone().unwrap_or_default();
            self.check_strict_symbol(&sym)?;
            if (token == Token::Const || token == Token::Let) && sym == "let" {
                return Err(self.error("invalid identifier"));
            }
            self.push_symbol(sym);
            self.push_node_struct(1, token, line)?;
            self.get_next_token()?;
        } else if self.cur.token == Token::LeftBrace {
            self.object_binding(token)?;
        } else if self.cur.token == Token::LeftBracket {
            self.array_binding(token)?;
        } else {
            return Err(self.error("missing identifier"));
        }
        if flags_arg & 1 != 0 && self.cur.token == Token::Assign {
            self.flags &= !flags::FOR;
            self.get_next_token()?;
            self.assignment_expression()?;
            self.push_node_struct(2, Token::Binding, line)?;
        }
        Ok(())
    }

    /// `fxArrayBinding` — `[ a, , ...rest ]` destructuring target.
    fn array_binding(&mut self, token: Token) -> PResult<()> {
        let line = self.cur.line;
        let mut count = 0usize;
        let mut elision = true;
        self.match_token(Token::LeftBracket)?;
        while self.cur.token == Token::Comma || has_flag(self.cur.token, BEGIN_BINDING) {
            let item_line = self.cur.line;
            if self.cur.token == Token::Comma {
                self.get_next_token()?;
                if elision {
                    self.push_node_struct(0, Token::SkipBinding, item_line)?;
                    count += 1;
                } else {
                    elision = true;
                }
            } else {
                if !elision {
                    return Err(self.error("missing ,"));
                }
                if self.cur.token == Token::Spread {
                    self.rest_binding(token, 0)?;
                    count += 1;
                    break;
                }
                self.binding(token, 1)?;
                count += 1;
                elision = false;
            }
        }
        self.match_token(Token::RightBracket)?;
        self.push_node_list(count)?;
        self.push_node_struct(1, Token::ArrayBinding, line)
    }

    /// `fxObjectBinding` — `{ a, b: t, ...rest }` destructuring target.
    fn object_binding(&mut self, token: Token) -> PResult<()> {
        let line = self.cur.line;
        let mut count = 0usize;
        let mut obj_flags = 0u32;
        self.match_token(Token::LeftBrace)?;
        loop {
            let prop_line = self.cur.line;
            if self.cur.token == Token::RightBrace {
                break;
            }
            let mut a_symbol = false;
            let mut a_token = Token::PropertyBinding;
            if has_flag(self.cur.token, IDENTIFIER_NAME) {
                let sym = self.cur.symbol.clone().unwrap_or_default();
                self.push_symbol(sym);
                a_symbol = true;
            } else if self.cur.token == Token::Integer {
                match self.push_property_index_integer(self.cur.integer, prop_line) {
                    None => a_token = Token::PropertyBindingAt,
                    Some(_) => a_symbol = true,
                }
            } else if self.cur.token == Token::Number {
                match self.push_property_index_number(self.cur.number, prop_line) {
                    None => a_token = Token::PropertyBindingAt,
                    Some(_) => a_symbol = true,
                }
            } else if self.cur.token == Token::String {
                let s = crate::ast::units_to_string(&self.cur.string.clone().unwrap_or_default());
                self.push_symbol(s);
                a_symbol = true;
            } else if self.cur.token == Token::LeftBracket {
                self.get_next_token()?;
                self.comma_expression()?;
                if self.cur.token != Token::RightBracket {
                    return Err(self.error("missing ]"));
                }
                a_token = Token::PropertyBindingAt;
            } else if self.cur.token == Token::Spread {
                obj_flags |= flags::SPREAD;
                self.rest_binding(token, 1)?;
                count += 1;
                break;
            } else {
                return Err(self.error("missing identifier"));
            }
            self.look_ahead_once()?;
            if self.ahead_token() == Token::Colon {
                self.get_next_token()?;
                self.get_next_token()?;
                self.binding(token, 1)?;
            } else if a_symbol {
                self.binding(token, 1)?;
            } else {
                return Err(self.error("missing :"));
            }
            self.push_node_struct(2, a_token, prop_line)?;
            count += 1;
            if self.cur.token == Token::RightBrace {
                break;
            }
            if self.cur.token == Token::Comma {
                self.get_next_token()?;
            } else {
                break;
            }
        }
        self.match_token(Token::RightBrace)?;
        self.push_node_list(count)?;
        self.push_node_struct(1, Token::ObjectBinding, line)?;
        self.set_top_flags(obj_flags);
        Ok(())
    }

    /// `fxRestBinding` — `...target` in a destructuring position.
    fn rest_binding(&mut self, token: Token, flag: u32) -> PResult<()> {
        let line = self.cur.line;
        self.match_token(Token::Spread)?;
        self.binding(token, 0)?;
        if flag != 0
            && matches!(self.top_token(), Some(Token::ArrayBinding) | Some(Token::ObjectBinding))
        {
            return Err(self.error("invalid rest"));
        }
        self.push_node_struct(1, Token::RestBinding, line)
    }

    /// `fxParametersBinding` — a function's `( … )` parameter list, as a
    /// `ParamsBinding` node.
    pub(crate) fn parameters_binding(&mut self) -> PResult<()> {
        let line = self.cur.line;
        let mut count = 0usize;
        if self.cur.token == Token::LeftParenthesis {
            self.get_next_token()?;
            while has_flag(self.cur.token, BEGIN_BINDING) {
                if self.cur.token == Token::Spread {
                    self.flags |= flags::NOT_SIMPLE_PARAMETERS;
                    self.rest_binding(Token::Arg, 0)?;
                    count += 1;
                    break;
                }
                self.binding(Token::Arg, 1)?;
                if self.top_token() != Some(Token::Arg) {
                    self.flags |= flags::NOT_SIMPLE_PARAMETERS;
                }
                count += 1;
                if self.cur.token != Token::RightParenthesis {
                    self.match_token(Token::Comma)?;
                }
            }
            self.match_token(Token::RightParenthesis)?;
        } else {
            return Err(self.error("missing ("));
        }
        self.push_node_list(count)?;
        self.push_node_struct(1, Token::ParamsBinding, line)
    }

    // ============ cover-grammar binding conversions ============

    /// `fxBindingFromExpression` — reinterpret an already-parsed
    /// expression node as a binding target of `token`. Returns `None` when
    /// the expression is not a valid target (XS's `SyntaxError` path).
    fn binding_from_expression(&mut self, item: Item, token: Token) -> PResult<Option<Item>> {
        // Unwrap a single-reference `( … )` cover, iterating nested ones.
        let mut item = item;
        loop {
            let inner = match &item {
                Item::Node(n) if n.token == Token::Expressions => match n.children.first() {
                    Some(Item::List(list)) if list.len() == 1 => Some(list[0].clone()),
                    _ => None,
                },
                _ => None,
            };
            let Some(inner) = inner else { break };
            match item_token(&inner) {
                Some(Token::Access) | Some(Token::Member) | Some(Token::MemberAt)
                | Some(Token::PrivateMember) | Some(Token::Undefined) => {
                    item = inner;
                    break;
                }
                Some(Token::Expressions) => {
                    item = inner;
                    continue;
                }
                _ => return Ok(None),
            }
        }
        let tok = match item_token(&item) {
            Some(t) => t,
            None => return Ok(None),
        };
        match tok {
            Token::Binding => {
                let Item::Node(mut node) = item else { unreachable!() };
                let target = std::mem::replace(&mut node.children[0], Item::Null);
                match self.binding_from_expression(target, token)? {
                    Some(b) => node.children[0] = b,
                    None => return Ok(None),
                }
                Ok(Some(Item::Node(node)))
            }
            Token::ArrayBinding | Token::ObjectBinding => {
                let Item::Node(mut node) = item else { unreachable!() };
                if let Some(Item::List(list)) = node.children.get_mut(0) {
                    let items = std::mem::take(list);
                    let mut out = Vec::with_capacity(items.len());
                    for it in items {
                        match self.binding_from_expression(it, token)? {
                            Some(b) => out.push(b),
                            None => return Ok(None),
                        }
                    }
                    node.children[0] = Item::List(out);
                }
                Ok(Some(Item::Node(node)))
            }
            Token::PropertyBinding | Token::PropertyBindingAt | Token::RestBinding => {
                let Item::Node(mut node) = item else { unreachable!() };
                let idx = node.children.len() - 1;
                let inner = std::mem::replace(&mut node.children[idx], Item::Null);
                match self.binding_from_expression(inner, token)? {
                    Some(b) => node.children[idx] = b,
                    None => return Ok(None),
                }
                Ok(Some(Item::Node(node)))
            }
            Token::SkipBinding => Ok(Some(item)),
            Token::Access => {
                if let Item::Node(node) = &item {
                    if let Some(Item::Symbol(s)) = node.children.first() {
                        self.check_strict_symbol(s)?;
                    }
                }
                if token == Token::Access {
                    return Ok(Some(item));
                }
                // Rebuild as a `token` (Arg/Let/…) node over the symbol,
                // stamping inherited flags like `fxPushNodeStruct`.
                let (sym, line) = match &item {
                    Item::Node(node) => {
                        let sym = match node.children.first() {
                            Some(Item::Symbol(s)) => s.clone(),
                            _ => String::new(),
                        };
                        (sym, node.line)
                    }
                    _ => (String::new(), 0),
                };
                Ok(Some(self.new_inherited_node(token, line, vec![Item::Symbol(sym)])))
            }
            Token::Member | Token::MemberAt | Token::PrivateMember | Token::Undefined => Ok(Some(item)),
            Token::Assign => {
                let Item::Node(mut node) = item else { unreachable!() };
                let reference = std::mem::replace(&mut node.children[0], Item::Null);
                let binding = match self.binding_from_expression(reference, token)? {
                    Some(b) => b,
                    None => return Ok(None),
                };
                let value = std::mem::replace(&mut node.children[1], Item::Null);
                node.token = Token::Binding;
                node.children = vec![binding, value];
                Ok(Some(Item::Node(node)))
            }
            Token::Array => self.array_binding_from_expression_node(item, token),
            Token::Object => self.object_binding_from_expression_node(item, token),
            _ => Ok(None),
        }
    }

    /// `fxCheckReference`'s array branch: convert the top-of-stack array
    /// literal into an `ArrayBinding` in place, returning whether it was a
    /// valid destructuring target.
    pub(crate) fn array_binding_from_expression(&mut self, token: Token) -> PResult<bool> {
        let top = self.pop();
        let fallback = top.clone();
        match self.array_binding_from_expression_node(top, token)? {
            Some(b) => {
                self.push(b);
                Ok(true)
            }
            None => {
                self.push(fallback);
                Ok(false)
            }
        }
    }

    /// `fxCheckReference`'s object branch (see
    /// [`Self::array_binding_from_expression`]).
    pub(crate) fn object_binding_from_expression(&mut self, token: Token) -> PResult<bool> {
        let top = self.pop();
        let fallback = top.clone();
        match self.object_binding_from_expression_node(top, token)? {
            Some(b) => {
                self.push(b);
                Ok(true)
            }
            None => {
                self.push(fallback);
                Ok(false)
            }
        }
    }

    /// `fxArrayBindingFromExpression` — the array-literal → `ArrayBinding`
    /// conversion for an owned array `Item`.
    fn array_binding_from_expression_node(&mut self, item: Item, token: Token) -> PResult<Option<Item>> {
        let Item::Node(node) = item else { return Ok(None) };
        let line = node.line;
        let elision = node.flags & flags::ELISION != 0;
        let Some(Item::List(items)) = node.children.into_iter().next() else { return Ok(None) };
        let n = items.len();
        let mut out = Vec::with_capacity(n);
        for (i, it) in items.into_iter().enumerate() {
            match item_token(&it) {
                None => return Ok(None),
                Some(Token::Spread) => {
                    if elision {
                        return Ok(None);
                    }
                    let has_next = i + 1 < n;
                    match self.rest_binding_from_expression(it, token, 0, has_next)? {
                        Some(b) => out.push(b),
                        None => return Ok(None),
                    }
                    break;
                }
                Some(Token::Elision) => {
                    if let Item::Node(mut e) = it {
                        e.token = Token::SkipBinding;
                        out.push(Item::Node(e));
                    }
                }
                _ => match self.binding_from_expression(it, token)? {
                    Some(b) => out.push(b),
                    None => return Ok(None),
                },
            }
        }
        Ok(Some(self.new_inherited_node(Token::ArrayBinding, line, vec![Item::List(out)])))
    }

    /// `fxObjectBindingFromExpression`.
    fn object_binding_from_expression_node(&mut self, item: Item, token: Token) -> PResult<Option<Item>> {
        let Item::Node(node) = item else { return Ok(None) };
        let line = node.line;
        let Some(Item::List(props)) = node.children.into_iter().next() else { return Ok(None) };
        let n = props.len();
        let mut out = Vec::with_capacity(n);
        let mut obj_flags = 0u32;
        for (i, prop) in props.into_iter().enumerate() {
            match item_token(&prop) {
                None => return Ok(None),
                Some(Token::Property) => {
                    let Item::Node(mut p) = prop else { unreachable!() };
                    let value = std::mem::replace(&mut p.children[1], Item::Null);
                    let binding = match self.binding_from_expression(value, token)? {
                        Some(b) => b,
                        None => return Ok(None),
                    };
                    p.token = Token::PropertyBinding;
                    p.children[1] = binding;
                    out.push(Item::Node(p));
                }
                Some(Token::PropertyAt) => {
                    let Item::Node(mut p) = prop else { unreachable!() };
                    let value = std::mem::replace(&mut p.children[1], Item::Null);
                    let binding = match self.binding_from_expression(value, token)? {
                        Some(b) => b,
                        None => return Ok(None),
                    };
                    p.token = Token::PropertyBindingAt;
                    p.children[1] = binding;
                    out.push(Item::Node(p));
                }
                Some(Token::Spread) => {
                    let has_next = i + 1 < n;
                    match self.rest_binding_from_expression(prop, token, 1, has_next)? {
                        Some(b) => out.push(b),
                        None => return Ok(None),
                    }
                    obj_flags |= flags::SPREAD;
                    break;
                }
                _ => out.push(prop),
            }
        }
        let mut result = self.new_inherited_node(Token::ObjectBinding, line, vec![Item::List(out)]);
        if let Item::Node(n) = &mut result {
            n.flags |= obj_flags;
        }
        Ok(Some(result))
    }

    /// `fxParametersBindingFromExpressions` — reparse the top-of-stack
    /// `Expressions`/`Params` cover as a `ParamsBinding`. Returns `false`
    /// on an invalid parameter list.
    pub(crate) fn parameters_binding_from_expressions(&mut self) -> PResult<bool> {
        let top = self.pop();
        let Item::Node(mut node) = top else {
            self.push(Item::Null);
            return Ok(false);
        };
        let items = match node.children.get_mut(0) {
            Some(Item::List(list)) => std::mem::take(list),
            _ => Vec::new(),
        };
        let n = items.len();
        let mut out = Vec::with_capacity(n);
        for (i, it) in items.into_iter().enumerate() {
            if item_token(&it) == Some(Token::Spread) {
                let has_next = i + 1 < n;
                match self.rest_binding_from_expression(it, Token::Arg, 0, has_next)? {
                    Some(b) => out.push(b),
                    None => return Ok(false),
                }
                self.flags |= flags::NOT_SIMPLE_PARAMETERS;
                break;
            }
            match self.binding_from_expression(it, Token::Arg)? {
                Some(b) => {
                    if item_token(&b) != Some(Token::Arg) {
                        self.flags |= flags::NOT_SIMPLE_PARAMETERS;
                    }
                    out.push(b);
                }
                None => return Ok(false),
            }
        }
        node.token = Token::ParamsBinding;
        node.children[0] = Item::List(out);
        self.push(Item::Node(node));
        Ok(true)
    }

    /// `fxRestBindingFromExpression` — a spread element → `RestBinding`.
    fn rest_binding_from_expression(&mut self, item: Item, token: Token, flag: u32, has_next: bool) -> PResult<Option<Item>> {
        if has_next {
            return Ok(None);
        }
        let Item::Node(node) = item else { return Ok(None) };
        let line = node.line;
        let expr = match node.children.into_iter().next() {
            Some(e) => e,
            None => return Ok(None),
        };
        let binding = match self.binding_from_expression(expr, token)? {
            Some(b) => b,
            None => return Ok(None),
        };
        match item_token(&binding) {
            Some(Token::Binding) => return Err(self.error("invalid rest")),
            Some(Token::ArrayBinding) | Some(Token::ObjectBinding) if flag != 0 => {
                return Err(self.error("invalid rest"));
            }
            _ => {}
        }
        Ok(Some(self.new_inherited_node(Token::RestBinding, line, vec![binding])))
    }

    // ============ strict-binding early errors ============

    /// `fxCheckStrictBinding` over the top-of-stack node.
    pub(crate) fn check_strict_binding_top(&mut self) {
        if let Some(item) = self.stack.last().cloned() {
            let _ = self.check_strict_binding(&item);
        }
    }

    fn check_strict_binding(&mut self, item: &Item) -> PResult<()> {
        let Item::Node(node) = item else { return Ok(()) };
        match node.token {
            Token::Access | Token::Arg | Token::Const | Token::Let | Token::Using | Token::Var => {
                if let Some(Item::Symbol(s)) = node.children.first() {
                    self.check_strict_symbol(s)?;
                }
            }
            Token::Binding => {
                if let Some(child) = node.children.first() {
                    self.check_strict_binding(child)?;
                }
            }
            Token::ArrayBinding | Token::ObjectBinding | Token::ParamsBinding => {
                if let Some(Item::List(list)) = node.children.first() {
                    for child in list.clone() {
                        self.check_strict_binding(&child)?;
                    }
                }
            }
            Token::PropertyBinding | Token::PropertyBindingAt | Token::RestBinding => {
                if let Some(child) = node.children.last() {
                    self.check_strict_binding(child)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    // ================= functions =================

    /// `fxFunctionExpression`.
    pub(crate) fn function_expression(&mut self, line: u32, symbol_out: Option<&mut Option<String>>, flag: u32) -> PResult<()> {
        let saved = self.flags;
        self.flags = (saved & (flags::PARSER_FLAGS | flags::STRICT)) | flags::FUNCTION | flags::TARGET | flag;
        let want_symbol = symbol_out.is_some();
        let name = self.function_name(saved, want_symbol, symbol_out)?;
        self.parameters_binding()?;
        self.match_token(Token::LeftBrace)?;
        self.body()?;
        self.push_node_struct(1, Token::Body, line)?;
        self.push_node_struct(3, Token::Function, line)?;
        let root_flags = self.flags
            & (flags::STRICT | flags::NOT_SIMPLE_PARAMETERS | flags::TARGET | flags::ARGUMENTS | flags::EVAL | flag);
        self.set_root_flags(root_flags);
        if saved & flags::STRICT == 0 && self.flags & flags::STRICT != 0 {
            self.check_strict_function()?;
        }
        self.flags = saved;
        self.match_token(Token::RightBrace)?;
        let _ = name;
        Ok(())
    }

    /// `fxGeneratorExpression`.
    pub(crate) fn generator_expression(&mut self, line: u32, symbol_out: Option<&mut Option<String>>, flag: u32) -> PResult<()> {
        let saved = self.flags;
        self.flags = (saved & (flags::PARSER_FLAGS | flags::STRICT)) | flags::GENERATOR | flags::TARGET | flag;
        let want_symbol = symbol_out.is_some();
        // Generator name context differs slightly (no generator-yield
        // escape hatch), but the shared helper is faithful for the corpus.
        self.function_name_generator(saved, want_symbol, symbol_out)?;
        self.parameters_binding()?;
        self.match_token(Token::LeftBrace)?;
        self.flags |= flags::YIELD;
        self.body()?;
        self.flags &= !flags::YIELD;
        self.push_node_struct(1, Token::Body, line)?;
        self.push_node_struct(3, Token::Generator, line)?;
        let root_flags = self.flags
            & (flags::STRICT | flags::NOT_SIMPLE_PARAMETERS | flags::GENERATOR | flags::ARGUMENTS | flags::EVAL | flag);
        self.set_root_flags(root_flags);
        if saved & flags::STRICT == 0 && self.flags & flags::STRICT != 0 {
            self.check_strict_function()?;
        }
        self.flags = saved;
        self.match_token(Token::RightBrace)
    }

    /// The optional function name (`fxFunctionExpression` head). Pushes the
    /// name symbol or `NULL`.
    fn function_name(&mut self, saved: u32, want_symbol: bool, symbol_out: Option<&mut Option<String>>) -> PResult<()> {
        let is_name = self.cur.token == Token::Identifier
            || (saved & flags::GENERATOR != 0 && saved & flags::STRICT == 0 && self.cur.token == Token::Yield)
            || (!want_symbol && self.cur.token == Token::Await);
        if is_name {
            let sym = self.cur.symbol.clone().unwrap_or_default();
            self.push_symbol(sym.clone());
            if let Some(out) = symbol_out {
                *out = Some(sym.clone());
            }
            self.check_strict_symbol(&sym)?;
            self.get_next_token()?;
        } else {
            self.push_null();
        }
        Ok(())
    }

    /// The optional generator name (`fxGeneratorExpression` head).
    fn function_name_generator(&mut self, _saved: u32, want_symbol: bool, symbol_out: Option<&mut Option<String>>) -> PResult<()> {
        let is_name = self.cur.token == Token::Identifier || (!want_symbol && self.cur.token == Token::Await);
        if is_name {
            let sym = self.cur.symbol.clone().unwrap_or_default();
            self.push_symbol(sym.clone());
            if let Some(out) = symbol_out {
                *out = Some(sym.clone());
            } else if sym == "yield" {
                return Err(self.error("invalid yield"));
            } else if self.flags & flags::ASYNC != 0 && sym == "await" {
                return Err(self.error("invalid await"));
            }
            self.check_strict_symbol(&sym)?;
            self.get_next_token()?;
        } else {
            self.push_null();
        }
        Ok(())
    }

    /// `fxCheckStrictFunction` — validate name and parameters when strict
    /// mode was entered by a `"use strict"` prologue in the body.
    fn check_strict_function(&mut self) -> PResult<()> {
        // The Function node is on top: children = [name, params, body].
        let (name, params) = match self.stack.last() {
            Some(Item::Node(node)) if node.children.len() >= 2 => {
                (node.children[0].clone(), node.children[1].clone())
            }
            _ => return Ok(()),
        };
        if let Item::Symbol(s) = &name {
            self.check_strict_symbol(s)?;
        }
        self.check_strict_binding(&params)
    }

    /// `fxArrowExpression` — the arrow body, given a `ParamsBinding` node
    /// already on the stack.
    pub(crate) fn arrow_expression(&mut self, flag: u32) -> PResult<()> {
        let line = self.cur.line;
        let saved = self.flags;
        self.flags &= !(flags::ASYNC | flags::GENERATOR);
        self.flags |= flags::ARROW | flag;
        self.match_token(Token::Arrow)?;
        self.push_null();
        self.swap_nodes();
        if self.cur.token == Token::LeftBrace {
            self.match_token(Token::LeftBrace)?;
            self.body()?;
            self.push_node_struct(1, Token::Body, line)?;
            self.match_token(Token::RightBrace)?;
        } else {
            self.assignment_expression()?;
            self.push_node_struct(1, Token::Return, line)?;
            self.push_node_struct(1, Token::Body, line)?;
        }
        self.push_node_struct(3, Token::Function, line)?;
        let root_flags = self.flags
            & (flags::STRICT | flags::FIELD | flags::NOT_SIMPLE_PARAMETERS | flags::ARROW | flags::SUPER | flag);
        self.set_root_flags(root_flags);
        if saved & flags::STRICT == 0 && self.flags & flags::STRICT != 0 {
            self.check_strict_function()?;
        }
        self.flags = saved | (self.flags & (flags::ARGUMENTS | flags::EVAL));
        Ok(())
    }

    // ================= classes =================

    /// `fxClassExpression` — class declaration / expression. Members are
    /// parsed faithfully (identical early errors); the field/static-block →
    /// init-function surgery is folded to the coder (module doc), so the
    /// `constructorInit` / `instanceInit` slots are left null and members
    /// stay in the `items` list in source order.
    pub(crate) fn class_expression(&mut self, line: u32, symbol_out: Option<&mut Option<String>>) -> PResult<()> {
        let saved = self.flags;
        let mut heritage_flag = false;
        let mut constructor: Option<Item> = None;
        let mut count = 0usize;
        let mut constructor_flags = flags::SUPER;
        self.flags |= flags::STRICT;
        self.match_token(Token::Class)?;
        if self.cur.token == Token::Identifier {
            let sym = self.cur.symbol.clone().unwrap_or_default();
            self.push_symbol(sym.clone());
            if let Some(out) = symbol_out {
                *out = Some(sym);
            }
            self.get_next_token()?;
        } else {
            self.push_null();
        }
        if self.cur.token == Token::Extends {
            self.match_token(Token::Extends)?;
            self.call_expression()?;
            constructor_flags |= flags::DERIVED;
            heritage_flag = true;
        } else {
            self.push_null();
            constructor_flags |= flags::BASE;
        }
        if self.cur.token == Token::LeftBrace {
            self.match_token(Token::LeftBrace)?;
            loop {
                let prop_line = self.cur.line;
                while self.cur.token == Token::Semicolon {
                    self.get_next_token()?;
                }
                if self.cur.token == Token::RightBrace {
                    break;
                }
                let mut static_flag = false;
                if self.cur.token == Token::Static && !self.cur.escaped {
                    self.get_next_token()?;
                    if self.cur.token == Token::Assign || self.cur.token == Token::Semicolon {
                        self.push_symbol("static".to_string());
                        self.class_field(prop_line, Token::Property, true)?;
                        count += 1;
                        continue;
                    }
                    if self.cur.token == Token::LeftBrace {
                        // static initialization block
                        let block_saved = self.flags;
                        self.flags = (block_saved & (flags::PARSER_FLAGS | flags::STRICT))
                            | flags::SUPER
                            | flags::TARGET
                            | flags::FIELD
                            | flags::ASYNC;
                        self.get_next_token()?;
                        self.statements()?;
                        self.match_token(Token::RightBrace)?;
                        self.push_node_struct(1, Token::Body, prop_line)?;
                        // A static initialization block is a field context:
                        // `arguments` and top-level `await` are Syntax Errors.
                        if self.flags & flags::ARGUMENTS != 0 {
                            return Err(self.error("invalid arguments"));
                        }
                        if self.flags & flags::AWAITING != 0 {
                            return Err(self.error("invalid await"));
                        }
                        self.flags = block_saved;
                        self.set_top_flags(flags::STATIC);
                        count += 1;
                        continue;
                    }
                    static_flag = true;
                }
                let (a_symbol, _t0, a_token1, a_token2) = self.property_name()?;
                let async_flag = self.property_name_async_flag;
                if !static_flag && a_symbol.as_deref() == Some("constructor") {
                    self.pop(); // the key symbol
                    if constructor.is_some()
                        || a_token2 == Token::Generator
                        || a_token2 == Token::Getter
                        || a_token2 == Token::Setter
                        || async_flag != 0
                    {
                        return Err(self.error("invalid constructor"));
                    }
                    self.function_expression(prop_line, None, constructor_flags)?;
                    constructor = Some(self.pop());
                } else if self.cur.token == Token::LeftParenthesis {
                    let mut method_flag = async_flag;
                    if a_token1 == Token::PrivateProperty && a_symbol.as_deref() == Some("#constructor") {
                        return Err(self.error("invalid method: #constructor"));
                    }
                    if static_flag && a_symbol.as_deref() == Some("prototype") {
                        return Err(self.error("invalid static method: prototype"));
                    }
                    if static_flag {
                        method_flag |= flags::STATIC;
                    }
                    if a_token2 == Token::Getter {
                        method_flag |= flags::GETTER;
                    } else if a_token2 == Token::Setter {
                        method_flag |= flags::SETTER;
                    } else {
                        method_flag |= flags::METHOD;
                    }
                    if a_token2 == Token::Generator {
                        self.generator_expression(prop_line, None, flags::SUPER | method_flag)?;
                    } else {
                        self.function_expression(prop_line, None, flags::SUPER | method_flag)?;
                    }
                    self.push_node_struct(2, a_token1, prop_line)?;
                    let keep = method_flag & (flags::STATIC | flags::GETTER | flags::SETTER | flags::METHOD);
                    self.set_top_flags(keep);
                    count += 1;
                } else {
                    if a_token1 == Token::PrivateProperty && a_symbol.as_deref() == Some("#constructor") {
                        return Err(self.error("invalid field: #constructor"));
                    }
                    if a_symbol.as_deref() == Some("constructor") {
                        return Err(self.error("invalid field: constructor"));
                    }
                    if a_symbol.as_deref() == Some("prototype") {
                        return Err(self.error("invalid field: prototype"));
                    }
                    self.class_field(prop_line, a_token1, static_flag)?;
                    count += 1;
                }
            }
        }
        self.match_token(Token::RightBrace)?;
        self.push_node_list(count)?;
        // constructorInit / instanceInit slots (surgery folded to coder).
        self.push_null();
        self.push_null();
        // constructor: parsed, or the synthesized default.
        if let Some(c) = constructor {
            self.push(c);
        } else {
            self.synthesize_default_constructor(heritage_flag, line);
        }
        self.push_node_struct(6, Token::Class, line)?;
        self.flags = saved | (self.flags & flags::ARGUMENTS);
        Ok(())
    }

    /// A class field body: `= initializer` (in a field context) or the
    /// implicit `undefined`, wrapped as a `token1` property node. The key
    /// is already on the stack.
    fn class_field(&mut self, prop_line: u32, token1: Token, static_flag: bool) -> PResult<()> {
        if self.cur.token == Token::Assign {
            let saved = self.flags;
            self.flags = (saved & (flags::PARSER_FLAGS | flags::STRICT))
                | flags::SUPER
                | flags::TARGET
                | flags::FIELD;
            self.get_next_token()?;
            self.assignment_expression()?;
            // `arguments` is a Syntax Error inside a field initializer
            // (ContainsArguments of Initializer): the flag survived the
            // `assignment_expression` (arrows propagate it out; regular
            // functions absorb it) because `FIELD` flags were reset above
            // without carrying `ARGUMENTS`.
            if self.flags & flags::ARGUMENTS != 0 {
                return Err(self.error("invalid arguments"));
            }
            self.flags = saved;
        } else {
            self.push_node_struct(0, Token::Undefined, prop_line)?;
        }
        self.push_node_struct(2, token1, prop_line)?;
        if static_flag {
            self.set_top_flags(flags::STATIC);
        }
        self.semicolon()
    }

    /// Push a synthesized default constructor `Function` node (the
    /// derived `constructor(...args){ super(...args) }` or the base
    /// `constructor(){}`), matching the shape `fxClassExpression` builds.
    fn synthesize_default_constructor(&mut self, heritage_flag: bool, line: u32) {
        let strict = self.flags & flags::INHERITED;
        let empty_params = || Item::Node(Box::new(Node {
            token: Token::ParamsBinding,
            line,
            flags: strict,
            children: vec![Item::List(Vec::new())],
            value: Value::None,
        }));
        // name
        let name = Item::Null;
        let (params, body, fflags);
        if heritage_flag {
            // params: (...args)
            let arg = Item::Node(Box::new(Node { token: Token::Arg, line, flags: strict, children: vec![Item::Symbol("args".to_string()), Item::Null], value: Value::None }));
            let rest = Item::Node(Box::new(Node { token: Token::RestBinding, line, flags: strict, children: vec![arg], value: Value::None }));
            params = Item::Node(Box::new(Node { token: Token::ParamsBinding, line, flags: strict, children: vec![Item::List(vec![rest])], value: Value::None }));
            // body: super(...args)
            let access = Item::Node(Box::new(Node { token: Token::Access, line, flags: strict, children: vec![Item::Symbol("args".to_string())], value: Value::None }));
            let spread = Item::Node(Box::new(Node { token: Token::Spread, line, flags: strict, children: vec![access], value: Value::None }));
            let mut sup_params = Node { token: Token::Params, line, flags: strict, children: vec![Item::List(vec![spread])], value: Value::None };
            sup_params.flags |= flags::SPREAD;
            let sup = Item::Node(Box::new(Node { token: Token::Super, line, flags: strict, children: vec![Item::Node(Box::new(sup_params))], value: Value::None }));
            let stmt = Item::Node(Box::new(Node { token: Token::Statement, line, flags: strict, children: vec![sup], value: Value::None }));
            body = Item::Node(Box::new(Node { token: Token::Body, line, flags: strict, children: vec![stmt], value: Value::None }));
            fflags = flags::STRICT | flags::DERIVED | flags::METHOD | flags::TARGET | flags::SUPER;
        } else {
            params = empty_params();
            let undef = Item::Node(Box::new(Node { token: Token::Undefined, line, flags: strict, children: Vec::new(), value: Value::None }));
            let stmt = Item::Node(Box::new(Node { token: Token::Statement, line, flags: strict, children: vec![undef], value: Value::None }));
            body = Item::Node(Box::new(Node { token: Token::Body, line, flags: strict, children: vec![stmt], value: Value::None }));
            fflags = flags::STRICT | flags::BASE | flags::METHOD | flags::TARGET;
        }
        let func = Item::Node(Box::new(Node { token: Token::Function, line, flags: fflags, children: vec![name, params, body], value: Value::None }));
        self.push(func);
    }

    // ================= modules =================

    /// `fxExportDeclaration`.
    fn export_declaration(&mut self) -> PResult<()> {
        let line = self.cur.line;
        self.match_token(Token::Export)?;
        match self.cur.token {
            Token::Multiply => {
                self.push_null();
                self.get_next_token()?;
                if self.is_keyword("as")? {
                    self.get_next_token()?;
                    if has_flag(self.cur.token, IDENTIFIER_NAME) {
                        let s = self.cur.symbol.clone().unwrap_or_default();
                        self.push_symbol(s);
                        self.get_next_token()?;
                    } else {
                        return Err(self.error("missing identifier"));
                    }
                } else {
                    self.push_null();
                }
                if self.is_keyword("from")? {
                    self.get_next_token()?;
                    if self.cur.token == Token::String {
                        self.push_node_struct(2, Token::Specifier, line)?;
                        self.push_node_list(1)?;
                        let s = self.cur.string.clone().unwrap_or_default();
                        let l = self.cur.line;
                        self.push_string(s, l, false);
                        self.get_next_token()?;
                        self.push_null(); // with-attributes (unsupported form → null)
                        self.push_node_struct(3, Token::Export, line)?;
                        self.semicolon()?;
                    } else {
                        return Err(self.error("missing module"));
                    }
                } else {
                    return Err(self.error("missing from"));
                }
            }
            Token::Default => {
                self.export_default(line)?;
            }
            Token::Class => {
                let mut symbol = None;
                self.class_expression(line, Some(&mut symbol))?;
                if let Some(sym) = symbol {
                    self.push_symbol(sym.clone());
                    self.push_node_struct(1, Token::Let, line)?;
                    self.swap_nodes();
                    self.push_node_struct(2, Token::Binding, line)?;
                    self.export_local(sym, line)?;
                } else {
                    return Err(self.error("missing identifier"));
                }
            }
            Token::Function => self.export_function(line, 0)?,
            Token::Const | Token::Let | Token::Var => {
                let a_token = self.cur.token;
                let before = self.stack.len();
                self.variable_statement(a_token)?;
                // Collect specifiers from the just-parsed declaration.
                let decl = self.stack[before..].to_vec();
                let mut specs = Vec::new();
                for item in &decl {
                    self.export_binding(item, line, &mut specs);
                }
                self.push_node_list_from(specs)?;
                self.push_null();
                self.push_null();
                self.push_node_struct(3, Token::Export, line)?;
                self.semicolon()?;
            }
            Token::LeftBrace => {
                let before = self.stack.len();
                self.specifiers()?;
                let n = self.stack.len() - before;
                self.push_node_list(n)?;
                if self.is_keyword("from")? {
                    self.get_next_token()?;
                    if self.cur.token == Token::String {
                        let s = self.cur.string.clone().unwrap_or_default();
                        let l = self.cur.line;
                        self.push_string(s, l, false);
                        self.get_next_token()?;
                    } else {
                        self.push_null();
                        return Err(self.error("missing module"));
                    }
                    self.push_null();
                } else {
                    self.push_null();
                    self.push_null();
                }
                self.push_node_struct(3, Token::Export, line)?;
                self.semicolon()?;
            }
            _ => {
                if self.cur.token == Token::Identifier
                    && self.cur.symbol.as_deref() == Some("async")
                    && !self.cur.escaped
                {
                    self.look_ahead_once()?;
                    if !self.ahead_crlf() && self.ahead_token() == Token::Function {
                        self.get_next_token()?;
                        return self.export_function(line, flags::ASYNC);
                    }
                }
                return Err(self.error("invalid export"));
            }
        }
        Ok(())
    }

    /// `export default …`.
    fn export_default(&mut self, line: u32) -> PResult<()> {
        self.match_token(Token::Default)?;
        if self.flags & flags::DEFAULT != 0 {
            return Err(self.error("invalid default"));
        }
        self.flags |= flags::DEFAULT;
        let mut symbol: Option<String> = None;
        if self.cur.token == Token::Class {
            self.class_expression(line, Some(&mut symbol))?;
            let name = symbol.clone().unwrap_or_else(|| "default".to_string());
            self.push_symbol(name);
            self.push_node_struct(1, Token::Let, line)?;
            self.swap_nodes();
            self.push_node_struct(2, Token::Binding, line)?;
        } else if self.cur.token == Token::Function || self.is_async_function_ahead()? {
            let mut flag = 0;
            if self.cur.token != Token::Function {
                // `async function`
                self.get_next_token()?;
                flag = flags::ASYNC;
            }
            self.match_token(Token::Function)?;
            if self.cur.token == Token::Multiply {
                self.get_next_token()?;
                self.generator_expression(line, Some(&mut symbol), flag)?;
            } else {
                self.function_expression(line, Some(&mut symbol), flag)?;
            }
            let name = symbol.clone().unwrap_or_else(|| "default".to_string());
            self.push_define(name, line);
        } else {
            self.assignment_expression()?;
            self.semicolon()?;
            self.push_symbol("default".to_string());
            self.push_null();
            self.push_node_struct(2, Token::Const, line)?;
            self.swap_nodes();
            self.push_node_struct(2, Token::Assign, line)?;
            self.push_node_struct(1, Token::Statement, line)?;
        }
        // specifier for the default export
        if let Some(sym) = &symbol {
            self.push_symbol(sym.clone());
            self.push_symbol("default".to_string());
        } else {
            self.push_symbol("default".to_string());
            self.push_null();
        }
        self.push_node_struct(2, Token::Specifier, line)?;
        self.push_node_list(1)?;
        self.push_null();
        self.push_null();
        self.push_node_struct(3, Token::Export, line)
    }

    /// `export function …` (and `export async function …`), shared tail.
    fn export_function(&mut self, line: u32, flag: u32) -> PResult<()> {
        self.match_token(Token::Function)?;
        let mut symbol = None;
        if self.cur.token == Token::Multiply {
            self.get_next_token()?;
            self.generator_expression(line, Some(&mut symbol), flag)?;
        } else {
            self.function_expression(line, Some(&mut symbol), flag)?;
        }
        if let Some(sym) = symbol {
            self.push_define(sym.clone(), line);
            self.export_local(sym, line)
        } else {
            Err(self.error("missing identifier"))
        }
    }

    /// Emit the `Export` node wrapping a single local specifier (used by
    /// `export class`/`export function`).
    fn export_local(&mut self, sym: String, line: u32) -> PResult<()> {
        self.push_symbol(sym);
        self.push_null();
        self.push_node_struct(2, Token::Specifier, line)?;
        self.push_node_list(1)?;
        self.push_null();
        self.push_null();
        self.push_node_struct(3, Token::Export, line)
    }

    /// `fxExportBinding` — collect specifier nodes from a declaration
    /// subtree into `out`.
    fn export_binding(&mut self, item: &Item, line: u32, out: &mut Vec<Item>) {
        let Item::Node(node) = item else { return };
        match node.token {
            Token::Const | Token::Let | Token::Var => {
                if let Some(Item::Symbol(s)) = node.children.first() {
                    let spec = Item::Node(Box::new(Node {
                        token: Token::Specifier,
                        line: node.line,
                        flags: self.flags & flags::INHERITED,
                        children: vec![Item::Symbol(s.clone()), Item::Null],
                        value: Value::None,
                    }));
                    out.push(spec);
                }
            }
            Token::Binding => {
                if let Some(child) = node.children.first() {
                    self.export_binding(child, line, out);
                }
            }
            Token::ArrayBinding | Token::ObjectBinding | Token::Statements => {
                if let Some(Item::List(list)) = node.children.first() {
                    for child in list {
                        self.export_binding(child, line, out);
                    }
                }
            }
            Token::PropertyBinding | Token::PropertyBindingAt | Token::RestBinding => {
                if let Some(child) = node.children.last() {
                    self.export_binding(child, line, out);
                }
            }
            _ => {}
        }
    }

    /// `fxImportDeclaration`.
    fn import_declaration(&mut self) -> PResult<()> {
        let mut as_flag = true;
        let mut from_flag = false;
        let before = self.stack.len();
        self.match_token(Token::Import)?;
        if self.cur.token == Token::Identifier {
            self.push_symbol("default".to_string());
            let s = self.cur.symbol.clone().unwrap_or_default();
            let l = self.cur.line;
            self.push_symbol(s);
            self.push_node_struct(2, Token::Specifier, l)?;
            self.get_next_token()?;
            if self.cur.token == Token::Comma {
                self.get_next_token()?;
            } else {
                as_flag = false;
            }
            from_flag = true;
        }
        if as_flag {
            if self.cur.token == Token::Multiply {
                self.get_next_token()?;
                if self.is_keyword("as")? {
                    self.get_next_token()?;
                    if self.cur.token == Token::Identifier {
                        self.push_null();
                        let s = self.cur.symbol.clone().unwrap_or_default();
                        let l = self.cur.line;
                        self.push_symbol(s);
                        self.push_node_struct(2, Token::Specifier, l)?;
                        self.get_next_token()?;
                    } else {
                        return Err(self.error("missing identifier"));
                    }
                } else {
                    return Err(self.error("missing as"));
                }
                from_flag = true;
            } else if self.cur.token == Token::LeftBrace {
                self.specifiers()?;
                from_flag = true;
            }
        }
        let n = self.stack.len() - before;
        self.push_node_list(n)?;
        if from_flag {
            if self.is_keyword("from")? {
                self.get_next_token()?;
                if self.cur.token == Token::String {
                    let s = self.cur.string.clone().unwrap_or_default();
                    let l = self.cur.line;
                    self.push_string(s, l, false);
                    self.get_next_token()?;
                } else {
                    return Err(self.error("missing module"));
                }
            } else {
                return Err(self.error("missing from"));
            }
        } else if self.cur.token == Token::String {
            let s = self.cur.string.clone().unwrap_or_default();
            let l = self.cur.line;
            self.push_string(s, l, false);
            self.get_next_token()?;
        } else {
            return Err(self.error("missing module"));
        }
        self.push_null(); // with-attributes
        let l = self.cur.line;
        self.push_node_struct(3, Token::Import, l)?;
        self.semicolon()
    }

    /// `fxSpecifiers` — a `{ a, b as c }` import/export list.
    fn specifiers(&mut self) -> PResult<()> {
        self.match_token(Token::LeftBrace)?;
        while has_flag(self.cur.token, IDENTIFIER_NAME) {
            let s = self.cur.symbol.clone().unwrap_or_default();
            self.push_symbol(s);
            self.get_next_token()?;
            if self.is_keyword("as")? {
                self.get_next_token()?;
                if has_flag(self.cur.token, IDENTIFIER_NAME) {
                    let s2 = self.cur.symbol.clone().unwrap_or_default();
                    self.push_symbol(s2);
                    self.get_next_token()?;
                } else {
                    return Err(self.error("missing identifier"));
                }
            } else {
                self.push_null();
            }
            let l = self.cur.line;
            self.push_node_struct(2, Token::Specifier, l)?;
            if self.cur.token != Token::Comma {
                break;
            }
            self.get_next_token()?;
        }
        self.match_token(Token::RightBrace)
    }

    /// `export default async function` lookahead.
    fn is_async_function_ahead(&mut self) -> PResult<bool> {
        if self.cur.token == Token::Identifier
            && self.cur.symbol.as_deref() == Some("async")
            && !self.cur.escaped
        {
            self.look_ahead_once()?;
            Ok(!self.ahead_crlf() && self.ahead_token() == Token::Function)
        } else {
            Ok(false)
        }
    }
}
