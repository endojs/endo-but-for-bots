//! The scanner, a transliteration of `fxGetNextTokenAux` and friends in
//! `c/moddable/xs/sources/xsLexical.c` at the oracle pin.
//!
//! It reads a `&str` and yields [`Lexeme`]s. The control flow — which
//! character opens which token, how numbers and strings and templates
//! and regular expressions are scanned, how line terminators and the
//! ASI-relevant `crlf` flag are tracked, how contextual keywords are
//! classified — follows XS statement for statement so the parser and
//! coder built on top see EXACTLY what XS sees.
//!
//! Two deliberate departures from XS, neither affecting the token
//! stream this stage is judged on (byte-identity is child-1-out-of-scope):
//! ironhorse decodes the source as UTF-8 scalar values rather than CESU-8
//! (astral characters are single `char`s, so XS's surrogate-pair
//! combining is a no-op on valid UTF-8), and cooked/raw strings are
//! `String`s rather than CESU-8 byte runs. Regexp *validation* stays with
//! `ironhorse-regexp`; this scanner only delimits the literal (raw body +
//! flags), exactly as `fxGetNextRegExp` does before handing off.

use crate::error::{LexError, LexErrorKind};
use crate::meter::ParseMeter;
use crate::token::{classify_word, Token};
use crate::unicode::{is_identifier_first, is_identifier_next};

/// The end-of-input sentinel, XS's `(txU4)C_EOF`.
const EOF: u32 = 0xFFFF_FFFF;

/// A BigInt literal as scanned: the significant digits with prefix,
/// separators and the `n` suffix stripped, plus the radix. The numeric
/// value is materialized later (parser/coder stage); the scanner's job is
/// only to delimit and classify.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BigIntLiteral {
    /// Cleaned significant digits (no `0x`/`0o`/`0b`, no `_`, no `n`).
    pub digits: String,
    /// 2, 8, 10, or 16.
    pub radix: u8,
}

/// One scanned token with the surrounding data XS records in a
/// `sxParserState`, plus ironhorse-added byte offsets for later line tables.
#[derive(Clone, Debug, PartialEq)]
pub struct Lexeme {
    /// The classified token.
    pub token: Token,
    /// 1-based source line, as XS's `state.line` counts it.
    pub line: u32,
    /// Byte offset of the first character of the token (ironhorse addition).
    pub start: usize,
    /// Byte offset just past the token (ironhorse addition).
    pub end: usize,
    /// A line terminator was crossed while skipping to this token — XS's
    /// `state.crlf`, the flag ASI consults.
    pub crlf: bool,
    /// A `\` escape occurred in this token (identifier or string) — XS's
    /// `state.escaped` low bit.
    pub escaped: bool,
    /// The cooked string value, for `String`/`Template*`/regexp body,
    /// carried as UTF-16 code units so lone surrogates from `\u` escapes
    /// survive to the coder's CESU-8 emission (see [`ast::Value::Str`]).
    pub string: Option<Vec<u16>>,
    /// The raw (pre-cook) string value, for `String`/`Template*`, likewise
    /// UTF-16 code units.
    pub raw: Option<Vec<u16>>,
    /// Regexp flags (the `modifier`), for `Regexp`.
    pub modifier: Option<String>,
    /// The number value, for `Number` (and available for `Integer`).
    pub number: f64,
    /// The integer value, for `Integer`.
    pub integer: i32,
    /// The BigInt literal, for `Bigint`.
    pub bigint: Option<BigIntLiteral>,
    /// The identifier / keyword / private-name text, for word tokens.
    pub symbol: Option<String>,
    /// A legacy (non-simple) octal string escape or `\8`/`\9` occurred —
    /// XS's `mxStringLegacyFlag`, a sloppy-mode-only allowance.
    pub legacy_octal: bool,
    /// A malformed escape (`\x`/`\u`) occurred in a string — XS's
    /// `mxStringErrorFlag`. The parser turns this into a SyntaxError only
    /// where the grammar forbids it (e.g. a tagged template still parses).
    pub string_error: bool,
}

impl Lexeme {
    fn blank() -> Lexeme {
        Lexeme {
            token: Token::NoToken,
            line: 1,
            start: 0,
            end: 0,
            crlf: false,
            escaped: false,
            string: None,
            raw: None,
            modifier: None,
            number: 0.0,
            integer: 0,
            bigint: None,
            symbol: None,
            legacy_octal: false,
            string_error: false,
        }
    }
}

/// The lexer. Holds the character cursor (XS's `character`/`lookahead`
/// two-char window), the running line, the mode flags XS keeps in
/// `parser->flags`, and the parse meter threaded from the first token.
pub struct Lexer {
    chars: Vec<char>,
    /// Byte offset of each char in `chars`, plus a final total-length
    /// entry so `offsets[i]` is always valid up to `chars.len()`.
    offsets: Vec<usize>,
    /// Index into `chars` of the char currently in `lookahead`.
    next_index: usize,
    /// XS's `parser->character`: the current, not-yet-consumed char.
    ch: u32,
    /// XS's `parser->lookahead`: one char ahead.
    la: u32,
    /// Byte offset of the char currently in `ch` (or source length at EOF).
    ch_offset: usize,
    /// 1-based line, XS's `state.line`, running across tokens.
    line: u32,
    /// `mxStrictFlag`.
    strict: bool,
    /// `mxAsyncFlag` — gates the contextual `await` keyword.
    async_ctx: bool,
    /// `mxGeneratorFlag` — gates the contextual `yield` keyword.
    generator_ctx: bool,
    /// `mxCFlag` — enables the `@` host token. Off for ordinary JS.
    host: bool,
    /// The last token returned, for the `.default` / `?.default`
    /// member-name exception in `fxGetNextKeyword`.
    prev_token: Token,
    /// The parse meter (ironhorse's own frozen cost table).
    meter: ParseMeter,
}

impl Lexer {
    /// A fresh lexer over `source`, in sloppy mode with the host `@`
    /// token disabled (ordinary-JS defaults).
    pub fn new(source: &str) -> Lexer {
        let chars: Vec<char> = source.chars().collect();
        let mut offsets = Vec::with_capacity(chars.len() + 1);
        let mut b = 0usize;
        for c in &chars {
            offsets.push(b);
            b += c.len_utf8();
        }
        offsets.push(b);
        let mut lexer = Lexer {
            chars,
            offsets,
            next_index: 0,
            ch: EOF,
            la: EOF,
            ch_offset: 0,
            line: 1,
            strict: false,
            async_ctx: false,
            generator_ctx: false,
            host: false,
            prev_token: Token::NoToken,
            meter: ParseMeter::new(),
        };
        // Prime the two-char window (XS calls fxGetNextCharacter twice).
        lexer.la = lexer.read_code();
        lexer.advance();
        lexer.ch_offset = 0;
        lexer
    }

    /// Enable strict-mode reserved words (`mxStrictFlag`).
    pub fn set_strict(&mut self, on: bool) {
        self.strict = on;
    }

    /// Gate the contextual `await` keyword (`mxAsyncFlag`).
    pub fn set_async(&mut self, on: bool) {
        self.async_ctx = on;
    }

    /// Gate the contextual `yield` keyword (`mxGeneratorFlag`).
    pub fn set_generator(&mut self, on: bool) {
        self.generator_ctx = on;
    }

    /// Enable the host `@` token (`mxCFlag`).
    pub fn set_host(&mut self, on: bool) {
        self.host = on;
    }

    /// The parse meter, for telemetry after a scan.
    pub fn meter(&self) -> &ParseMeter {
        &self.meter
    }

    // --- character cursor (fxGetNextCharacter / fxGetNextCode) ---

    fn read_code(&mut self) -> u32 {
        if self.next_index < self.chars.len() {
            let c = self.chars[self.next_index] as u32;
            self.next_index += 1;
            c
        } else {
            self.next_index += 1;
            EOF
        }
    }

    fn advance(&mut self) {
        // The offset of the char moving into `ch` is the offset of the
        // char that was in `la`, i.e. `next_index - 1` positions back.
        let la_index = self.next_index.wrapping_sub(1);
        self.ch = self.la;
        self.ch_offset = if la_index < self.offsets.len() {
            self.offsets[la_index]
        } else {
            *self.offsets.last().unwrap()
        };
        if self.ch != EOF {
            self.la = self.read_code();
        }
    }

    // --- classification helpers ---

    fn is_line_terminator(c: u32) -> bool {
        matches!(c, 10 | 13 | 0x2028 | 0x2029)
    }

    fn is_whitespace(c: u32) -> bool {
        matches!(
            c,
            9 | 11
                | 12
                | 32
                | 0x00A0
                | 0x1680
                | 0x2000
                | 0x2001
                | 0x2002
                | 0x2003
                | 0x2004
                | 0x2005
                | 0x2006
                | 0x2007
                | 0x2008
                | 0x2009
                | 0x200A
                | 0x202F
                | 0x205F
                | 0x3000
                | 0xFEFF
        )
    }

    fn err(&self, kind: LexErrorKind) -> LexError {
        LexError {
            line: self.line,
            kind,
        }
    }

    /// `fxSkipShebang` — at the very start of a program or module,
    /// consume a leading `#!` hashbang comment through the end of its
    /// line, leaving the cursor on the line terminator (or EOF) so the
    /// next scan counts the line break as XS does. Only a `#`
    /// immediately followed by `!` is a hashbang; a bare `#` (or `#x`)
    /// is left untouched for the normal scanner — XS reports it as an
    /// invalid character, and ironhorse rejects it downstream just as
    /// surely (a top-level private name is illegal), so ACCEPT/REJECT
    /// agrees either way. Gating on the `#!` pair keeps this safe to
    /// call unconditionally, including ahead of a `#x in obj`
    /// private-in expression.
    pub fn skip_shebang(&mut self) {
        if self.ch == '#' as u32 && self.la == '!' as u32 {
            self.advance(); // consume '#'
            self.advance(); // consume '!'
            while self.ch != EOF && !Lexer::is_line_terminator(self.ch) {
                self.advance();
            }
        }
    }

    /// Produce the next token, transliterating `fxGetNextTokenAux`, and
    /// charge the parse meter once for it (including EOF).
    pub fn next(&mut self) -> Result<Lexeme, LexError> {
        let lexeme = self.scan()?;
        self.meter.charge_token();
        self.prev_token = lexeme.token;
        Ok(lexeme)
    }

    fn scan(&mut self) -> Result<Lexeme, LexError> {
        let mut st = Lexeme::blank();
        loop {
            // `st.crlf` persists across whitespace/comment iterations — a
            // newline skipped before the token sets it and it stays set.
            st.line = self.line;
            st.start = self.ch_offset;
            match self.ch {
                EOF => {
                    st.token = Token::Eof;
                    break;
                }
                10 | 0x2028 | 0x2029 => {
                    self.line += 1;
                    self.advance();
                    st.crlf = true;
                }
                13 => {
                    self.line += 1;
                    self.advance();
                    if self.ch == 10 {
                        self.advance();
                    }
                    st.crlf = true;
                }
                c if Self::is_whitespace(c) => {
                    self.advance();
                }
                c if c <= 0x7F => match c as u8 {
                b'0' => {
                    self.scan_zero(&mut st)?;
                }
                b'1'..=b'9' => {
                    self.scan_number_e(&mut st, false)?;
                }
                b'.' => {
                    self.advance();
                    let c = self.ch;
                    if c == b'.' as u32 {
                        self.advance();
                        if self.ch == b'.' as u32 {
                            st.token = Token::Spread;
                            self.advance();
                        } else {
                            return Err(self.err(LexErrorKind::UnexpectedCharacter(self.ch)));
                        }
                    } else if (b'0' as u32..=b'9' as u32).contains(&c) {
                        self.scan_number_e(&mut st, true)?;
                    } else {
                        st.token = Token::Dot;
                    }
                }
                b',' => {
                    st.token = Token::Comma;
                    self.advance();
                }
                b';' => {
                    st.token = Token::Semicolon;
                    self.advance();
                }
                b':' => {
                    st.token = Token::Colon;
                    self.advance();
                }
                b'?' => {
                    self.advance();
                    if self.ch == b'.' as u32 {
                        if !(b'0' as u32..=b'9' as u32).contains(&self.la) {
                            st.token = Token::Chain;
                            self.advance();
                        } else {
                            st.token = Token::QuestionMark;
                        }
                    } else if self.ch == b'?' as u32 {
                        st.token = Token::Coalesce;
                        self.advance();
                        if self.ch == b'=' as u32 {
                            st.token = Token::CoalesceAssign;
                            self.advance();
                        }
                    } else {
                        st.token = Token::QuestionMark;
                    }
                }
                b'(' => {
                    st.token = Token::LeftParenthesis;
                    self.advance();
                }
                b')' => {
                    st.token = Token::RightParenthesis;
                    self.advance();
                }
                b'[' => {
                    st.token = Token::LeftBracket;
                    self.advance();
                }
                b']' => {
                    st.token = Token::RightBracket;
                    self.advance();
                }
                b'{' => {
                    st.token = Token::LeftBrace;
                    self.advance();
                }
                b'}' => {
                    st.token = Token::RightBrace;
                    self.advance();
                }
                b'=' => {
                    self.advance();
                    if self.ch == b'=' as u32 {
                        self.advance();
                        if self.ch == b'=' as u32 {
                            st.token = Token::StrictEqual;
                            self.advance();
                        } else {
                            st.token = Token::Equal;
                        }
                    } else if self.ch == b'>' as u32 {
                        st.token = Token::Arrow;
                        self.advance();
                    } else {
                        st.token = Token::Assign;
                    }
                }
                b'<' => {
                    self.advance();
                    if self.ch == b'<' as u32 {
                        self.advance();
                        if self.ch == b'=' as u32 {
                            st.token = Token::LeftShiftAssign;
                            self.advance();
                        } else {
                            st.token = Token::LeftShift;
                        }
                    } else if self.ch == b'=' as u32 {
                        st.token = Token::LessEqual;
                        self.advance();
                    } else {
                        st.token = Token::Less;
                    }
                }
                b'>' => {
                    self.advance();
                    if self.ch == b'>' as u32 {
                        self.advance();
                        if self.ch == b'>' as u32 {
                            self.advance();
                            if self.ch == b'=' as u32 {
                                st.token = Token::UnsignedRightShiftAssign;
                                self.advance();
                            } else {
                                st.token = Token::UnsignedRightShift;
                            }
                        } else if self.ch == b'=' as u32 {
                            st.token = Token::SignedRightShiftAssign;
                            self.advance();
                        } else {
                            st.token = Token::SignedRightShift;
                        }
                    } else if self.ch == b'=' as u32 {
                        st.token = Token::MoreEqual;
                        self.advance();
                    } else {
                        st.token = Token::More;
                    }
                }
                b'!' => {
                    self.advance();
                    if self.ch == b'=' as u32 {
                        self.advance();
                        if self.ch == b'=' as u32 {
                            st.token = Token::StrictNotEqual;
                            self.advance();
                        } else {
                            st.token = Token::NotEqual;
                        }
                    } else {
                        st.token = Token::Not;
                    }
                }
                b'~' => {
                    st.token = Token::BitNot;
                    self.advance();
                }
                b'&' => {
                    self.advance();
                    if self.ch == b'=' as u32 {
                        st.token = Token::BitAndAssign;
                        self.advance();
                    } else if self.ch == b'&' as u32 {
                        st.token = Token::And;
                        self.advance();
                        if self.ch == b'=' as u32 {
                            st.token = Token::AndAssign;
                            self.advance();
                        }
                    } else {
                        st.token = Token::BitAnd;
                    }
                }
                b'|' => {
                    self.advance();
                    if self.ch == b'=' as u32 {
                        st.token = Token::BitOrAssign;
                        self.advance();
                    } else if self.ch == b'|' as u32 {
                        st.token = Token::Or;
                        self.advance();
                        if self.ch == b'=' as u32 {
                            st.token = Token::OrAssign;
                            self.advance();
                        }
                    } else {
                        st.token = Token::BitOr;
                    }
                }
                b'^' => {
                    self.advance();
                    if self.ch == b'=' as u32 {
                        st.token = Token::BitXorAssign;
                        self.advance();
                    } else {
                        st.token = Token::BitXor;
                    }
                }
                b'+' => {
                    self.advance();
                    if self.ch == b'=' as u32 {
                        st.token = Token::AddAssign;
                        self.advance();
                    } else if self.ch == b'+' as u32 {
                        st.token = Token::Increment;
                        self.advance();
                    } else {
                        st.token = Token::Add;
                    }
                }
                b'-' => {
                    self.advance();
                    if self.ch == b'=' as u32 {
                        st.token = Token::SubtractAssign;
                        self.advance();
                    } else if self.ch == b'-' as u32 {
                        st.token = Token::Decrement;
                        self.advance();
                    } else {
                        st.token = Token::Subtract;
                    }
                }
                b'*' => {
                    self.advance();
                    if self.ch == b'=' as u32 {
                        st.token = Token::MultiplyAssign;
                        self.advance();
                    } else if self.ch == b'*' as u32 {
                        self.advance();
                        if self.ch == b'=' as u32 {
                            st.token = Token::ExponentiationAssign;
                            self.advance();
                        } else {
                            st.token = Token::Exponentiation;
                        }
                    } else {
                        st.token = Token::Multiply;
                    }
                }
                b'/' => {
                    self.advance();
                    if self.ch == b'*' as u32 {
                        self.scan_block_comment(&mut st)?;
                    } else if self.ch == b'/' as u32 {
                        self.scan_line_comment();
                    } else if self.ch == b'=' as u32 {
                        st.token = Token::DivideAssign;
                        self.advance();
                    } else {
                        st.token = Token::Divide;
                    }
                }
                b'%' => {
                    self.advance();
                    if self.ch == b'=' as u32 {
                        st.token = Token::ModuloAssign;
                        self.advance();
                    } else {
                        st.token = Token::Modulo;
                    }
                }
                b'"' | b'\'' => {
                    let c = self.ch;
                    self.advance();
                    self.scan_string(&mut st, c)?;
                    st.token = Token::String;
                    self.advance();
                }
                b'`' => {
                    self.advance();
                    self.scan_string(&mut st, b'`' as u32)?;
                    if self.ch == b'{' as u32 {
                        st.token = Token::TemplateHead;
                    } else {
                        st.token = Token::Template;
                    }
                    self.advance();
                }
                b'@' => {
                    if self.host {
                        st.token = Token::Host;
                    } else {
                        return Err(self.err(LexErrorKind::InvalidAtSign));
                    }
                    self.advance();
                }
                _ => {
                    self.scan_identifier(&mut st)?;
                }
                },
                _ => {
                    self.scan_identifier(&mut st)?;
                }
            }
            if st.token != Token::NoToken {
                break;
            }
        }
        st.end = self.ch_offset;
        Ok(st)
    }

    // --- comments ---

    fn scan_block_comment(&mut self, st: &mut Lexeme) -> Result<(), LexError> {
        self.advance();
        loop {
            match self.ch {
                EOF => return Err(self.err(LexErrorKind::UnterminatedComment)),
                10 | 0x2028 | 0x2029 => {
                    self.line += 1;
                    self.advance();
                    st.crlf = true;
                }
                13 => {
                    self.line += 1;
                    self.advance();
                    if self.ch == 10 {
                        self.advance();
                    }
                    st.crlf = true;
                }
                c if c == b'*' as u32 => {
                    self.advance();
                    if self.ch == b'/' as u32 {
                        self.advance();
                        break;
                    }
                }
                _ => self.advance(),
            }
        }
        Ok(())
    }

    /// A `//` comment. XS also honors `//# @line`, `sourceMappingURL` and
    /// `sourceURL` pragmas here; the `@line N "path"` form rewrites the
    /// current line, so it is ported (it affects every token after).
    fn scan_line_comment(&mut self) {
        self.advance();
        let mut body = String::new();
        while self.ch != EOF && !Self::is_line_terminator(self.ch) {
            body.push(char::from_u32(self.ch).unwrap_or('\u{FFFD}'));
            self.advance();
        }
        let bytes = body.as_bytes();
        if bytes.first() == Some(&b'#') || bytes.first() == Some(&b'@') {
            if let Some(rest) = body.strip_prefix("#line ").or_else(|| body.strip_prefix("@line "))
            {
                // "@line N" or "@line N \"path\"": reset the line counter.
                let mut n: u32 = 0;
                let mut saw = false;
                for c in rest.chars() {
                    if c.is_ascii_digit() {
                        n = n.wrapping_mul(10).wrapping_add((c as u8 - b'0') as u32);
                        saw = true;
                    } else {
                        break;
                    }
                }
                if saw && n != 0 {
                    self.line = n.saturating_sub(1);
                }
            }
            // sourceMappingURL / sourceURL pragmas carry no lexical effect
            // for ironhorse (no debugger wiring in this crate yet); recognized
            // for parity but their payloads are dropped.
        }
    }

    // --- numbers ---

    fn scan_zero(&mut self, st: &mut Lexeme) -> Result<(), LexError> {
        self.advance();
        let c = self.ch;
        if c == b'.' as u32 {
            self.advance();
            let d = self.ch;
            if (b'0' as u32..=b'9' as u32).contains(&d) || d == b'e' as u32 || d == b'E' as u32 {
                self.scan_number_e(st, true)?;
            } else {
                st.number = 0.0;
                st.token = Token::Number;
            }
        } else if c == b'b' as u32 || c == b'B' as u32 {
            self.scan_number_radix(st, 2)?;
        } else if c == b'e' as u32 || c == b'E' as u32 || c == b'n' as u32 {
            self.scan_number_e(st, false)?;
        } else if c == b'o' as u32 || c == b'O' as u32 {
            self.scan_number_octal(st, false)?;
        } else if c == b'x' as u32 || c == b'X' as u32 {
            self.scan_number_radix(st, 16)?;
        } else if (b'0' as u32..=b'9' as u32).contains(&c) {
            if self.strict {
                return Err(self.err(LexErrorKind::StrictOctal));
            }
            self.scan_number_octal(st, true)?;
        } else {
            st.integer = 0;
            st.token = Token::Integer;
        }
        Ok(())
    }

    /// Port of `fxGetNextDigits`: read a run of digits (via `pred`),
    /// allowing single `_` separators between digit groups but rejecting
    /// leading/trailing/doubled ones and (when `empty`) an empty run.
    fn scan_digits<F>(&mut self, buf: &mut String, mut pred: F, mut empty: bool) -> Result<(), LexError>
    where
        F: FnMut(u32) -> bool,
    {
        let mut separator = false;
        loop {
            let before = buf.len();
            while pred(self.ch) {
                buf.push(char::from_u32(self.ch).unwrap());
                self.advance();
            }
            if before < buf.len() {
                empty = false;
                separator = false;
                if self.ch == b'_' as u32 {
                    self.advance();
                    separator = true;
                } else {
                    break;
                }
            } else {
                break;
            }
        }
        if empty || separator {
            return Err(self.err(LexErrorKind::InvalidNumber));
        }
        Ok(())
    }

    fn radix_pred(radix: u8) -> fn(u32) -> bool {
        match radix {
            2 => |c: u32| (b'0' as u32..=b'1' as u32).contains(&c),
            16 => |c: u32| {
                (b'0' as u32..=b'9' as u32).contains(&c)
                    || (b'a' as u32..=b'f' as u32).contains(&c)
                    || (b'A' as u32..=b'F' as u32).contains(&c)
            },
            _ => |c: u32| (b'0' as u32..=b'7' as u32).contains(&c),
        }
    }

    /// `0b`/`0x` (radix 2 or 16). Ports `fxGetNextNumberB`/`X`.
    fn scan_number_radix(&mut self, st: &mut Lexeme, radix: u8) -> Result<(), LexError> {
        self.advance(); // consume the b/B/x/X
        let mut buf = String::new();
        let pred = Self::radix_pred(radix);
        self.scan_digits(&mut buf, pred, true)?;
        self.finish_integer_or_bigint_radix(st, &buf, radix)
    }

    /// Octal: either modern `0o…` (`legacy=false`) or legacy leading-zero
    /// `0…` (`legacy=true`). Ports `fxGetNextNumberO`.
    fn scan_number_octal(&mut self, st: &mut Lexeme, legacy: bool) -> Result<(), LexError> {
        let mut buf = String::new();
        let radix: u8;
        if legacy {
            // fxGetNextDigitsD: read 0-9, bumping to base 10 if an 8/9 shows.
            let mut base = 8u8;
            while (b'0' as u32..=b'9' as u32).contains(&self.ch) {
                if (b'8' as u32..=b'9' as u32).contains(&self.ch) {
                    base = 10;
                }
                buf.push(char::from_u32(self.ch).unwrap());
                self.advance();
            }
            if self.ch == b'_' as u32 || self.ch == b'n' as u32 {
                return Err(self.err(LexErrorKind::InvalidNumber));
            }
            radix = base;
        } else {
            self.advance(); // consume the o/O
            self.scan_digits(&mut buf, Self::radix_pred(8), true)?;
            radix = 8;
        }
        self.finish_integer_or_bigint_radix(st, &buf, radix)
    }

    /// The `n` suffix and the "identifier char cannot abut a number" check
    /// shared by the radix scanners, then INTEGER / NUMBER / BIGINT.
    fn finish_integer_or_bigint_radix(
        &mut self,
        st: &mut Lexeme,
        buf: &str,
        radix: u8,
    ) -> Result<(), LexError> {
        let bigint = self.ch == b'n' as u32;
        if bigint {
            self.advance();
        }
        if is_identifier_first(self.ch) {
            return Err(self.err(LexErrorKind::InvalidNumber));
        }
        if bigint {
            st.bigint = Some(BigIntLiteral {
                digits: buf.to_string(),
                radix,
            });
            st.token = Token::Bigint;
        } else {
            let mut n = 0.0f64;
            for c in buf.chars() {
                let d = c.to_digit(radix as u32).unwrap_or(0) as f64;
                n = n * radix as f64 + d;
            }
            self.finish_number(st, n);
        }
        Ok(())
    }

    /// Port of `fxGetNextNumberE`: decimal integer/fraction/exponent, plus
    /// the decimal BigInt case. Builds a normalized numeric string and
    /// converts with correctly-rounded `f64` parsing.
    fn scan_number_e(&mut self, st: &mut Lexeme, dot0: bool) -> Result<(), LexError> {
        let mut buf = String::new();
        let mut dot = dot0;
        if dot {
            buf.push('.');
        }
        self.scan_digits(&mut buf, |c| (b'0' as u32..=b'9' as u32).contains(&c), false)?;
        let mut had_fraction = dot;
        if !dot && self.ch == b'.' as u32 {
            dot = true;
            had_fraction = true;
            buf.push('.');
            self.advance();
            self.scan_digits(&mut buf, |c| (b'0' as u32..=b'9' as u32).contains(&c), false)?;
        }
        let mut c = self.ch;
        if c == b'e' as u32 || c == b'E' as u32 {
            if had_fraction {
                if buf.ends_with('.') {
                    buf.push('0');
                }
            } else {
                dot = true;
                buf.push('.');
                buf.push('0');
            }
            buf.push('e');
            self.advance();
            c = self.ch;
            if c == b'+' as u32 || c == b'-' as u32 {
                buf.push(char::from_u32(c).unwrap());
                self.advance();
            }
            self.scan_digits(&mut buf, |c| (b'0' as u32..=b'9' as u32).contains(&c), true)?;
        }
        let bigint = self.ch == b'n' as u32;
        if bigint {
            self.advance();
        }
        if is_identifier_first(self.ch) {
            return Err(self.err(LexErrorKind::InvalidNumber));
        }
        if bigint {
            if dot {
                return Err(self.err(LexErrorKind::InvalidNumber));
            }
            st.bigint = Some(BigIntLiteral {
                digits: buf,
                radix: 10,
            });
            st.token = Token::Bigint;
        } else {
            // A leading '.' with an empty integer part still parses in Rust
            // (".5" -> 0.5); a trailing '.' ("5.") does too via manual fix.
            let normalized = if buf.starts_with('.') {
                format!("0{buf}")
            } else if buf.ends_with('.') {
                format!("{buf}0")
            } else {
                buf.clone()
            };
            let n = normalized.parse::<f64>().unwrap_or(f64::NAN);
            self.finish_number(st, n);
        }
        Ok(())
    }

    /// Port of `fxGetNextNumber`: choose INTEGER when the value is an exact
    /// `i32`, else NUMBER.
    fn finish_number(&mut self, st: &mut Lexeme, n: f64) {
        st.number = n;
        let i = n as i32;
        if n == i as f64 {
            st.integer = i;
            st.token = Token::Integer;
        } else {
            st.token = Token::Number;
        }
    }

    // --- strings & templates ---

    /// Port of `fxGetNextString`: scan the raw body up to the closing
    /// delimiter `c` (`"`, `'`, or `` ` ``), then cook escapes. On entry
    /// `self.ch` is the first body char.
    fn scan_string(&mut self, st: &mut Lexeme, c: u32) -> Result<(), LexError> {
        let mut raw = String::new();
        loop {
            match self.ch {
                EOF => return Err(self.err(LexErrorKind::UnterminatedString)),
                10 => {
                    self.line += 1;
                    if c == b'`' as u32 {
                        raw.push('\n');
                        self.advance();
                    } else {
                        return Err(self.err(LexErrorKind::LineTerminatorInString));
                    }
                }
                13 => {
                    self.line += 1;
                    if c == b'`' as u32 {
                        raw.push('\n');
                        self.advance();
                        if self.ch == 10 {
                            self.advance();
                        }
                    } else {
                        return Err(self.err(LexErrorKind::LineTerminatorInString));
                    }
                }
                0x2028 | 0x2029 => {
                    self.line += 1;
                    raw.push(char::from_u32(self.ch).unwrap());
                    self.advance();
                }
                ch if ch == c => break,
                ch if ch == b'$' as u32 => {
                    self.advance();
                    if c == b'`' as u32 && self.ch == b'{' as u32 {
                        break;
                    }
                    raw.push('$');
                }
                ch if ch == b'\\' as u32 => {
                    st.escaped = true;
                    raw.push('\\');
                    self.advance();
                    match self.ch {
                        10 | 0x2028 | 0x2029 => {
                            self.line += 1;
                            raw.push(char::from_u32(self.ch).unwrap());
                            self.advance();
                        }
                        13 => {
                            self.line += 1;
                            raw.push('\n');
                            self.advance();
                            if self.ch == 10 {
                                self.advance();
                            }
                        }
                        EOF => { /* trailing backslash: leave raw ending in '\\' */ }
                        other => {
                            raw.push(char::from_u32(other).unwrap());
                            self.advance();
                        }
                    }
                }
                other => {
                    raw.push(char::from_u32(other).unwrap());
                    self.advance();
                }
            }
        }
        st.raw = Some(crate::ast::str_to_units(&raw));
        if st.escaped {
            let (cooked, legacy, error) = self.cook_string(&raw, c == b'`' as u32);
            st.legacy_octal = legacy;
            st.string_error = error;
            st.string = Some(cooked);
        } else {
            // The raw body is verbatim UTF-8 source (no lone surrogates),
            // so its code units are the cooked value too.
            st.string = Some(crate::ast::str_to_units(&raw));
        }
        Ok(())
    }

    /// Port of `fxGetNextString`'s cooking pass: resolve escapes in `raw`,
    /// returning `(cooked, legacy_octal, error)`. `template` gates the
    /// legacy-octal-in-template error XS raises.
    fn cook_string(&self, raw: &str, template: bool) -> (Vec<u16>, bool, bool) {
        let chars: Vec<char> = raw.chars().collect();
        let mut out: Vec<u16> = Vec::new();
        let mut legacy = false;
        let mut error = false;
        let mut i = 0usize;
        while i < chars.len() {
            if chars[i] == '\\' {
                i += 1;
                if i >= chars.len() {
                    break;
                }
                match chars[i] {
                    '\n' | '\u{2028}' | '\u{2029}' => {
                        i += 1;
                    }
                    '\r' => {
                        i += 1;
                        if i < chars.len() && chars[i] == '\n' {
                            i += 1;
                        }
                    }
                    'b' => {
                        out.push(0x08);
                        i += 1;
                    }
                    'f' => {
                        out.push(0x0C);
                        i += 1;
                    }
                    'n' => {
                        out.push(0x0A);
                        i += 1;
                    }
                    'r' => {
                        out.push(0x0D);
                        i += 1;
                    }
                    't' => {
                        out.push(0x09);
                        i += 1;
                    }
                    'v' => {
                        out.push(0x0B);
                        i += 1;
                    }
                    'x' => {
                        i += 1;
                        if let Some(ch) = parse_hex_escape(&chars, &mut i) {
                            push_unit(&mut out, ch);
                        } else {
                            error = true;
                        }
                    }
                    'u' => {
                        i += 1;
                        if let Some(ch) = parse_unicode_escape(&chars, &mut i) {
                            push_unit(&mut out, ch);
                        } else {
                            error = true;
                        }
                    }
                    '0'..='7' => {
                        let first = chars[i] as u32 - '0' as u32;
                        i += 1;
                        let next_is_digit =
                            i < chars.len() && ('0'..='9').contains(&chars[i]);
                        if first == 0 && !next_is_digit {
                            out.push(0);
                        } else {
                            legacy = true;
                            let mut value = first;
                            if first <= 3 {
                                if i < chars.len() && ('0'..='7').contains(&chars[i]) {
                                    value = value * 8 + (chars[i] as u32 - '0' as u32);
                                    i += 1;
                                }
                            }
                            if i < chars.len() && ('0'..='7').contains(&chars[i]) {
                                value = value * 8 + (chars[i] as u32 - '0' as u32);
                                i += 1;
                            }
                            push_unit(&mut out, value);
                        }
                    }
                    '8' | '9' => {
                        legacy = true;
                        push_char_unit(&mut out, chars[i]);
                        i += 1;
                    }
                    other => {
                        push_char_unit(&mut out, other);
                        i += 1;
                    }
                }
            } else {
                push_char_unit(&mut out, chars[i]);
                i += 1;
            }
        }
        if template && legacy {
            error = true;
        }
        (out, legacy, error)
    }

    /// Continue a template after a `${…}` substitution's closing `}`, per
    /// `fxGetNextTokenTemplate`. Precondition: `self.ch` is the first char
    /// after the `}`. Yields `TemplateMiddle` or `TemplateTail`.
    pub fn next_template_part(&mut self) -> Result<Lexeme, LexError> {
        let mut st = Lexeme::blank();
        st.line = self.line;
        st.start = self.ch_offset;
        self.scan_string(&mut st, b'`' as u32)?;
        if self.ch == b'{' as u32 {
            st.token = Token::TemplateMiddle;
        } else {
            st.token = Token::TemplateTail;
        }
        self.advance();
        st.end = self.ch_offset;
        self.meter.charge_token();
        self.prev_token = st.token;
        Ok(st)
    }

    // --- regular expressions ---

    /// Port of `fxGetNextRegExp`: delimit a regexp literal. The parser
    /// calls this in expression position after the scanner has already
    /// returned `Divide` (`divide_assign = false`, body starts at the
    /// current char) or `DivideAssign` (`divide_assign = true`, the `=`
    /// re-enters as the first body char). Validation is `ironhorse-regexp`'s.
    pub fn read_regexp(&mut self, divide_assign: bool) -> Result<Lexeme, LexError> {
        let mut st = Lexeme::blank();
        st.line = self.line;
        st.start = self.ch_offset;
        let mut body = String::new();
        let mut backslash = false;
        let mut bracket = false;
        let mut first = true;
        let mut c: u32;
        let mut pending; // XS's `second`: use `c` before advancing.
        if divide_assign {
            c = b'=' as u32;
            pending = true;
        } else {
            c = self.ch;
            pending = false;
        }
        loop {
            if c == EOF {
                return Err(self.err(LexErrorKind::UnterminatedRegExp));
            } else if Self::is_line_terminator(c) {
                return Err(self.err(LexErrorKind::LineTerminatorInRegExp));
            } else if c == b'*' as u32 {
                if first {
                    return Err(self.err(LexErrorKind::InvalidRegExp));
                }
                backslash = false;
            } else if c == b'\\' as u32 {
                backslash = !backslash;
            } else if c == b'[' as u32 {
                if !backslash {
                    bracket = true;
                }
                backslash = false;
            } else if c == b']' as u32 {
                if !backslash {
                    bracket = false;
                }
                backslash = false;
            } else if c == b'/' as u32 {
                if !backslash && !bracket {
                    break;
                }
                backslash = false;
            } else {
                backslash = false;
            }
            body.push(char::from_u32(c).unwrap());
            if pending {
                pending = false;
            } else {
                self.advance();
            }
            c = self.ch;
            first = false;
        }
        st.string = Some(crate::ast::str_to_units(&body));
        // Flags: XS advances past the closing '/', then reads id-continue.
        let mut flags = String::new();
        loop {
            self.advance();
            if is_identifier_next(self.ch) {
                flags.push(char::from_u32(self.ch).unwrap());
            } else {
                break;
            }
        }
        // XS's lexer runs `fxCompileRegExp` on the delimited literal
        // (`fxGetNextRegExp`), so a syntactically invalid pattern or flag
        // set is a parse-time error, not a runtime one. Mirror that through
        // the ported parser: a genuine `Syntax` rejection rejects the
        // literal here; an `Unsupported` surface (a feature whose SYNTAX XS
        // accepts but whose matcher code ironhorse has not ported yet) is not a
        // syntax error, so the literal stands and accept/reject still agrees
        // with the oracle.
        match ironhorse_regexp::compile::compile(&body, &flags) {
            Ok(_) | Err(ironhorse_regexp::compile::CompileError::Unsupported(_)) => {}
            Err(ironhorse_regexp::compile::CompileError::Syntax(_)) => {
                return Err(self.err(LexErrorKind::InvalidRegExp));
            }
        }
        st.modifier = Some(flags);
        st.token = Token::Regexp;
        st.end = self.ch_offset;
        self.meter.charge_token();
        self.prev_token = st.token;
        Ok(st)
    }

    // --- identifiers ---

    /// Port of `fxGetNextTokenAux`'s default case: private names, plain
    /// identifiers, and `\u`-escaped identifiers, then keyword lookup.
    fn scan_identifier(&mut self, st: &mut Lexeme) -> Result<(), LexError> {
        let mut buf = String::new();
        let private = self.ch == b'#' as u32;
        if private {
            buf.push('#');
            self.advance();
        }
        let mut ok = true;
        if is_identifier_first(self.ch) {
            buf.push(char::from_u32(self.ch).unwrap());
            self.advance();
        } else if self.ch == b'\\' as u32 {
            st.escaped = true;
            match self.read_identifier_escape()? {
                Some(v) if is_identifier_first(v) => push_scalar(&mut buf, v),
                _ => ok = false,
            }
        } else {
            ok = false;
        }
        if ok {
            loop {
                if is_identifier_next(self.ch) {
                    buf.push(char::from_u32(self.ch).unwrap());
                    self.advance();
                } else if self.ch == b'\\' as u32 {
                    st.escaped = true;
                    match self.read_identifier_escape()? {
                        Some(v) if is_identifier_next(v) => push_scalar(&mut buf, v),
                        _ => {
                            ok = false;
                            break;
                        }
                    }
                } else {
                    if private {
                        st.symbol = Some(buf.clone());
                        st.token = Token::PrivateIdentifier;
                    } else {
                        // fxGetNextKeyword: after '.'/'?.' a word is always
                        // an identifier (member name), never a keyword.
                        st.symbol = Some(buf.clone());
                        if self.prev_token == Token::Dot || self.prev_token == Token::Chain {
                            st.token = Token::Identifier;
                        } else {
                            st.token = classify_word(
                                &buf,
                                self.strict,
                                self.async_ctx,
                                self.generator_ctx,
                            );
                        }
                    }
                    break;
                }
            }
        }
        if !ok {
            return Err(self.err(LexErrorKind::InvalidEscape));
        }
        Ok(())
    }

    /// Port of `fxGetNextIdentiferX`: a `\uXXXX` or `\u{…}` escape in
    /// identifier position. On entry `self.ch` is the `\`. Returns the
    /// decoded scalar, or `None` if malformed.
    fn read_identifier_escape(&mut self) -> Result<Option<u32>, LexError> {
        self.advance(); // consume '\'
        if self.ch != b'u' as u32 {
            return Ok(None);
        }
        self.advance();
        let mut value: u32 = 0;
        if self.ch == b'{' as u32 {
            self.advance();
            let mut any = false;
            while let Some(d) = hex_digit(self.ch) {
                value = value.wrapping_mul(16).wrapping_add(d);
                any = true;
                self.advance();
            }
            if any && self.ch == b'}' as u32 {
                self.advance();
                return Ok(Some(value));
            }
            Ok(None)
        } else {
            for _ in 0..4 {
                match hex_digit(self.ch) {
                    Some(d) => {
                        value = value * 16 + d;
                        self.advance();
                    }
                    None => return Ok(None),
                }
            }
            Ok(Some(value))
        }
    }
}

// --- free helpers ---

fn hex_digit(c: u32) -> Option<u32> {
    match c {
        d if (b'0' as u32..=b'9' as u32).contains(&d) => Some(d - b'0' as u32),
        d if (b'a' as u32..=b'f' as u32).contains(&d) => Some(10 + d - b'a' as u32),
        d if (b'A' as u32..=b'F' as u32).contains(&d) => Some(10 + d - b'A' as u32),
        _ => None,
    }
}

fn hex_of(c: char, value: &mut u32) -> bool {
    match c {
        '0'..='9' => *value = *value * 16 + (c as u32 - '0' as u32),
        'a'..='f' => *value = *value * 16 + (10 + c as u32 - 'a' as u32),
        'A'..='F' => *value = *value * 16 + (10 + c as u32 - 'A' as u32),
        _ => return false,
    }
    true
}

/// Push a scalar value, tolerating lone surrogates (which XS keeps as
/// CESU-8) by substituting the replacement char in ironhorse's UTF-8 world.
fn push_scalar(out: &mut String, value: u32) {
    out.push(char::from_u32(value).unwrap_or('\u{FFFD}'));
}

/// Push a cooked scalar (from a `\x`/`\u` escape) as UTF-16 code units — a
/// BMP scalar or a *lone surrogate* (`\uD800`, which a JS string may carry
/// unpaired) is one unit; an astral scalar (a combined `\uXXXX\uXXXX` pair
/// or `\u{…}` above the BMP) is its surrogate pair. XS's cook stores the
/// same units (it re-splits astral scalars in `fxCESU8Encode`).
fn push_unit(out: &mut Vec<u16>, value: u32) {
    if value < 0x1_0000 {
        out.push(value as u16);
    } else {
        let v = value - 0x1_0000;
        out.push((0xD800 + (v >> 10)) as u16);
        out.push((0xDC00 + (v & 0x3FF)) as u16);
    }
}

/// Push a verbatim source `char` (astral scalars are single `char`s in
/// valid UTF-8 input) as its UTF-16 code units.
fn push_char_unit(out: &mut Vec<u16>, c: char) {
    let mut buf = [0u16; 2];
    out.extend_from_slice(c.encode_utf16(&mut buf));
}

/// Port of `fxParseHexEscape`: exactly two hex digits from `chars[*i]`.
fn parse_hex_escape(chars: &[char], i: &mut usize) -> Option<u32> {
    let mut value = 0u32;
    for _ in 0..2 {
        let c = *chars.get(*i)?;
        if !hex_of(c, &mut value) {
            return None;
        }
        *i += 1;
    }
    Some(value)
}

/// Port of `fxParseUnicodeEscape` (braces=1, separator='\\'): `\u{…}` or
/// `\uXXXX`, combining a following `\uXXXX` low surrogate into an astral
/// scalar when the first is a high surrogate.
fn parse_unicode_escape(chars: &[char], i: &mut usize) -> Option<u32> {
    let first = *chars.get(*i)?;
    if first == '{' {
        *i += 1;
        let mut value = 0u32;
        let mut any = false;
        while value < 0x0011_0000 {
            match chars.get(*i) {
                Some(&c) if hex_of(c, &mut value) => {
                    any = true;
                    *i += 1;
                }
                _ => break,
            }
        }
        if chars.get(*i) == Some(&'}') && any && value < 0x0011_0000 {
            *i += 1;
            return Some(value);
        }
        return None;
    }
    let mut value = 0u32;
    for _ in 0..4 {
        let c = *chars.get(*i)?;
        if !hex_of(c, &mut value) {
            return None;
        }
        *i += 1;
    }
    // Surrogate-pair combining: a high surrogate followed by `\uXXXX` low.
    if (0xD800..=0xDBFF).contains(&value) && chars.get(*i) == Some(&'\\') {
        let save = *i;
        *i += 1;
        if chars.get(*i) == Some(&'u') {
            *i += 1;
            let mut other = 0u32;
            let mut ok = true;
            for _ in 0..4 {
                match chars.get(*i) {
                    Some(&c) if hex_of(c, &mut other) => *i += 1,
                    _ => {
                        ok = false;
                        break;
                    }
                }
            }
            if ok && (0xDC00..=0xDFFF).contains(&other) {
                return Some(0x0001_0000 + ((value & 0x03FF) << 10) + (other & 0x03FF));
            }
        }
        *i = save; // no valid low surrogate; leave the high surrogate as-is
    }
    Some(value)
}

#[cfg(test)]
mod tests;
