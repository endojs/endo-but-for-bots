//! The parser — a transliteration of the expression grammar in
//! `c/moddable/xs/sources/xsSyntaxical.c` at the oracle pin. It drives
//! the [`Lexer`](crate::lexer::Lexer) pull-style and builds XS's exact
//! AST ([`crate::ast`]) on a node stack, statement-for-statement with
//! XS so the scoper and coder built on top (later stage-5 children)
//! see the tree shapes the byte-identity bar depends on.
//!
//! Scope of this child (stage-5 child 2, expression grammar): the full
//! operator precedence cascade (`fxCommaExpression` down to
//! `fxLiteralExpression`), primary expressions, member / call / new /
//! optional-chaining / tagged-template postfix chains, array and object
//! **data** literals, template literals, `new.target` / `import.meta` /
//! dynamic `import()`, and `yield` / `await` in expression position with
//! XS's parser-state flags. Constructs whose bodies are statement or
//! declaration grammar — arrow / function / generator / class
//! expressions, object method / accessor shorthand, and the
//! destructuring binding-conversion subsystem — are deferred to the
//! statement-grammar child and reported as [`ParseErrorKind::Unsupported`]
//! rather than mis-parsed (see the crate report).
//!
//! Errors are fail-fast, mirroring XS's `fxReportParserError`, which
//! `longjmp`s out on the first error when a console is attached: the
//! first [`ParseError`] short-circuits the parse. No byte sequence
//! panics the parser (the fuzz target in a later child depends on this).

use crate::ast::{flags, node_name, Item, Node, Value};
use crate::error::LexError;
use crate::lexer::{Lexeme, Lexer};
use crate::meter::ParseMeter;
use crate::token::Token;
use crate::token_flags::has_flag;
use crate::token_flags::{
    ASSIGN_EXPRESSION, BEGIN_EXPRESSION, CALL_EXPRESSION, EQUAL_EXPRESSION, EXPONENTIATION_EXPRESSION,
    IDENTIFIER_NAME, POSTFIX_EXPRESSION, PREFIX_EXPRESSION, RELATIONAL_EXPRESSION, SHIFT_EXPRESSION,
    UNARY_EXPRESSION,
};

/// A parser error, classified and located as XS's `fxReportParserError`
/// sites are. Carries the 1-based line and a message mirroring XS's
/// wording where practical.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParseError {
    /// Source line (`parser->states[0].line`).
    pub line: u32,
    /// The classified condition.
    pub kind: ParseErrorKind,
    /// Human-readable message, matching XS's wording where practical.
    pub message: String,
}

/// The classified parse failure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParseErrorKind {
    /// A lexing error surfaced while pulling a token.
    Lex(LexError),
    /// A `SyntaxError` XS raises in the parser (an early error) — the
    /// catch-all for the grammar's own `fxReportParserError` sites.
    Syntax,
    /// A construct valid in JS but not yet ported in this child (arrow /
    /// function / class expressions, object methods/accessors,
    /// destructuring). Deferred to the statement-grammar child; never
    /// raised on input the folded features do not reach.
    Unsupported,
}

impl core::fmt::Display for ParseError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "line {}: {}", self.line, self.message)
    }
}

impl std::error::Error for ParseError {}

impl From<LexError> for ParseError {
    fn from(e: LexError) -> ParseError {
        ParseError { line: e.line, kind: ParseErrorKind::Lex(e.clone()), message: e.to_string() }
    }
}

type PResult<T> = Result<T, ParseError>;

/// The parser's native-recursion budget, in the units [`Parser::nested`]
/// charges.
///
/// XS's recursive-descent parser guards its C stack with
/// `fxCheckParserStack`, a stack-address margin that varies with the host,
/// the thread and the build profile — so the same source is accepted on one
/// thread and rejected on another, and a source this port accepted with
/// optimizations aborted the whole process without them (4,000 nested
/// parentheses, about 8 KB of text). This parser instead charges every
/// recursion point a fixed cost by frame class and refuses past this ceiling
/// with XS's own `SyntaxError` wording (`"stack overflow"`), so the depth at
/// which a program is rejected is a property of the program alone and part of
/// the release-versioned contract.
///
/// The classes, and what the budget admits of each on its own:
///
/// - a full expression-cascade re-entry — a parenthesized or bracketed
///   operand, an array or object literal element, a call's arguments, a
///   template substitution, an arrow body — costs [`CASCADE_COST`] plus the
///   operand charges the cascade passes on the way down: the whole
///   precedence cascade is re-entered, about 35 KiB of frames per level
///   unoptimized, so about 100 levels (101 nested parentheses compile, 102
///   do not);
/// - a nested statement, a `new` operand or a destructuring-pattern level
///   costs [`STATEMENT_COST`]: 512 levels (about 10 KiB each);
/// - an assignment, unary or conditional operand — the cheap right-recursive
///   chains such as `a ? b : c ? d : …` or `!!!!x` — costs [`OPERAND_COST`]:
///   about 1,000 levels (about 2 KiB each).
///
/// Every corner stays under 6 MiB of host stack unoptimized and under 2 MiB
/// optimized. A flat sequence the grammar folds into a left-nested tree
/// (`a + a + … + a`) never recurses here; its depth is bounded by the
/// scoper's [`crate::scoper::TREE_DEPTH_LIMIT`]. `tests/recursion_bounds.rs`
/// pins every boundary.
pub const PARSER_STACK_BUDGET: u32 = 1024;
/// Budget units for one expression-cascade re-entry (see
/// [`PARSER_STACK_BUDGET`]).
pub const CASCADE_COST: u32 = 8;
/// Budget units for one nested statement, `new` operand or binding-pattern
/// level (see [`PARSER_STACK_BUDGET`]).
pub const STATEMENT_COST: u32 = 2;
/// Budget units for one assignment, unary or conditional operand level (see
/// [`PARSER_STACK_BUDGET`]).
pub const OPERAND_COST: u32 = 1;

/// Return the line of the second `__proto__:` setter in an object literal.
/// Converted assignment/parameter covers are `ObjectBinding` nodes, so only
/// nodes that remain `Object` are subject to Annex B.3.1.
fn duplicate_proto_setter_line(item: &Item) -> Option<u32> {
    match item {
        Item::Node(node) => {
            if node.token == Token::Object {
                let mut found = false;
                if let Some(Item::List(properties)) = node.children.first() {
                    for property in properties {
                        if let Item::Node(property) = property {
                            let is_proto_setter = property.token == Token::Property
                                && property.flags & flags::SHORTHAND == 0
                                && matches!(
                                    property.children.first(),
                                    Some(Item::Symbol(symbol)) if symbol == "__proto__"
                                );
                            if is_proto_setter {
                                if found {
                                    return Some(property.line);
                                }
                                found = true;
                            }
                        }
                    }
                }
            }
            node.children.iter().find_map(duplicate_proto_setter_line)
        }
        Item::List(items) => items.iter().find_map(duplicate_proto_setter_line),
        Item::Symbol(_) | Item::Null => None,
    }
}

/// The parser: the token window (`states[0]`/`states[1]`), the mode-flag
/// word (`parser->flags`), and the node-build stack (`parser->root`).
pub struct Parser {
    lexer: Lexer,
    /// `parser->states[0]` — the current token.
    cur: Lexeme,
    /// `parser->states[1..=2]` — the token lookahead window. Most grammar
    /// productions need one token; explicit-resource-management's
    /// `for (using of of iterable)` disambiguation needs two.
    ahead: Option<Lexeme>,
    ahead2: Option<Lexeme>,
    /// `parser->flags` (mode bits; see [`crate::ast::flags`]).
    flags: u32,
    /// The node-build stack (`parser->root`, top = last pushed).
    stack: Vec<Item>,
    /// `fxPropertyName`'s `*flag` out-parameter (`mxAsyncFlag` for an
    /// `async` method key), read by the object/class member loops after a
    /// [`Self::property_name`] call.
    property_name_async_flag: u32,
    /// Budget units in use by the recursion points currently on the native
    /// stack (see [`PARSER_STACK_BUDGET`] and [`Self::nested`]).
    depth: u32,
}

impl Parser {
    /// A parser over `source`. `strict` seeds `mxStrictFlag`; `module`
    /// seeds the module context (`await` reserved at top level via the
    /// async flag, as XS does for a module program).
    pub fn new(source: &str, strict: bool, module: bool) -> PResult<Parser> {
        let mut flags = 0u32;
        if strict {
            flags |= flags::STRICT;
        }
        if module {
            flags |= flags::STRICT | flags::ASYNC;
        }
        let mut lexer = Lexer::new(source);
        lexer.set_strict(flags & flags::STRICT != 0);
        lexer.set_async(flags & flags::ASYNC != 0);
        lexer.set_generator(flags & flags::GENERATOR != 0);
        // `fxParserTree` skips a leading `#!` hashbang before fetching
        // the first token, for both the program and module goals.
        lexer.skip_shebang();
        let cur = lexer.next()?;
        Ok(Parser {
            lexer,
            cur,
            ahead: None,
            ahead2: None,
            flags,
            stack: Vec::new(),
            property_name_async_flag: 0,
            depth: 0,
        })
    }

    /// Parse a single expression (an `AssignmentExpression` — XS's
    /// `fxAssignmentExpression`), the entry point the fixture tests use.
    /// Returns the sole tree item; errors if input remains.
    pub fn parse_assignment_expression(&mut self) -> PResult<Item> {
        self.assignment_expression()?;
        self.expect_eof()?;
        Ok(self.pop())
    }

    /// Parse a full comma expression (`fxCommaExpression`) to end of
    /// input.
    pub fn parse_comma_expression(&mut self) -> PResult<Item> {
        self.comma_expression()?;
        self.expect_eof()?;
        Ok(self.pop())
    }

    /// The parse meter (ironhorse's own frozen cost table), for telemetry
    /// after a parse.
    pub fn meter(&self) -> &ParseMeter {
        self.lexer.meter()
    }

    fn expect_eof(&mut self) -> PResult<()> {
        if self.cur.token != Token::Eof {
            return Err(self.error("missing eof"));
        }
        Ok(())
    }

    // --- errors ---

    fn error(&self, message: &str) -> ParseError {
        ParseError { line: self.cur.line, kind: ParseErrorKind::Syntax, message: message.to_string() }
    }

    fn unsupported_error(&self, message: &str) -> ParseError {
        ParseError {
            line: self.cur.line,
            kind: ParseErrorKind::Unsupported,
            message: format!("unsupported: {message}"),
        }
    }

    /// Run `f` as one recursion point of `cost` budget units, refusing with
    /// `fxCheckParserStack`'s `"stack overflow"` when the charge would exceed
    /// [`PARSER_STACK_BUDGET`]. The charge is released on every return path,
    /// including a `?` propagation inside `f`.
    pub(crate) fn nested<T>(
        &mut self,
        cost: u32,
        f: impl FnOnce(&mut Self) -> PResult<T>,
    ) -> PResult<T> {
        if self.depth + cost > PARSER_STACK_BUDGET {
            return Err(self.error("stack overflow"));
        }
        self.depth += cost;
        let result = f(self);
        self.depth -= cost;
        result
    }

    // --- token window (fxGetNextToken / fxLookAheadOnce / fxMatchToken) ---

    fn get_next_token(&mut self) -> PResult<()> {
        if let Some(next) = self.ahead.take() {
            self.cur = next;
            self.ahead = self.ahead2.take();
        } else {
            self.sync_lexer_flags();
            self.cur = self.lexer.next()?;
        }
        Ok(())
    }

    fn look_ahead_once(&mut self) -> PResult<()> {
        if self.ahead.is_none() {
            self.sync_lexer_flags();
            self.ahead = Some(self.lexer.next()?);
        }
        Ok(())
    }

    fn look_ahead_twice(&mut self) -> PResult<()> {
        self.look_ahead_once()?;
        if self.ahead2.is_none() {
            self.sync_lexer_flags();
            self.ahead2 = Some(self.lexer.next()?);
        }
        Ok(())
    }

    /// The lexer classifies `await`/`yield` and strict reserved words
    /// from its own flag copies; XS reads `parser->flags` directly, so
    /// keep the two in sync before every scan.
    fn sync_lexer_flags(&mut self) {
        self.lexer.set_strict(self.flags & flags::STRICT != 0);
        self.lexer.set_async(self.flags & flags::ASYNC != 0);
        self.lexer.set_generator(self.flags & flags::GENERATOR != 0);
    }

    fn match_token(&mut self, expected: Token) -> PResult<()> {
        if self.cur.token == expected {
            if self.cur.escaped {
                return Err(self.error("escaped keyword"));
            }
            self.get_next_token()
        } else {
            Err(self.error(&format!("missing {}", token_debug(expected))))
        }
    }

    /// `fxIsKeyword` — is the current token an (unescaped) identifier
    /// spelled `word`?
    fn is_keyword(&self, word: &str) -> PResult<bool> {
        if self.cur.token == Token::Identifier && self.cur.symbol.as_deref() == Some(word) {
            if self.cur.escaped {
                return Err(self.error("escaped keyword"));
            }
            Ok(true)
        } else {
            Ok(false)
        }
    }

    // --- node stack (fxPushNode / fxPopNode / fxPushNodeStruct / …) ---

    fn push(&mut self, item: Item) {
        self.stack.push(item);
    }

    fn pop(&mut self) -> Item {
        self.stack.pop().expect("node stack underflow")
    }

    fn push_null(&mut self) {
        self.stack.push(Item::Null);
    }

    fn push_symbol(&mut self, symbol: String) {
        self.stack.push(Item::Symbol(symbol));
    }

    fn push_integer(&mut self, value: i32, line: u32) {
        self.push(Item::Node(Box::new(Node { token: Token::Integer, line, flags: 0, children: Vec::new(), value: Value::Integer(value) })));
    }

    fn push_number(&mut self, value: f64, line: u32) {
        self.push(Item::Node(Box::new(Node { token: Token::Number, line, flags: 0, children: Vec::new(), value: Value::Number(value) })));
    }

    fn push_string(&mut self, value: Vec<u16>, line: u32, escaped: bool) {
        self.push_string_flagged(value, line, escaped, false);
    }

    /// A plain string literal node that additionally carries
    /// `mxStringLegacyFlag` (bit 2) when its escape scan saw a legacy
    /// octal or `\8`/`\9`. `fxStringNodeHoist` turns that into a
    /// SyntaxError in a strict scope; sloppy code keeps the value.
    fn push_string_legacy(&mut self, value: Vec<u16>, line: u32, escaped: bool, legacy: bool) {
        let mut flags = if escaped { 1 } else { 0 };
        if legacy {
            flags |= flags::STRING_LEGACY;
        }
        self.push(Item::Node(Box::new(Node {
            token: Token::String,
            line,
            flags,
            children: Vec::new(),
            value: Value::Str(value),
        })));
    }

    /// `fxPushStringNode` sets `flags = states[0].escaped`
    /// (`mxStringEscapeFlag`, bit 0). A template cooked value additionally
    /// carries `mxStringErrorFlag` (bit 1) when its escape scan failed, so
    /// the coder can turn it into `undefined` (tagged) or a SyntaxError
    /// (everywhere else). Kept faithful; not surfaced in the dump.
    fn push_string_flagged(&mut self, value: Vec<u16>, line: u32, escaped: bool, error: bool) {
        let mut flags = if escaped { 1 } else { 0 };
        if error {
            flags |= flags::STRING_ERROR;
        }
        self.push(Item::Node(Box::new(Node {
            token: Token::String,
            line,
            flags,
            children: Vec::new(),
            value: Value::Str(value),
        })));
    }

    /// An untagged template's cooked value is coded through `fxStringNodeCode`,
    /// which raises `invalid escape sequence` when the string carries
    /// `mxStringErrorFlag` (a truncated/illegal `\x`/`\u` escape, or a legacy
    /// octal in template position). A *tagged* template never codes the cooked
    /// slot (it emits `undefined` instead), so this fires only for the untagged
    /// primary-position template just built on the stack top.
    fn reject_untagged_template_cooked_error(&self) -> PResult<()> {
        let Some(Item::Node(node)) = self.stack.last() else { return Ok(()) };
        let Some(Item::List(items)) = node.children.get(1) else { return Ok(()) };
        for item in items {
            if let Item::Node(mid) = item {
                if mid.token == Token::TemplateMiddle {
                    if let Some(Item::Node(cooked)) = mid.children.first() {
                        if cooked.flags & flags::STRING_ERROR != 0 {
                            return Err(self.error("invalid escape sequence"));
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn push_raw(&mut self, value: Vec<u16>, line: u32) {
        self.push(Item::Node(Box::new(Node { token: Token::String, line, flags: 0, children: Vec::new(), value: Value::Str(value) })));
    }

    fn push_bigint(&mut self, value: crate::lexer::BigIntLiteral, line: u32) {
        self.push(Item::Node(Box::new(Node { token: Token::Bigint, line, flags: 0, children: Vec::new(), value: Value::BigInt(value) })));
    }

    /// `fxPushNodeStruct` — pop `count` stack items and build a node of
    /// `token`, its children in push order (`children[0]` = first
    /// pushed). Inherits `mxStrictFlag | mxGeneratorFlag | mxAsyncFlag`
    /// from `parser->flags`, as XS does.
    fn push_node_struct(&mut self, count: usize, token: Token, line: u32) -> PResult<()> {
        if count > self.stack.len() {
            return Err(self.error(&format!("invalid {}", node_name(token))));
        }
        let start = self.stack.len() - count;
        let children: Vec<Item> = self.stack.split_off(start);
        let node = Node { token, line, flags: self.flags & flags::INHERITED, children, value: Value::None };
        self.push(Item::Node(Box::new(node)));
        Ok(())
    }

    /// `fxPushNodeList` — pop `count` stack items into a list, in source
    /// order.
    fn push_node_list(&mut self, count: usize) -> PResult<()> {
        if count > self.stack.len() {
            return Err(self.error("invalid list"));
        }
        let start = self.stack.len() - count;
        let items: Vec<Item> = self.stack.split_off(start);
        self.push(Item::List(items));
        Ok(())
    }

    /// `fxSwapNodes` — swap the top two stack items.
    fn swap_nodes(&mut self) {
        let n = self.stack.len();
        self.stack.swap(n - 1, n - 2);
    }

    /// Set flags on the top-of-stack node (`parser->root->flags |= …`).
    fn set_top_flags(&mut self, add: u32) {
        if let Some(Item::Node(node)) = self.stack.last_mut() {
            node.flags |= add;
        }
    }

    /// Overwrite the top-of-stack node's flags word
    /// (`parser->root->flags = …`, as the function/class/program tails do).
    fn set_root_flags(&mut self, value: u32) {
        if let Some(Item::Node(node)) = self.stack.last_mut() {
            node.flags = value;
        }
    }

    /// Build a fresh childful node stamped with the inherited flag subset,
    /// exactly as `fxPushNodeStruct` would (used by the off-stack
    /// cover-grammar binding conversions).
    fn new_inherited_node(&self, token: Token, line: u32, children: Vec<Item>) -> Item {
        Item::Node(Box::new(Node { token, line, flags: self.flags & flags::INHERITED, children, value: Value::None }))
    }

    /// `fxDefineNodeNew(DEFINE, symbol)` + `node->initializer = pop`: pop
    /// the function/value on top and wrap it in a `Define` node keyed by
    /// `symbol`.
    fn push_define(&mut self, symbol: String, line: u32) {
        let init = self.pop();
        self.push(Item::Node(Box::new(Node {
            token: Token::Define,
            line,
            flags: 0,
            children: vec![Item::Symbol(symbol), init],
            value: Value::None,
        })));
    }

    /// Push an already-collected list of items as a `List` slot (the
    /// module declarations collect their specifiers off-stack).
    fn push_node_list_from(&mut self, items: Vec<Item>) -> PResult<()> {
        self.push(Item::List(items));
        Ok(())
    }

    /// `parser->states[1].token` — the one-token lookahead's kind, or
    /// [`Token::NoToken`] if no lookahead is buffered.
    fn ahead_token(&self) -> Token {
        self.ahead.as_ref().map(|s| s.token).unwrap_or(Token::NoToken)
    }

    /// `parser->states[1].crlf` — whether a line terminator precedes the
    /// buffered lookahead token.
    fn ahead_crlf(&self) -> bool {
        self.ahead.as_ref().map(|s| s.crlf).unwrap_or(false)
    }

    fn ahead2_token(&self) -> Token {
        self.ahead2.as_ref().map(|s| s.token).unwrap_or(Token::NoToken)
    }

    /// The symbol of the top-of-stack `Access` node (its `child[0]`), if
    /// any.
    fn top_access_symbol(&self) -> Option<String> {
        if let Some(Item::Node(node)) = self.stack.last() {
            if node.token == Token::Access {
                if let Some(Item::Symbol(s)) = node.children.first() {
                    return Some(s.clone());
                }
            }
        }
        None
    }

    /// The kind of the top-of-stack node, or `None` if it is not a node.
    fn top_token(&self) -> Option<Token> {
        match self.stack.last() {
            Some(Item::Node(node)) => Some(node.token),
            _ => None,
        }
    }

    // --- fxCheckReference / fxCheckArrowFunction / fxCheckStrictSymbol ---

    /// `fxCheckReference` — is the top-of-stack a valid assignment
    /// target for `token`? Unwraps a single-item `Expressions` cover to
    /// its reference, as XS does. Destructuring targets (Array/Object
    /// converted to bindings) are deferred, so an assignment into one
    /// reports [`ParseErrorKind::Unsupported`].
    fn check_reference(&mut self, token: Token) -> PResult<bool> {
        // Unwrap a parenthesized single reference: (x) = …
        if self.top_token() == Some(Token::Expressions) {
            self.unwrap_reference_cover();
        }
        let t = self.top_token();
        match t {
            Some(Token::Access) => {
                // Static Semantics: it is an early Syntax Error to delete an
                // IdentifierReference from strict-mode code. Parenthesized
                // identifiers have already been unwrapped above, so the same
                // check covers `delete ((name))` recursively.
                if token == Token::Delete && self.flags & flags::STRICT != 0 {
                    return Err(self.error("invalid delete (strict mode)"));
                }
                if let Some(sym) = self.top_access_symbol() {
                    self.check_strict_symbol(&sym)?;
                }
                Ok(true)
            }
            Some(Token::Member) | Some(Token::MemberAt) | Some(Token::PrivateMember) | Some(Token::Undefined) => Ok(true),
            _ => {
                if token == Token::Assign {
                    if t == Some(Token::Array) {
                        if self.array_binding_from_expression(Token::Access)? {
                            return Ok(true);
                        }
                    } else if t == Some(Token::Object) {
                        if self.object_binding_from_expression(Token::Access)? {
                            return Ok(true);
                        }
                    }
                }
                if token == Token::Delete {
                    return Ok(true);
                }
                Ok(false)
            }
        }
    }

    /// Collapse `Expressions[ref]` (a single reference in parentheses)
    /// down to the reference itself, iterating through nested covers, as
    /// `fxCheckReference` does.
    fn unwrap_reference_cover(&mut self) {
        loop {
            let single = match self.stack.last() {
                Some(Item::Node(node)) if node.token == Token::Expressions => match node.children.first() {
                    Some(Item::List(items)) if items.len() == 1 => Some(items[0].clone()),
                    _ => None,
                },
                _ => None,
            };
            let Some(item) = single else { return };
            let inner_token = match &item {
                Item::Node(n) => Some(n.token),
                _ => None,
            };
            match inner_token {
                Some(Token::Access) | Some(Token::Member) | Some(Token::MemberAt) | Some(Token::PrivateMember)
                | Some(Token::Undefined) => {
                    self.pop();
                    self.push(item);
                    return;
                }
                Some(Token::Expressions) => {
                    self.pop();
                    self.push(item);
                    // loop again to unwrap the nested cover
                }
                _ => return,
            }
        }
    }

    /// `fxCheckArrowFunction` — none of the top `count` nodes may carry
    /// `mxArrowFlag` (a bare arrow cannot be an operand). Arrows are
    /// deferred here, so an arrow operand cannot arise; kept as a
    /// faithful guard.
    fn check_arrow_function(&mut self, count: usize) -> PResult<()> {
        let n = self.stack.len();
        for i in 0..count {
            if let Some(Item::Node(node)) = self.stack.get(n - 1 - i) {
                if node.flags & flags::ARROW != 0 {
                    return Err(self.error("invalid arrow function"));
                }
            }
        }
        Ok(())
    }

    /// `fxCheckStrictSymbol` — `arguments`/`eval`/`yield` are invalid
    /// reference names in strict mode; `yield` also in a generator.
    fn check_strict_symbol(&self, symbol: &str) -> PResult<()> {
        if self.flags & flags::STRICT != 0 {
            match symbol {
                "arguments" => return Err(self.error("invalid arguments (strict mode)")),
                "eval" => return Err(self.error("invalid eval (strict mode)")),
                "yield" => return Err(self.error("invalid yield (strict mode)")),
                _ => {}
            }
        } else if self.flags & flags::YIELD != 0 && symbol == "yield" {
            return Err(self.error("invalid yield"));
        }
        Ok(())
    }

    // ================= expression cascade =================

    /// `fxCommaExpression`.
    fn comma_expression(&mut self) -> PResult<()> {
        let mut count = 0usize;
        let line = self.cur.line;
        if has_flag(self.cur.token, BEGIN_EXPRESSION) {
            self.assignment_expression()?;
            count += 1;
            while self.cur.token == Token::Comma {
                self.get_next_token()?;
                self.assignment_expression()?;
                count += 1;
            }
        }
        if count > 1 {
            self.push_node_list(count)?;
            self.push_node_struct(1, Token::Expressions, line)?;
        } else if count == 0 {
            self.push_null();
            return Err(self.error("missing expression"));
        }
        Ok(())
    }

    /// `fxAssignmentExpression`. One [`OPERAND_COST`] recursion point: the
    /// right-recursive chains (`a = b = c`, `a ? b : c ? d : e`, the
    /// element/argument/substitution positions) all pass through here.
    fn assignment_expression(&mut self) -> PResult<()> {
        self.nested(OPERAND_COST, |p| p.assignment_expression_inner())
    }

    fn assignment_expression_inner(&mut self) -> PResult<()> {
        if self.cur.token == Token::Yield {
            return self.yield_expression();
        }
        self.conditional_expression()?;
        while has_flag(self.cur.token, ASSIGN_EXPRESSION) {
            let token = self.cur.token;
            let line = self.cur.line;
            if !self.check_reference(token)? {
                return Err(self.error("no reference"));
            }
            self.get_next_token()?;
            self.assignment_expression()?;
            self.push_node_struct(2, token, line)?;
        }
        Ok(())
    }

    /// `fxConditionalExpression`.
    fn conditional_expression(&mut self) -> PResult<()> {
        self.coalesce_expression()?;
        if self.cur.token == Token::QuestionMark {
            let line = self.cur.line;
            self.check_arrow_function(1)?;
            self.get_next_token()?;
            let saved = self.flags & flags::FOR;
            self.flags &= !flags::FOR;
            self.assignment_expression()?;
            self.flags |= saved;
            self.match_token(Token::Colon)?;
            self.assignment_expression()?;
            self.push_node_struct(3, Token::QuestionMark, line)?;
        }
        Ok(())
    }

    /// A left-associative binary ladder rung: parse `next`, then while
    /// the current token has `class_flag`, consume it and another `next`
    /// and fold a 2-child node of that token. Mirrors the shape shared by
    /// `fxOrExpression` … `fxShiftExpression`.
    fn binary_ladder(
        &mut self,
        class_flag: u32,
        next: fn(&mut Self) -> PResult<()>,
    ) -> PResult<()> {
        next(self)?;
        while has_flag(self.cur.token, class_flag) {
            let token = self.cur.token;
            let line = self.cur.line;
            self.get_next_token()?;
            next(self)?;
            self.check_arrow_function(2)?;
            self.push_node_struct(2, token, line)?;
        }
        Ok(())
    }

    /// `fxCoalesceExpression`.
    fn coalesce_expression(&mut self) -> PResult<()> {
        self.or_expression()?;
        while self.cur.token == Token::Coalesce {
            let line = self.cur.line;
            self.get_next_token()?;
            self.or_expression()?;
            self.check_arrow_function(2)?;
            self.push_node_struct(2, Token::Coalesce, line)?;
        }
        Ok(())
    }

    /// `fxOrExpression`.
    fn or_expression(&mut self) -> PResult<()> {
        self.and_expression()?;
        while self.cur.token == Token::Or {
            let line = self.cur.line;
            self.get_next_token()?;
            self.and_expression()?;
            self.check_arrow_function(2)?;
            self.push_node_struct(2, Token::Or, line)?;
        }
        Ok(())
    }

    /// `fxAndExpression`.
    fn and_expression(&mut self) -> PResult<()> {
        self.bit_or_expression()?;
        while self.cur.token == Token::And {
            let line = self.cur.line;
            self.get_next_token()?;
            self.bit_or_expression()?;
            self.check_arrow_function(2)?;
            self.push_node_struct(2, Token::And, line)?;
        }
        Ok(())
    }

    /// `fxBitOrExpression`.
    fn bit_or_expression(&mut self) -> PResult<()> {
        self.bit_xor_expression()?;
        while self.cur.token == Token::BitOr {
            let line = self.cur.line;
            self.get_next_token()?;
            self.bit_xor_expression()?;
            self.check_arrow_function(2)?;
            self.push_node_struct(2, Token::BitOr, line)?;
        }
        Ok(())
    }

    /// `fxBitXorExpression`.
    fn bit_xor_expression(&mut self) -> PResult<()> {
        self.bit_and_expression()?;
        while self.cur.token == Token::BitXor {
            let line = self.cur.line;
            self.get_next_token()?;
            self.bit_and_expression()?;
            self.check_arrow_function(2)?;
            self.push_node_struct(2, Token::BitXor, line)?;
        }
        Ok(())
    }

    /// `fxBitAndExpression`.
    fn bit_and_expression(&mut self) -> PResult<()> {
        self.equal_expression()?;
        while self.cur.token == Token::BitAnd {
            let line = self.cur.line;
            self.get_next_token()?;
            self.equal_expression()?;
            self.check_arrow_function(2)?;
            self.push_node_struct(2, Token::BitAnd, line)?;
        }
        Ok(())
    }

    /// `fxEqualExpression`.
    fn equal_expression(&mut self) -> PResult<()> {
        self.binary_ladder(EQUAL_EXPRESSION, Self::relational_expression)
    }

    /// `fxRelationalExpression` — including the `#private in obj` form
    /// and the `for`-header `in`/`of` short-circuit.
    fn relational_expression(&mut self) -> PResult<()> {
        if self.cur.token == Token::PrivateIdentifier {
            let line = self.cur.line;
            let sym = self.cur.symbol.clone().unwrap_or_default();
            self.push_symbol(sym);
            self.get_next_token()?;
            self.match_token(Token::In)?;
            if self.flags & flags::FOR != 0 {
                return Err(self.error("invalid in"));
            }
            self.shift_expression()?;
            self.check_arrow_function(2)?;
            self.push_node_struct(2, Token::PrivateIdentifier, line)?;
        } else {
            self.shift_expression()?;
            if self.flags & flags::FOR != 0
                && (self.cur.token == Token::In || self.is_keyword("of")?)
            {
                return Ok(());
            }
            while has_flag(self.cur.token, RELATIONAL_EXPRESSION) {
                let token = self.cur.token;
                let line = self.cur.line;
                self.match_token(token)?;
                self.shift_expression()?;
                self.check_arrow_function(2)?;
                self.push_node_struct(2, token, line)?;
            }
        }
        Ok(())
    }

    /// `fxShiftExpression`.
    fn shift_expression(&mut self) -> PResult<()> {
        self.binary_ladder(SHIFT_EXPRESSION, Self::additive_expression)
    }

    /// `fxAdditiveExpression`.
    fn additive_expression(&mut self) -> PResult<()> {
        self.binary_ladder(
            crate::token_flags::ADDITIVE_EXPRESSION,
            Self::multiplicative_expression,
        )
    }

    /// `fxMultiplicativeExpression`.
    fn multiplicative_expression(&mut self) -> PResult<()> {
        self.binary_ladder(
            crate::token_flags::MULTIPLICATIVE_EXPRESSION,
            Self::exponentiation_expression,
        )
    }

    /// `fxExponentiationExpression` — right-associative, and a leading
    /// unary operand cannot be an exponentiation base (`-x ** y` is an
    /// early error handled by routing to `fxUnaryExpression`).
    fn exponentiation_expression(&mut self) -> PResult<()> {
        if has_flag(self.cur.token, UNARY_EXPRESSION) {
            self.unary_expression()
        } else {
            self.prefix_expression()?;
            if has_flag(self.cur.token, EXPONENTIATION_EXPRESSION) {
                let token = self.cur.token;
                let line = self.cur.line;
                self.get_next_token()?;
                self.exponentiation_expression()?;
                self.check_arrow_function(2)?;
                self.push_node_struct(2, token, line)?;
            }
            Ok(())
        }
    }

    /// `fxUnaryExpression` — `+ - ! ~ typeof void delete await`. One
    /// [`OPERAND_COST`] recursion point (`!!!!x` recurses here per operator).
    fn unary_expression(&mut self) -> PResult<()> {
        self.nested(OPERAND_COST, |p| p.unary_expression_inner())
    }

    fn unary_expression_inner(&mut self) -> PResult<()> {
        if has_flag(self.cur.token, UNARY_EXPRESSION) {
            let token = self.cur.token;
            let line = self.cur.line;
            self.match_token(token)?;
            self.unary_expression()?;
            self.check_arrow_function(1)?;
            match token {
                Token::Add => self.push_node_struct(1, Token::Plus, line)?,
                Token::Subtract => self.push_node_struct(1, Token::Minus, line)?,
                Token::Delete => {
                    if !self.check_reference(token)? {
                        return Err(self.error("no reference"));
                    }
                    self.push_node_struct(1, token, line)?;
                }
                Token::Await => {
                    if self.flags & flags::GENERATOR != 0 && self.flags & flags::YIELD == 0 {
                        return Err(self.error("invalid await"));
                    }
                    self.flags |= flags::AWAITING;
                    self.push_node_struct(1, token, line)?;
                }
                _ => self.push_node_struct(1, token, line)?,
            }
            Ok(())
        } else {
            self.prefix_expression()
        }
    }

    /// `fxPrefixExpression` — `++ --`. One [`OPERAND_COST`] recursion point.
    fn prefix_expression(&mut self) -> PResult<()> {
        self.nested(OPERAND_COST, |p| p.prefix_expression_inner())
    }

    fn prefix_expression_inner(&mut self) -> PResult<()> {
        if has_flag(self.cur.token, PREFIX_EXPRESSION) {
            let token = self.cur.token;
            let line = self.cur.line;
            self.get_next_token()?;
            self.prefix_expression()?;
            self.check_arrow_function(1)?;
            if !self.check_reference(token)? {
                return Err(self.error("no reference"));
            }
            self.push_node_struct(1, token, line)?;
            self.set_top_flags(flags::EXPRESSION_NO_VALUE);
            Ok(())
        } else {
            self.postfix_expression()
        }
    }

    /// `fxPostfixExpression` — `x++ x--` (no line terminator before).
    fn postfix_expression(&mut self) -> PResult<()> {
        self.call_expression()?;
        if !self.cur.crlf && has_flag(self.cur.token, POSTFIX_EXPRESSION) {
            let token = self.cur.token;
            let line = self.cur.line;
            self.check_arrow_function(1)?;
            if !self.check_reference(token)? {
                return Err(self.error("no reference"));
            }
            self.push_node_struct(1, token, line)?;
            self.get_next_token()?;
        }
        Ok(())
    }

    /// `fxCallExpression` — the member / call / optional-chaining /
    /// tagged-template postfix loop. The [`CASCADE_COST`] recursion point:
    /// every descent of the precedence cascade reaches here exactly once
    /// before a primary expression re-enters the cascade (a parenthesized
    /// operand, a literal element, an argument, a template substitution, an
    /// arrow body), so this is where a nesting level's full cascade of frames
    /// is charged.
    fn call_expression(&mut self) -> PResult<()> {
        self.nested(CASCADE_COST, |p| p.call_expression_inner())
    }

    fn call_expression_inner(&mut self) -> PResult<()> {
        let chain_line = self.cur.line;
        self.literal_expression(false)?;
        if has_flag(self.cur.token, CALL_EXPRESSION) {
            let mut chain_flag = false;
            self.check_arrow_function(1)?;
            loop {
                let line = self.cur.line;
                match self.cur.token {
                    Token::Dot => {
                        self.get_next_token()?;
                        if self.cur.token == Token::Identifier {
                            let sym = self.cur.symbol.clone().unwrap_or_default();
                            self.push_symbol(sym);
                            self.push_node_struct(2, Token::Member, line)?;
                            self.get_next_token()?;
                        } else if self.cur.token == Token::PrivateIdentifier {
                            let sym = self.cur.symbol.clone().unwrap_or_default();
                            self.push_symbol(sym);
                            self.swap_nodes();
                            self.push_node_struct(2, Token::PrivateMember, line)?;
                            self.get_next_token()?;
                        } else {
                            return Err(self.error("missing property"));
                        }
                    }
                    Token::LeftBracket => {
                        self.get_next_token()?;
                        self.comma_expression()?;
                        self.push_node_struct(2, Token::MemberAt, line)?;
                        self.match_token(Token::RightBracket)?;
                    }
                    Token::LeftParenthesis => {
                        // `fxPostfixExpression` (xsSyntaxical.c): a call whose
                        // callee is a bare `Access` to `eval` sets `mxEvalFlag`
                        // on `parser->flags`. The flag then bubbles out of any
                        // enclosing arrow (`fxArrowExpression`) onto the nearest
                        // non-arrow function node — the parse-time half of the
                        // enclosing-function synthetic capture-closure fold. The
                        // scoper's `hoist_call` sets the *scope* eval poison; this
                        // sets the *node* flag the scoper never wired.
                        if self.top_access_symbol().as_deref() == Some("eval") {
                            self.flags |= flags::EVAL;
                        }
                        self.parameters()?;
                        self.push_node_struct(2, Token::Call, line)?;
                    }
                    Token::Template => {
                        if chain_flag {
                            return Err(self.error("invalid template"));
                        }
                        let (s, r) = self.cur_template_strings();
                        let err = self.cur.string_error;
                        self.push_string_flagged(s, line, false, err);
                        self.push_raw(r, line);
                        self.push_node_struct(2, Token::TemplateMiddle, line)?;
                        self.get_next_token()?;
                        self.push_node_list(1)?;
                        self.push_node_struct(2, Token::Template, line)?;
                    }
                    Token::TemplateHead => {
                        if chain_flag {
                            return Err(self.error("invalid template"));
                        }
                        self.template_expression()?;
                        self.push_node_struct(2, Token::Template, line)?;
                    }
                    Token::Chain => {
                        self.get_next_token()?;
                        chain_flag = true;
                        match self.cur.token {
                            Token::Identifier => {
                                self.push_node_struct(1, Token::Option, line)?;
                                let sym = self.cur.symbol.clone().unwrap_or_default();
                                self.push_symbol(sym);
                                self.push_node_struct(2, Token::Member, line)?;
                                self.get_next_token()?;
                            }
                            Token::PrivateIdentifier => {
                                self.push_node_struct(1, Token::Option, line)?;
                                let sym = self.cur.symbol.clone().unwrap_or_default();
                                self.push_symbol(sym);
                                self.swap_nodes();
                                self.push_node_struct(2, Token::PrivateMember, line)?;
                                self.get_next_token()?;
                            }
                            Token::LeftBracket => {
                                self.push_node_struct(1, Token::Option, line)?;
                                self.get_next_token()?;
                                self.comma_expression()?;
                                self.push_node_struct(2, Token::MemberAt, line)?;
                                self.match_token(Token::RightBracket)?;
                            }
                            Token::LeftParenthesis => {
                                self.push_node_struct(1, Token::Option, line)?;
                                self.parameters()?;
                                self.push_node_struct(2, Token::Call, line)?;
                            }
                            _ => return Err(self.error("invalid ?.")),
                        }
                    }
                    _ => break,
                }
            }
            if chain_flag {
                self.push_node_struct(1, Token::Chain, chain_line)?;
            }
        }
        Ok(())
    }

    /// `fxLiteralExpression` — primary expressions. `no_call` is XS's
    /// `flag` (set from `fxNewExpression`, suppressing `import(` as a
    /// call).
    fn literal_expression(&mut self, no_call: bool) -> PResult<()> {
        let line = self.cur.line;
        match self.cur.token {
            Token::Null | Token::True | Token::False => {
                let token = self.cur.token;
                self.push_node_struct(0, token, line)?;
                self.match_token(token)?;
            }
            Token::Import => self.import_literal(no_call, line)?,
            Token::Super => self.super_literal(line)?,
            Token::This => {
                self.push_node_struct(0, Token::This, line)?;
                self.set_top_flags(self.flags & flags::DERIVED);
                self.match_token(Token::This)?;
            }
            Token::Integer => {
                self.push_integer(self.cur.integer, line);
                self.get_next_token()?;
            }
            Token::Number => {
                self.push_number(self.cur.number, line);
                self.get_next_token()?;
            }
            Token::Bigint => {
                let b = self.cur.bigint.clone().expect("bigint lexeme carries a literal");
                self.push_bigint(b, line);
                self.get_next_token()?;
            }
            Token::Divide | Token::DivideAssign => {
                let divide_assign = self.cur.token == Token::DivideAssign;
                let rx = self.lexer.read_regexp(divide_assign)?;
                self.cur = rx;
                let modifier = self.cur.modifier.clone().unwrap_or_default();
                let body = self.cur.string.clone().unwrap_or_default();
                self.push_string(crate::ast::str_to_units(&modifier), line, false);
                self.push_string(body, line, false);
                self.push_node_struct(2, Token::Regexp, line)?;
                self.get_next_token()?;
            }
            Token::String => {
                let s = self.cur.string.clone().unwrap_or_default();
                let escaped = self.cur.escaped;
                // A plain string literal (unlike a *tagged* template's cooked
                // slot) is coded through `fxStringNodeCode`, which rejects a
                // string carrying `mxStringErrorFlag` — a truncated/illegal
                // `\x`/`\u` escape. That is context-independent (illegal in
                // sloppy mode too), so reject it here. A legacy octal /
                // `\8`/`\9` (`mxStringLegacyFlag`) is a sloppy-mode allowance
                // whose strict-mode illegality is decided later, once the
                // enclosing scope's strictness is known; carry the flag to
                // the node so `hoist_string` can rule on it.
                if self.cur.string_error {
                    return Err(self.error("invalid escape sequence"));
                }
                let legacy = self.cur.legacy_octal;
                self.push_string_legacy(s, line, escaped, legacy);
                self.get_next_token()?;
            }
            Token::Identifier => self.identifier_literal(line)?,
            Token::Class => {
                let saved = self.flags & flags::FOR;
                self.flags &= !flags::FOR;
                self.class_expression(line, None)?;
                self.flags |= saved;
            }
            Token::Function => {
                self.match_token(Token::Function)?;
                if self.cur.token == Token::Multiply {
                    self.get_next_token()?;
                    self.generator_expression(line, None, 0)?;
                } else {
                    self.function_expression(line, None, 0)?;
                }
            }
            Token::New => self.new_expression()?,
            Token::LeftBrace => {
                let saved = self.flags & flags::FOR;
                self.flags &= !flags::FOR;
                self.object_expression()?;
                self.flags |= saved;
            }
            Token::LeftBracket => {
                let saved = self.flags & flags::FOR;
                self.flags &= !flags::FOR;
                self.array_expression()?;
                self.flags |= saved;
            }
            Token::LeftParenthesis => self.group_expression(0)?,
            Token::Template => {
                self.push_null();
                let (s, r) = self.cur_template_strings();
                let err = self.cur.string_error;
                self.push_string_flagged(s, line, false, err);
                self.push_raw(r, line);
                self.push_node_struct(2, Token::TemplateMiddle, line)?;
                self.get_next_token()?;
                self.push_node_list(1)?;
                self.push_node_struct(2, Token::Template, line)?;
                self.reject_untagged_template_cooked_error()?;
            }
            Token::TemplateHead => {
                self.push_null();
                self.template_expression()?;
                self.push_node_struct(2, Token::Template, line)?;
                self.reject_untagged_template_cooked_error()?;
            }
            _ => {
                self.push_node_struct(0, Token::Undefined, line)?;
                return Err(self.error("missing expression"));
            }
        }
        Ok(())
    }

    /// The cooked / raw strings of the current `Template`/`TemplateHead`
    /// lexeme.
    fn cur_template_strings(&self) -> (Vec<u16>, Vec<u16>) {
        (self.cur.string.clone().unwrap_or_default(), self.cur.raw.clone().unwrap_or_default())
    }

    /// `import` in expression position: dynamic `import(...)` or
    /// `import.meta`.
    fn import_literal(&mut self, no_call: bool, line: u32) -> PResult<()> {
        self.match_token(Token::Import)?;
        if !no_call && self.cur.token == Token::LeftParenthesis {
            let saved = self.flags & flags::FOR;
            self.get_next_token()?;
            self.flags &= !flags::FOR;
            self.assignment_expression()?;
            if self.cur.token == Token::Comma {
                self.get_next_token()?;
                if has_flag(self.cur.token, BEGIN_EXPRESSION) {
                    self.assignment_expression()?;
                    if self.cur.token == Token::Comma {
                        self.get_next_token()?;
                    }
                } else {
                    self.push_null();
                }
            } else {
                self.push_null();
            }
            self.flags |= saved;
            self.match_token(Token::RightParenthesis)?;
            self.push_node_struct(2, Token::ImportCall, line)?;
        } else if self.cur.token == Token::Dot {
            self.get_next_token()?;
            if self.cur.token == Token::Identifier
                && self.cur.symbol.as_deref() == Some("source")
                && !self.cur.escaped
            {
                return Err(self.unsupported_error("source-phase import"));
            }
            if self.cur.token == Token::Identifier
                && self.cur.symbol.as_deref() == Some("meta")
                && !self.cur.escaped
            {
                self.get_next_token()?;
                // `import.meta` is an early Syntax Error unless the goal is
                // Module. XS gates on `mxProgramFlag` (set for the script/eval
                // goal, preserved across nested functions via `mxParserFlags`,
                // never set for the module goal), rejecting `import.meta` when
                // present. Mirror that gate on `flags::PROGRAM`.
                if self.flags & flags::PROGRAM != 0 {
                    return Err(self.error("invalid import.meta"));
                }
                self.push_node_struct(0, Token::ImportMeta, line)?;
            } else {
                return Err(self.error("invalid import."));
            }
        } else {
            return Err(self.error("invalid import"));
        }
        Ok(())
    }

    /// `super(...)` / `super.x` / `super[e]`.
    fn super_literal(&mut self, line: u32) -> PResult<()> {
        self.match_token(Token::Super)?;
        if self.cur.token == Token::LeftParenthesis {
            if self.flags & flags::DERIVED != 0 {
                self.parameters()?;
                self.push_node_struct(1, Token::Super, line)?;
            } else {
                self.push_node_struct(0, Token::Undefined, line)?;
                return Err(self.error("invalid super"));
            }
        } else if self.cur.token == Token::Dot || self.cur.token == Token::LeftBracket {
            if self.flags & flags::SUPER != 0 {
                self.push_node_struct(0, Token::This, line)?;
                self.set_top_flags(self.flags & (flags::DERIVED | flags::SUPER));
            } else {
                self.push_node_struct(0, Token::Undefined, line)?;
                return Err(self.error("invalid super"));
            }
        } else {
            return Err(self.error("invalid super"));
        }
        self.flags |= flags::SUPER;
        Ok(())
    }

    /// An identifier in primary position: `x` → `Access`, the async
    /// covers (`async function` / `async (…)` / `async x =>`), or a bare
    /// single-identifier arrow head (`x =>`). Transliterates the
    /// `XS_TOKEN_IDENTIFIER` arm of `fxLiteralExpression`.
    fn identifier_literal(&mut self, line: u32) -> PResult<()> {
        let escaped = self.cur.escaped;
        let mut symbol = self.cur.symbol.clone().unwrap_or_default();
        self.get_next_token()?;
        let mut flag = 0u32;
        if symbol == "async" && !escaped && !self.cur.crlf {
            if self.cur.token == Token::Function {
                self.match_token(Token::Function)?;
                if self.cur.token == Token::Multiply {
                    self.get_next_token()?;
                    self.generator_expression(line, None, flags::ASYNC)?;
                } else {
                    self.function_expression(line, None, flags::ASYNC)?;
                }
                return Ok(());
            }
            if self.cur.token == Token::LeftParenthesis {
                self.group_expression(flags::ASYNC)?;
                return Ok(());
            }
            if self.cur.token == Token::Identifier {
                symbol = self.cur.symbol.clone().unwrap_or_default();
                self.get_next_token()?;
                flag = flags::ASYNC;
            }
        }
        if symbol == "await" {
            self.flags |= flags::AWAITING;
        }
        if !self.cur.crlf && self.cur.token == Token::Arrow {
            self.check_strict_symbol(&symbol)?;
            if flag != 0 && symbol == "await" {
                return Err(self.error("invalid await"));
            }
            // Build a single-parameter ParamsBinding, then the arrow body.
            self.push_symbol(symbol);
            self.push_null();
            self.push_node_struct(2, Token::Arg, line)?;
            self.push_node_list(1)?;
            self.push_node_struct(1, Token::ParamsBinding, line)?;
            self.arrow_expression(flag)?;
            return Ok(());
        }
        if symbol == "arguments" {
            self.flags |= flags::ARGUMENTS;
        }
        // Move the symbol onto the stack and wrap as Access.
        let sym = std::mem::take(&mut symbol);
        self.push_symbol(sym);
        self.push_node_struct(1, Token::Access, line)?;
        Ok(())
    }

    /// `fxArrayExpression` — array literal (elision, spread, elements).
    fn array_expression(&mut self) -> PResult<()> {
        let mut count = 0usize;
        let mut elision = true;
        let line = self.cur.line;
        let mut spread_flag = false;
        self.match_token(Token::LeftBracket)?;
        while self.cur.token == Token::Comma
            || self.cur.token == Token::Spread
            || has_flag(self.cur.token, BEGIN_EXPRESSION)
        {
            let item_line = self.cur.line;
            if self.cur.token == Token::Comma {
                self.get_next_token()?;
                if elision {
                    self.push_node_struct(0, Token::Elision, item_line)?;
                    count += 1;
                } else {
                    elision = true;
                }
            } else if self.cur.token == Token::Spread {
                self.get_next_token()?;
                if !elision {
                    return Err(self.error("missing ,"));
                }
                self.assignment_expression()?;
                self.push_node_struct(1, Token::Spread, item_line)?;
                count += 1;
                elision = false;
                spread_flag = true;
            } else {
                if !elision {
                    return Err(self.error("missing ,"));
                }
                self.assignment_expression()?;
                count += 1;
                elision = false;
            }
        }
        self.match_token(Token::RightBracket)?;
        self.push_node_list(count)?;
        self.push_node_struct(1, Token::Array, line)?;
        if count > 0 && elision {
            self.set_top_flags(flags::ELISION);
        }
        if spread_flag {
            self.set_top_flags(flags::SPREAD);
        }
        Ok(())
    }

    /// `fxObjectExpression` — object literal: data properties (`k: v`,
    /// shorthand `{k}`, cover default `{k = v}`, computed `[e]: v`,
    /// string/number keys, `...spread`) and method / accessor / generator
    /// / async shorthand (`{ m() {} }`, `{ get x() {} }`, `{ *g() {} }`,
    /// `{ async f() {} }`).
    fn object_expression(&mut self) -> PResult<()> {
        let mut count = 0usize;
        let line = self.cur.line;
        self.match_token(Token::LeftBrace)?;
        loop {
            let prop_line = self.cur.line;
            if self.cur.token == Token::RightBrace {
                break;
            }
            if self.cur.token == Token::Spread {
                self.get_next_token()?;
                self.assignment_expression()?;
                self.push_node_struct(1, Token::Spread, prop_line)?;
            } else {
                let (symbol, token0, token1, token2) = self.property_name()?;
                let mut prop_flags = self.property_name_async_flag;
                if token1 == Token::PrivateProperty {
                    return Err(self.error("invalid private property"));
                } else if token2 == Token::Getter || token2 == Token::Setter {
                    prop_flags |= flags::SHORTHAND;
                    if token2 == Token::Getter {
                        prop_flags |= flags::GETTER;
                    } else {
                        prop_flags |= flags::SETTER;
                    }
                    if self.cur.token == Token::LeftParenthesis {
                        self.function_expression(prop_line, None, flags::SUPER)?;
                    } else {
                        return Err(self.error("missing ("));
                    }
                } else if token2 == Token::Generator {
                    prop_flags |= flags::SHORTHAND | flags::METHOD;
                    if self.cur.token == Token::LeftParenthesis {
                        self.generator_expression(prop_line, None, flags::SUPER | prop_flags)?;
                    } else {
                        return Err(self.error("missing ("));
                    }
                } else if token2 == Token::Function {
                    prop_flags |= flags::SHORTHAND | flags::METHOD;
                    if self.cur.token == Token::LeftParenthesis {
                        self.function_expression(prop_line, None, flags::SUPER | prop_flags)?;
                    } else {
                        return Err(self.error("missing ("));
                    }
                } else if self.cur.token == Token::LeftParenthesis {
                    prop_flags |= flags::SHORTHAND | flags::METHOD;
                    self.function_expression(prop_line, None, flags::SUPER | prop_flags)?;
                } else if self.cur.token == Token::Colon {
                    self.get_next_token()?;
                    self.assignment_expression()?;
                } else if token1 == Token::Property {
                    prop_flags |= flags::SHORTHAND;
                    let sym = symbol.clone().unwrap_or_default();
                    self.push_symbol(sym);
                    if self.cur.token == Token::Assign {
                        self.push_node_struct(1, Token::Access, prop_line)?;
                        self.get_next_token()?;
                        self.assignment_expression()?;
                        self.push_node_struct(2, Token::Binding, prop_line)?;
                    } else if token0 == Token::Identifier {
                        self.push_node_struct(1, Token::Access, prop_line)?;
                    } else {
                        self.push_node_struct(0, Token::Undefined, prop_line)?;
                        return Err(self.error("invalid identifier"));
                    }
                } else {
                    self.push_node_struct(0, Token::Undefined, prop_line)?;
                    return Err(self.error("missing :"));
                }
                self.push_node_struct(2, token1, prop_line)?;
                self.set_top_flags(prop_flags);
            }
            count += 1;
            if self.cur.token == Token::RightBrace {
                break;
            }
            self.match_token(Token::Comma)?;
        }
        self.match_token(Token::RightBrace)?;
        self.push_node_list(count)?;
        self.push_node_struct(1, Token::Object, line)?;
        Ok(())
    }

    /// `fxPropertyName` — parse a property key, returning
    /// `(symbol, token0, token1, token2)` and leaving the key on the
    /// stack (a symbol for named/`Property`, an index node for
    /// `PropertyAt`). The accessor/generator/async lookahead
    /// (`token2`) is recognized so callers can reject the deferred
    /// method forms precisely.
    fn property_name(&mut self) -> PResult<(Option<String>, Token, Token, Token)> {
        let mut symbol: Option<String> = None;
        let mut token1 = Token::NoToken;
        let mut token2 = Token::NoToken;
        let line = self.cur.line;
        self.property_name_async_flag = 0;
        self.look_ahead_once()?;
        let token0 = self.cur.token;
        if has_flag(token0, IDENTIFIER_NAME) {
            symbol = self.cur.symbol.clone();
            let ahead_token = self.ahead.as_ref().map(|s| s.token).unwrap_or(Token::NoToken);
            let ahead_crlf = self.ahead.as_ref().map(|s| s.crlf).unwrap_or(false);
            if ahead_token == Token::Colon {
                self.push_symbol(symbol.clone().unwrap_or_default());
                token1 = Token::Property;
            } else if self.is_keyword("async")? && !ahead_crlf {
                self.property_name_async_flag = flags::ASYNC;
                self.get_next_token()?;
                if self.cur.token == Token::Multiply {
                    token2 = Token::Generator;
                    self.get_next_token()?;
                } else {
                    token2 = Token::Function;
                }
            } else if self.is_keyword("get")? {
                token2 = Token::Getter;
                self.get_next_token()?;
            } else if self.is_keyword("set")? {
                token2 = Token::Setter;
                self.get_next_token()?;
            } else {
                self.push_symbol(symbol.clone().unwrap_or_default());
                token1 = Token::Property;
            }
        } else if self.cur.token == Token::Multiply {
            token2 = Token::Generator;
            self.get_next_token()?;
        } else if self.cur.token == Token::PrivateIdentifier {
            symbol = self.cur.symbol.clone();
            self.push_symbol(symbol.clone().unwrap_or_default());
            token1 = Token::PrivateProperty;
        } else if self.cur.token == Token::Integer {
            match self.push_property_index_integer(self.cur.integer, line) {
                None => token1 = Token::PropertyAt,
                Some(s) => { symbol = Some(s); token1 = Token::Property; }
            }
        } else if self.cur.token == Token::Number {
            match self.push_property_index_number(self.cur.number, line) {
                None => token1 = Token::PropertyAt,
                Some(s) => { symbol = Some(s); token1 = Token::Property; }
            }
        } else if self.cur.token == Token::String {
            let s = crate::ast::units_to_string(&self.cur.string.clone().unwrap_or_default());
            // `fxStringToIndex`: a string key that is a canonical array
            // index ("0", "1", … up to 2^32-2) codes through the
            // integer-index (`PropertyAt`) path, exactly as XS does; a
            // non-canonical string ("01", "1.0", "x") stays a symbol.
            if let Some(index) = string_key_to_index(&s) {
                self.push_property_index(index, line);
                token1 = Token::PropertyAt;
            } else {
                self.push_symbol(s.clone());
                symbol = Some(s);
                token1 = Token::Property;
            }
        } else if self.cur.token == Token::LeftBracket {
            self.get_next_token()?;
            self.comma_expression()?;
            if self.cur.token != Token::RightBracket {
                return Err(self.error("missing ]"));
            }
            token1 = Token::PropertyAt;
        } else {
            self.push_null();
            return Err(self.error("missing identifier"));
        }

        if token2 != Token::NoToken {
            // A `get`/`set`/`async`/`*` marker was consumed; parse the
            // real method key that follows.
            if has_flag(self.cur.token, IDENTIFIER_NAME) {
                symbol = self.cur.symbol.clone();
                self.push_symbol(symbol.clone().unwrap_or_default());
                token1 = Token::Property;
                self.get_next_token()?;
            } else if self.cur.token == Token::PrivateIdentifier {
                symbol = self.cur.symbol.clone();
                self.push_symbol(symbol.clone().unwrap_or_default());
                token1 = Token::PrivateProperty;
                self.get_next_token()?;
            } else if self.cur.token == Token::Integer {
                match self.push_property_index_integer(self.cur.integer, line) {
                    None => token1 = Token::PropertyAt,
                    Some(s) => { symbol = Some(s); token1 = Token::Property; }
                }
                self.get_next_token()?;
            } else if self.cur.token == Token::Number {
                match self.push_property_index_number(self.cur.number, line) {
                    None => token1 = Token::PropertyAt,
                    Some(s) => { symbol = Some(s); token1 = Token::Property; }
                }
                self.get_next_token()?;
            } else if self.cur.token == Token::String {
                let s = crate::ast::units_to_string(&self.cur.string.clone().unwrap_or_default());
                if let Some(index) = string_key_to_index(&s) {
                    self.push_property_index(index, line);
                    token1 = Token::PropertyAt;
                } else {
                    self.push_symbol(s.clone());
                    symbol = Some(s);
                    token1 = Token::Property;
                }
                self.get_next_token()?;
            } else if self.cur.token == Token::LeftBracket {
                self.get_next_token()?;
                self.comma_expression()?;
                if self.cur.token != Token::RightBracket {
                    return Err(self.error("missing ]"));
                }
                token1 = Token::PropertyAt;
                self.get_next_token()?;
            } else if token2 == Token::Getter || token2 == Token::Setter {
                // `get` / `set` used as a plain property name.
                self.push_symbol(symbol.clone().unwrap_or_default());
                token1 = Token::Property;
                token2 = Token::NoToken;
            } else {
                self.push_null();
                return Err(self.error("missing identifier"));
            }
        } else {
            // XS's `else fxGetNextToken(parser)` — consume the key token
            // (or the computed-key `]`, or a literal key) so the caller
            // sees the following `:` / `,` / `}` / `=` in `states[0]`.
            self.get_next_token()?;
        }
        Ok((symbol, token0, token1, token2))
    }

    /// XS's `fxPropertyName` integer-key handling: `fxIntegerToIndex`
    /// keeps a non-negative integer as an array index (`fxPushIndexNode`
    /// → `PropertyAt`); otherwise the key canonicalizes to its
    /// `fxIntegerToString` symbol (`Property`). Returns `Some(symbol)`
    /// when a symbol was pushed, `None` when an index node was pushed.
    /// Integer tokens are always non-negative from the lexer, so the
    /// symbol branch is the faithful-but-unreached fallback.
    fn push_property_index_integer(&mut self, value: i32, line: u32) -> Option<String> {
        if value >= 0 {
            self.push_property_index(value as u32, line);
            None
        } else {
            let s = value.to_string();
            self.push_symbol(s.clone());
            Some(s)
        }
    }

    /// XS's `fxPropertyName` numeric-key handling: `fxNumberToIndex`
    /// keeps a canonical array index as an index node (`fxPushIndexNode`
    /// → `PropertyAt`); a non-index number (`.1`, `0.0000001`, a value
    /// at/above 2^32-1) canonicalizes to its `fxNumberToString` symbol
    /// (`Property`). Returns `Some(symbol)` when a symbol was pushed,
    /// `None` when an index node was pushed.
    fn push_property_index_number(&mut self, value: f64, line: u32) -> Option<String> {
        if let Some(index) = number_to_index(value) {
            self.push_property_index(index, line);
            None
        } else {
            let s = number_to_ecma_string(value);
            self.push_symbol(s.clone());
            Some(s)
        }
    }

    /// `fxPushIndexNode`: a `txIndex` that fits a signed integer (below
    /// 2^31) becomes an `Integer` node; a larger index becomes a `Number`
    /// node. Used for the string-key integer-index path (`fxStringToIndex`).
    fn push_property_index(&mut self, index: u32, line: u32) {
        if (index as i32) >= 0 {
            self.push_integer(index as i32, line);
        } else {
            self.push_number(index as f64, line);
        }
    }

    /// `fxTemplateExpression` — a template with substitutions
    /// (`TemplateHead` … `${ expr }` … `TemplateTail`). Leaves a node
    /// list of the items on the stack.
    fn template_expression(&mut self) -> PResult<()> {
        let mut count = 0usize;
        let line = self.cur.line;
        let (s, r) = self.cur_template_strings();
        let err = self.cur.string_error;
        self.push_string_flagged(s, line, false, err);
        self.push_raw(r, line);
        self.push_node_struct(2, Token::TemplateMiddle, line)?;
        count += 1;
        loop {
            self.get_next_token()?;
            if self.cur.token != Token::RightBrace {
                self.comma_expression()?;
                count += 1;
            }
            if self.cur.token != Token::RightBrace {
                return Err(self.error("missing }"));
            }
            // Continue the template string after the closing `}`.
            let part = self.lexer.next_template_part()?;
            self.cur = part;
            let (s, r) = self.cur_template_strings();
            let err = self.cur.string_error;
            self.push_string_flagged(s, line, false, err);
            self.push_raw(r, line);
            self.push_node_struct(2, Token::TemplateMiddle, line)?;
            count += 1;
            if self.cur.token == Token::TemplateTail {
                self.get_next_token()?;
                break;
            }
        }
        self.push_node_list(count)?;
        Ok(())
    }

    /// `fxYieldExpression`.
    fn yield_expression(&mut self) -> PResult<()> {
        let line = self.cur.line;
        if self.flags & flags::YIELD == 0 {
            return Err(self.error("invalid yield"));
        }
        self.flags |= flags::YIELDING;
        self.match_token(Token::Yield)?;
        if !self.cur.crlf && self.cur.token == Token::Multiply {
            self.get_next_token()?;
            self.assignment_expression()?;
            self.push_node_struct(1, Token::Delegate, line)?;
            return Ok(());
        }
        if !self.cur.crlf && has_flag(self.cur.token, BEGIN_EXPRESSION) {
            self.assignment_expression()?;
        } else {
            self.push_node_struct(0, Token::Undefined, line)?;
        }
        self.push_node_struct(1, Token::Yield, line)?;
        Ok(())
    }

    /// `fxParameters` — a parenthesized argument list (`( a, b, ...c )`),
    /// yielding a `Params` node wrapping the argument list.
    fn parameters(&mut self) -> PResult<()> {
        let mut count = 0usize;
        let line = self.cur.line;
        let mut spread_flag = false;
        self.match_token(Token::LeftParenthesis)?;
        while self.cur.token == Token::Spread || has_flag(self.cur.token, BEGIN_EXPRESSION) {
            let param_line = self.cur.line;
            if self.cur.token == Token::Spread {
                self.get_next_token()?;
                self.assignment_expression()?;
                self.push_node_struct(1, Token::Spread, param_line)?;
                spread_flag = true;
            } else {
                self.assignment_expression()?;
            }
            count += 1;
            if self.cur.token != Token::RightParenthesis {
                self.match_token(Token::Comma)?;
            }
        }
        self.match_token(Token::RightParenthesis)?;
        self.push_node_list(count)?;
        self.push_node_struct(1, Token::Params, line)?;
        if spread_flag {
            self.set_top_flags(flags::SPREAD);
        }
        Ok(())
    }

    /// `fxNewExpression` — `new X(...)`, member chains after `new`, and
    /// `new.target`. One [`STATEMENT_COST`] recursion point: `new new new f`
    /// recurses here per operand without passing through the cascade.
    fn new_expression(&mut self) -> PResult<()> {
        self.nested(STATEMENT_COST, |p| p.new_expression_inner())
    }

    fn new_expression_inner(&mut self) -> PResult<()> {
        let line = self.cur.line;
        self.match_token(Token::New)?;
        if self.cur.token == Token::Dot {
            self.get_next_token()?;
            if self.is_keyword("target")? {
                if self.flags & flags::TARGET == 0 {
                    return Err(self.error("invalid new.target"));
                }
                self.get_next_token()?;
                self.push_node_struct(0, Token::Target, line)?;
            } else {
                return Err(self.error("missing target"));
            }
            return Ok(());
        }
        self.literal_expression(true)?;
        self.check_arrow_function(1)?;
        loop {
            let member_line = self.cur.line;
            match self.cur.token {
                Token::Dot => {
                    self.get_next_token()?;
                    if self.cur.token == Token::Identifier {
                        let sym = self.cur.symbol.clone().unwrap_or_default();
                        self.push_symbol(sym);
                        self.push_node_struct(2, Token::Member, member_line)?;
                        self.get_next_token()?;
                    } else if self.cur.token == Token::PrivateIdentifier {
                        let sym = self.cur.symbol.clone().unwrap_or_default();
                        self.push_symbol(sym);
                        self.swap_nodes();
                        self.push_node_struct(2, Token::PrivateMember, member_line)?;
                        self.get_next_token()?;
                    } else {
                        return Err(self.error("missing property"));
                    }
                }
                Token::LeftBracket => {
                    self.get_next_token()?;
                    self.comma_expression()?;
                    self.push_node_struct(2, Token::MemberAt, member_line)?;
                    self.match_token(Token::RightBracket)?;
                }
                Token::Template => {
                    let (s, r) = self.cur_template_strings();
                    let err = self.cur.string_error;
                    self.push_string_flagged(s, line, false, err);
                    self.push_raw(r, line);
                    self.push_node_struct(2, Token::TemplateMiddle, line)?;
                    self.get_next_token()?;
                    self.push_node_list(1)?;
                    self.push_node_struct(2, Token::Template, line)?;
                }
                Token::TemplateHead => {
                    self.template_expression()?;
                    self.push_node_struct(2, Token::Template, line)?;
                }
                _ => break,
            }
        }
        if self.cur.token == Token::LeftParenthesis {
            self.parameters()?;
        } else {
            self.push_node_list(0)?;
            self.push_node_struct(1, Token::Params, line)?;
        }
        self.push_node_struct(2, Token::New, line)?;
        Ok(())
    }

    /// `fxGroupExpression` — a parenthesized expression, and the two
    /// cover grammars it resolves: an arrow head (`( a, b ) => …`,
    /// reparsed via [`Self::parameters_binding_from_expressions`]) and,
    /// when `flag` (async) is set but no `=>` follows, an `async(args)`
    /// call.
    fn group_expression(&mut self, flag: u32) -> PResult<()> {
        let mut comma_flag = false;
        let mut spread_flag = false;
        let mut count = 0usize;
        let saved_await_yield = self.flags & (flags::AWAITING | flags::YIELDING);
        self.flags &= !(flags::AWAITING | flags::YIELDING);
        self.match_token(Token::LeftParenthesis)?;
        let mut line;
        while self.cur.token == Token::Spread || has_flag(self.cur.token, BEGIN_EXPRESSION) {
            line = self.cur.line;
            comma_flag = false;
            if self.cur.token == Token::Spread {
                self.get_next_token()?;
                self.assignment_expression()?;
                self.push_node_struct(1, Token::Spread, line)?;
                spread_flag = true;
            } else {
                self.assignment_expression()?;
            }
            count += 1;
            if self.cur.token != Token::Comma {
                break;
            }
            self.get_next_token()?;
            comma_flag = true;
        }
        line = self.cur.line;
        self.match_token(Token::RightParenthesis)?;
        if !self.cur.crlf && self.cur.token == Token::Arrow {
            self.push_node_list(count)?;
            self.push_node_struct(1, Token::Expressions, line)?;
            if comma_flag && spread_flag {
                return Err(self.error("invalid parameters"));
            }
            if !self.parameters_binding_from_expressions()? {
                return Err(self.error("no parameters"));
            }
            self.check_strict_binding_top();
            self.set_top_flags(flag);
            let mut carry = saved_await_yield;
            if self.flags & flags::AWAITING != 0 {
                if flag != 0 || self.flags & flags::ASYNC != 0 {
                    return Err(self.error("invalid await"));
                }
                carry |= flags::AWAITING;
            }
            if self.flags & flags::YIELDING != 0 {
                return Err(self.error("invalid yield"));
            }
            self.arrow_expression(flag)?;
            self.flags |= carry;
            return Ok(());
        }
        if flag != 0 {
            // `async ( args )` that is NOT an arrow head: an ordinary call
            // of the identifier `async`.
            self.push_node_list(count)?;
            self.push_node_struct(1, Token::Params, line)?;
            if spread_flag {
                self.set_top_flags(flags::SPREAD);
            }
            self.push_symbol("async".to_string());
            self.push_node_struct(1, Token::Access, line)?;
            self.swap_nodes();
            self.push_node_struct(2, Token::Call, line)?;
            self.flags |= saved_await_yield;
            return Ok(());
        }
        if count == 0 || comma_flag {
            self.push_null();
            self.flags |= saved_await_yield;
            return Err(self.error("missing expression"));
        }
        self.push_node_list(count)?;
        self.push_node_struct(1, Token::Expressions, line)?;
        self.flags |= saved_await_yield;
        Ok(())
    }
}

/// A short, stable spelling of a token for error messages (XS uses
/// `gxTokenNames`; this covers the punctuation/keyword tokens the parser
/// reports as "missing X").
fn token_debug(token: Token) -> &'static str {
    use Token::*;
    match token {
        Colon => ":",
        RightBracket => "]",
        RightParenthesis => ")",
        RightBrace => "}",
        LeftParenthesis => "(",
        In => "in",
        Import => "import",
        New => "new",
        Super => "super",
        This => "this",
        Comma => ",",
        _ => node_name(token),
    }
}

/// `fxStringToIndex` (`xsCommon.c`): whether a property-key string is a
/// canonical array-index representation, returning that index. XS parses
/// the string to a number, casts to a `txIndex`, bounds it below
/// 2^32-1, and confirms the number renders back to the *exact* original
/// string (so "01", "1.0", "+1", " 1" are rejected — they do not
/// round-trip). For the property-key surface that reduces to: a
/// non-empty run of ASCII digits, no leading zero (except "0" itself),
/// with value below 2^32-1. Matches `ironhorse_vm::string_to_index`.
fn string_key_to_index(s: &str) -> Option<u32> {
    if s.is_empty() || s.len() > 10 {
        return None;
    }
    let bytes = s.as_bytes();
    if bytes[0] == b'0' && s.len() > 1 {
        return None; // no leading zeros
    }
    if !bytes.iter().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: u64 = s.parse().ok()?;
    if n < 4_294_967_295 {
        Some(n as u32)
    } else {
        None
    }
}

/// `fxNumberToIndex`: a number is a canonical array index when it equals
/// its own `(txIndex)` (u32) truncation and is strictly below the
/// 2^32-1 sentinel. So `.1` / `0.0000001` / a value at or above the
/// sentinel are NOT indices; `0`, `1`, `4294967294` are.
fn number_to_index(number: f64) -> Option<u32> {
    // C's `(txIndex)number` truncates toward zero into a u32; `as u32`
    // matches for the finite non-negative in-range values that reach an
    // affirmative result, and saturates harmlessly otherwise (the
    // equality re-check below rejects any saturated value).
    let integer = number as u32;
    if number == integer as f64 && integer < 4_294_967_295 {
        Some(integer)
    } else {
        None
    }
}

/// The ECMAScript `Number::toString(10)` rendering (spec 6.1.6.1.20) —
/// XS's `fxNumberToString` / dtoa. Mirrors
/// `ironhorse_vm::value::number_to_ecma_string` (ironhorse-compile does not
/// depend on ironhorse-vm), producing the canonical string a non-index
/// numeric property key becomes (`fxNewParserSymbol(fxNumberToString…)`).
fn number_to_ecma_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".to_string();
    }
    if n.is_infinite() {
        return if n < 0.0 { "-Infinity" } else { "Infinity" }.to_string();
    }
    if n == 0.0 {
        // Covers +0 and -0; JS String(-0) === "0".
        return "0".to_string();
    }
    let sign = if n < 0.0 { "-" } else { "" };
    let abs = n.abs();
    // Rust's `{:e}` gives the shortest round-tripping mantissa (one digit
    // before the point, trailing zeros stripped) and its base-10 exponent.
    let exp = format!("{:e}", abs);
    let (mantissa, exp10) = match exp.split_once('e') {
        Some((m, e)) => (m, e.parse::<i32>().unwrap_or(0)),
        None => return format!("{}{}", sign, abs),
    };
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let s = digits.trim_end_matches('0');
    let s = if s.is_empty() { "0" } else { s };
    let k = s.len() as i32;
    let point = exp10 + 1;
    let body = if k <= point && point <= 21 {
        let mut out = String::from(s);
        out.push_str(&"0".repeat((point - k) as usize));
        out
    } else if 0 < point && point <= 21 {
        format!("{}.{}", &s[..point as usize], &s[point as usize..])
    } else if -6 < point && point <= 0 {
        format!("0.{}{}", "0".repeat((-point) as usize), s)
    } else {
        let e = point - 1;
        let esign = if e >= 0 { "+" } else { "-" };
        let head = if k == 1 {
            s.to_string()
        } else {
            format!("{}.{}", &s[..1], &s[1..])
        };
        format!("{}e{}{}", head, esign, e.abs())
    };
    format!("{}{}", sign, body)
}

mod stmt;

#[cfg(test)]
mod tests;
