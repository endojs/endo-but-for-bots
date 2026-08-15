//! The XSRE pattern compiler: a faithful transliteration of the
//! `fxCompileRegExp` pipeline in `xsre.c` — recursive-descent parse into
//! a term tree, a `measure` pass that assigns each term its byte offset
//! in the code array, and a `code` pass that emits the integer step
//! stream the [`crate::matcher`] VM interprets.
//!
//! Offsets (`step`, `completion`, `loop_off`, `sequel`) are kept in
//! **bytes** exactly as XS keeps them (`sizeof(txInteger) == 4`), so
//! the compile meter (`parser->size * XS_PARSE_REGEXP_METERING`) is
//! bit-exact and the emitted graph is structurally identical, which in
//! turn makes the matcher's per-step meter bit-exact.
//!
//! Honest scope (the stage bar names deferred surfaces): inline modifiers
//! (`(?flags:...)`) and astral
//! (`> 0xFFFF`) code points outside unicode mode are compiled to a
//! named [`CompileError::Unsupported`], never to a wrong meter or a wrong
//! value. The `i` flag and named captures (`(?<name>)` / `\k<name>`) ARE
//! ported: a named group codegens identically to its numbered peer, plus a
//! name-slot operand the matcher records into its runtime `names[]` array.

use crate::encoding::{utf8_decode, C_EOF};
use crate::flags::*;
use crate::opcode::*;

/// Why a pattern did not compile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompileError {
    /// A genuine syntax error — the same outcome XS reports through
    /// `fxCompileRegExp` returning 0. The string is a short reason.
    Syntax(String),
    /// A pin feature this stage has not ported yet. Named, never a wrong
    /// answer (the stage's honest-skip bar).
    Unsupported(&'static str),
}

/// A compiled pattern: the integer code array plus the derived counts
/// the matcher and its scratch data need, and the compile-phase meter.
#[derive(Debug, Clone)]
pub struct Program {
    /// The emitted step stream. Byte offset `b` lives at word `b / 4`.
    pub code: Vec<i32>,
    /// `code[1]`: total captures including the whole match at index 0.
    pub capture_count: usize,
    /// `code[2]`: named-capture count.
    pub name_count: usize,
    /// `code[3]`: assertion (lookaround) count.
    pub assertion_count: usize,
    /// `code[4]`: quantifier count.
    pub quantifier_count: usize,
    /// Compile meter in raw 16.16 fixed point:
    /// `size_bytes * XS_PARSE_REGEXP_METERING`.
    pub compile_meter_raw: u64,
    /// The declared named-capture groups in first-seen (name-slot) order:
    /// `(name, capture_index)`. The JS `RegExp` surface reads this to build
    /// the `.groups` object on an exec result (`fxCaptureName*`); the matcher
    /// itself only needs the numeric slots in the code stream.
    pub capture_group_names: Vec<(String, i32)>,
}

impl Program {
    /// `compile_meter_raw >> 16`, the integer compile computrons.
    pub fn compile_computrons(&self) -> u64 {
        self.compile_meter_raw >> 16
    }
    /// The flags word the compiler resolved (`code[0]`), which may add
    /// `XS_REGEXP_N` when the pattern declares a named capture.
    pub fn flags(&self) -> u32 {
        self.code[0] as u32
    }
}

type NodeId = usize;

/// A term-tree node. Layout fields (`step`/`completion`/`loop_off`) are
/// filled by [`Compiler::measure`] and read by [`Compiler::code`],
/// mirroring the `txTermPart` header and the per-term struct fields.
#[derive(Debug)]
struct Node {
    kind: Kind,
    step: i32,
    completion: i32,
    loop_off: i32,
}

#[derive(Debug)]
enum Kind {
    /// A sorted list of half-open ranges: `chars[0]` = endpoint count,
    /// then `chars[1..=count]` = `[b0,e0), [b1,e1), ...`.
    CharSet {
        chars: Vec<i32>,
        /// Parser-only v-mode strings, sorted exactly as XS sorts them:
        /// longest first, then descending UTF-8 byte order. Before measure,
        /// [`Compiler::charset_strings_disjunction`] lowers these to ordinary
        /// disjunction/sequence/charset nodes, so the emitted matcher program
        /// remains byte-for-byte the XS shape.
        strings: Vec<Vec<u32>>,
    },
    Empty,
    LineBegin,
    LineEnd,
    WordBreak,
    WordContinue,
    Disjunction {
        left: NodeId,
        right: NodeId,
    },
    Sequence {
        left: NodeId,
        right: NodeId,
    },
    Capture {
        term: NodeId,
        capture_index: i32,
        name_slot: i32,
    },
    CaptureReference {
        capture_index: i32,
        name_slot: i32,
    },
    Assertion {
        term: NodeId,
        not: bool,
        direction: i32,
        assertion_index: i32,
    },
    Quantifier {
        term: NodeId,
        min: i32,
        max: i32,
        greedy: bool,
        capture_index: i32,
        capture_count: i32,
        quantifier_index: i32,
    },
}

/// The XS `0x7FFFFFFF` open-max sentinel (`*`, `+`, `{n,}`).
const MAX_QUANTIFIER: i32 = 0x7FFF_FFFF;

struct Compiler {
    pattern: Vec<u8>, // NUL-terminated
    offset: usize,
    character: i64,
    flags: u32,
    capture_index: i32,
    name_index: i32,
    assertion_index: i32,
    quantifier_index: i32,
    size: i64, // parser->size, in bytes
    nodes: Vec<Node>,
    code: Vec<i32>,
    /// A pin feature whose SYNTAX this parser validates but whose matcher
    /// code it does not emit yet (inline
    /// modifiers, astral). Set during the parse; when set, [`compile`]
    /// returns it as `Unsupported` *after* the full accept/reject decision,
    /// so a syntactically invalid such pattern is still a `Syntax` error
    /// (the lexer needs the accept/reject verdict; the matcher does not run).
    unsupported: Option<&'static str>,
    /// Defined named-capture group names, in first-seen order — the
    /// `firstCaptureName` chain. A repeat is `mxDuplicateCapture`.
    capture_names: Vec<String>,
    /// `\k<name>` references collected during the parse; each must resolve
    /// to a defined name (`fxCaptureNameGet`, else `mxInvalidReferenceName`).
    named_refs: Vec<String>,
    /// Whether a named-capture *group* was seen — XS's `XS_REGEXP_N`, which
    /// (in the non-`UV` path) forces the second parse where `\k` becomes a
    /// named backreference.
    saw_named_group: bool,
    /// The declared named groups in name-slot order: `(name, capture_index)`.
    /// Slot `i` is `code[5 + i]` in XS; the matcher's runtime `names[]` array
    /// resolves a `\k<name>` reference through it.
    named_groups: Vec<(String, i32)>,
    /// `(node, name)` for each `\k<name>` reference, resolved to its name slot
    /// after the whole pattern is parsed (a forward reference is legal, so the
    /// slot is not known at the point the reference is read).
    pending_named_refs: Vec<(NodeId, String)>,
}

type PResult<T> = Result<T, CompileError>;

/// Compile `pattern` under the `flags` modifier string (e.g. `"gm"`).
///
/// Returns the [`Program`] on success, or a [`CompileError`] — a genuine
/// syntax error, or a named unsupported feature (the stage's honest
/// skip).
pub fn compile(pattern: &str, flags: &str) -> PResult<Program> {
    let mut parser_flags: u32 = 0;
    // Flag modifier parse (fxCompileRegExp head).
    for c in flags.bytes() {
        match c {
            b'g' if parser_flags & XS_REGEXP_G == 0 => parser_flags |= XS_REGEXP_G,
            b'i' if parser_flags & XS_REGEXP_I == 0 => parser_flags |= XS_REGEXP_I,
            b'm' if parser_flags & XS_REGEXP_M == 0 => parser_flags |= XS_REGEXP_M,
            b's' if parser_flags & XS_REGEXP_S == 0 => parser_flags |= XS_REGEXP_S,
            b'u' if parser_flags & (XS_REGEXP_U | XS_REGEXP_V) == 0 => parser_flags |= XS_REGEXP_U,
            b'y' if parser_flags & XS_REGEXP_Y == 0 => parser_flags |= XS_REGEXP_Y,
            b'd' if parser_flags & XS_REGEXP_D == 0 => parser_flags |= XS_REGEXP_D,
            b'v' if parser_flags & (XS_REGEXP_U | XS_REGEXP_V) == 0 => parser_flags |= XS_REGEXP_V,
            _ => return Err(CompileError::Syntax("invalid flags".into())),
        }
    }
    let mut pattern_bytes = pattern.as_bytes().to_vec();
    pattern_bytes.push(0);
    let mut c = Compiler {
        pattern: pattern_bytes,
        offset: 0,
        character: 0,
        flags: parser_flags,
        capture_index: 0,
        name_index: 0,
        assertion_index: 0,
        quantifier_index: 0,
        size: 0,
        nodes: Vec::new(),
        code: Vec::new(),
        unsupported: None,
        capture_names: Vec::new(),
        named_refs: Vec::new(),
        saw_named_group: false,
        named_groups: Vec::new(),
        pending_named_refs: Vec::new(),
    };
    // Core u/v scalar execution and character-valued Unicode properties run
    // for real. Only syntax that actually uses v's string/set-expression
    // extension is marked unsupported at its parse site.
    c.compile_pattern()
}

impl Compiler {
    fn compile_pattern(&mut self) -> PResult<Program> {
        self.next()?;
        let mut term = self.disjunction_parse(C_EOF)?;
        // `fxCompileRegExp`: a named-capture *group* sets XS_REGEXP_N, and
        // in the non-`UV` path that forces a full second parse where `\k`
        // is now read as a named backreference (it was an identity escape
        // in the first pass). Re-run the parse with N latched so the `\k`
        // atoms and the name/reference tables are collected under the
        // final grammar; the accept/reject verdict comes from this pass.
        if self.saw_named_group {
            self.flags |= XS_REGEXP_N;
            if self.flags & (XS_REGEXP_U | XS_REGEXP_V) == 0 {
                self.reset_for_reparse();
                self.next()?;
                term = self.disjunction_parse(C_EOF)?;
            }
        }
        self.capture_index += 1;
        // Validate numeric backreferences now that the final capture count
        // is known — `fxCaptureReferenceMeasure` errors on an out-of-range
        // number (e.g. `\11` with fewer than 11 groups; XS reads the whole
        // decimal greedily and rejects, it does not fall back to `\1`).
        for node in &self.nodes {
            if let Kind::CaptureReference { capture_index, .. } = &node.kind {
                if *capture_index >= 0 && *capture_index >= self.capture_index {
                    return Err(self.error("invalid reference number"));
                }
            }
        }
        // `\k<name>` references resolve against the defined group names
        // (`fxCaptureNameGet`); an unresolved name is `mxInvalidReferenceName`
        // (a dangling groupname — a `SyntaxError`).
        for name in &self.named_refs {
            if !self.capture_names.iter().any(|n| n == name) {
                return Err(self.error("invalid reference name"));
            }
        }
        // Resolve each `\k<name>` reference to its group's name slot. The
        // reference emits `capture_index = -1` and this slot as its name-id
        // operand; the matcher's runtime `names[]` array (populated when the
        // named group completes) maps the slot to the live capture index. A
        // slot always exists here — the dangling-name check above already ran.
        for (node_id, name) in std::mem::take(&mut self.pending_named_refs) {
            let slot = self
                .named_groups
                .iter()
                .position(|(n, _)| n == &name)
                .expect("named reference resolved after the dangling-name check")
                as i32;
            if let Kind::CaptureReference { name_slot, .. } = &mut self.nodes[node_id].kind {
                *name_slot = slot;
            }
        }
        // A syntactically valid pattern that uses a matcher surface this
        // stage has not ported (inline
        // modifiers, astral) is accepted by the oracle at parse time; the
        // lexer treats this `Unsupported` as accept. Bail here, AFTER the
        // full accept/reject decision, so an invalid such pattern is still
        // a `Syntax` error above.
        if let Some(msg) = self.unsupported {
            return Err(CompileError::Unsupported(msg));
        }
        // parser->size = (5 + nameIndex) * sizeof(txInteger).
        self.size = (5 + self.name_index as i64) * 4;
        self.measure(term, 1);

        // Compile meter fires here in C, over the final size (before the
        // trailing match word is accounted, matching fxCompileRegExp).
        let match_offset = self.size;
        self.size += 4;
        let compile_meter_raw = (self.size as u64) * XS_PARSE_REGEXP_METERING;

        // Allocate and zero the code buffer.
        let total_words = (self.size / 4) as usize;
        self.code = vec![0; total_words];
        self.code[0] = self.flags as i32;
        self.code[1] = self.capture_index;
        self.code[2] = self.name_index;
        self.code[3] = self.assertion_index;
        self.code[4] = self.quantifier_index;
        // Named-capture id slots [5 .. 5+nameIndex) stay 0 here (only the
        // JS surface reads them; the matcher does not).

        self.emit(term, 1, match_offset as i32);
        self.code[(match_offset / 4) as usize] = CX_MATCH_STEP;

        Ok(Program {
            code: std::mem::take(&mut self.code),
            capture_count: self.capture_index as usize,
            name_count: self.name_index as usize,
            assertion_count: self.assertion_index as usize,
            quantifier_count: self.quantifier_index as usize,
            compile_meter_raw,
            capture_group_names: std::mem::take(&mut self.named_groups),
        })
    }

    // ---- pattern lexer primitives (fxPatternParser*) ----

    fn read8(&self, offset: usize) -> u8 {
        self.pattern.get(offset).copied().unwrap_or(0)
    }

    /// `fxPatternParserNext`, the non-`UV` BMP path. Astral code points
    /// (which C splits into surrogates) are the named skip here.
    fn next(&mut self) -> PResult<()> {
        let (ch, p) = utf8_decode(&self.pattern, self.offset);
        if ch != C_EOF {
            self.offset = p;
            // XS (`fxPatternParserNext`) splits an astral code point into
            // surrogates only outside `UV`/name context; inside `UV` or a
            // group `<name>` it keeps the whole scalar. Ironhorse has not ported
            // the surrogate-split matcher path, so it stays a named
            // Unsupported there, but a name/`UV` scalar is delivered so the
            // group-name `ID_Start`/`ID_Continue` check can rule on it.
            if ch > 0xFFFF && self.flags & (XS_REGEXP_U | XS_REGEXP_V | XS_REGEXP_NAME) == 0 {
                return Err(CompileError::Unsupported("astral code point in pattern"));
            }
            self.character = ch;
        } else {
            self.character = C_EOF;
        }
        Ok(())
    }

    /// `fxPatternParserDecimal`: fold the current digit into `value`.
    fn decimal(&self, value: &mut u32) -> bool {
        let c = self.character;
        if (b'0' as i64..=b'9' as i64).contains(&c) {
            *value = value
                .wrapping_mul(10)
                .wrapping_add((c - b'0' as i64) as u32);
            true
        } else {
            false
        }
    }

    fn error(&self, msg: &str) -> CompileError {
        CompileError::Syntax(msg.to_string())
    }

    /// Reset the parse cursor and per-parse tables for `fxCompileRegExp`'s
    /// second pass (the non-`UV` named-capture re-parse). `flags` (now
    /// carrying `XS_REGEXP_N`) and `unsupported` are kept.
    fn reset_for_reparse(&mut self) {
        self.offset = 0;
        self.character = 0;
        self.capture_index = 0;
        self.name_index = 0;
        self.assertion_index = 0;
        self.quantifier_index = 0;
        self.nodes.clear();
        self.capture_names.clear();
        self.named_refs.clear();
        self.saw_named_group = false;
        self.named_groups.clear();
        self.pending_named_refs.clear();
    }

    /// `fxCaptureNameParse`: read a `<name>` up to and including `>`,
    /// validating each code point as `ID_Start` / `ID_Continue` (with `\u`
    /// escapes resolved by [`Self::capture_name_escape`]). Returns the
    /// decoded name; an ill-formed name is `mxInvalidName` (a `SyntaxError`).
    fn capture_name_parse(&mut self) -> PResult<String> {
        let mut name = String::new();
        if self.character == b'\\' as i64 {
            self.capture_name_escape()?;
        }
        if is_ident_scalar(self.character, true) {
            push_name_char(&mut name, self.character);
            self.next()?;
        } else {
            return Err(self.error("invalid name"));
        }
        while self.character != b'>' as i64 {
            if self.character == C_EOF {
                return Err(self.error("invalid name"));
            }
            if self.character == b'\\' as i64 {
                self.capture_name_escape()?;
            }
            if is_ident_scalar(self.character, false) {
                push_name_char(&mut name, self.character);
                self.next()?;
            } else {
                return Err(self.error("invalid name"));
            }
        }
        // XS clears the transient NAME bit and consumes the '>'.
        self.flags &= !XS_REGEXP_NAME;
        self.next()?;
        Ok(name)
    }

    /// `fxCaptureNameEscape`: a `\u` escape inside a group name, always in
    /// the unicode (`braces=1, separator='\\'`) form regardless of the
    /// pattern flags. Sets `self.character` to the decoded scalar.
    fn capture_name_escape(&mut self) -> PResult<()> {
        self.next()?;
        if self.character != b'u' as i64 {
            return Err(self.error("invalid name"));
        }
        match self.parse_unicode_escape_uform(self.offset) {
            Some((ch, off)) => {
                self.character = ch;
                self.offset = off;
                Ok(())
            }
            None => Err(self.error("invalid name")),
        }
    }

    /// `fxParseUnicodeEscape` with `braces=1, separator='\\'`: `\u{H+}`
    /// (`H+` ≤ 0x10FFFF) or `\uHHHH`, the latter folding a following
    /// `\uHHHH` low surrogate into an astral scalar. `offset` points just
    /// past the `u`; returns `(scalar, offset')` or `None` on a malformed
    /// escape.
    fn parse_unicode_escape_uform(&self, offset: usize) -> Option<(i64, usize)> {
        let mut p = offset;
        let mut c = self.read8(p);
        p += 1;
        let mut value: u32 = 0;
        if c == b'{' {
            c = self.read8(p);
            p += 1;
            let mut i = 0;
            while value < 0x0011_0000 {
                if let Some(d) = hex_digit(c) {
                    value = value * 16 + d;
                    c = self.read8(p);
                    p += 1;
                    i += 1;
                } else {
                    break;
                }
            }
            if c == b'}' && i > 0 && value < 0x0011_0000 {
                return Some((value as i64, p));
            }
            return None;
        }
        // Four-hex form.
        value = value * 16 + hex_digit(c)?;
        c = self.read8(p);
        p += 1;
        value = value * 16 + hex_digit(c)?;
        c = self.read8(p);
        p += 1;
        value = value * 16 + hex_digit(c)?;
        c = self.read8(p);
        p += 1;
        value = value * 16 + hex_digit(c)?;
        let mut character = value as i64;
        let mut end = p;
        c = self.read8(p);
        p += 1;
        if c != 0 && c == b'\\' && (0xD800..=0xDBFF).contains(&value) {
            c = self.read8(p);
            p += 1;
            if c == b'u' {
                let mut other: u32 = 0;
                let mut ok = true;
                for _ in 0..4 {
                    c = self.read8(p);
                    p += 1;
                    match hex_digit(c) {
                        Some(d) => other = other * 16 + d,
                        None => {
                            ok = false;
                            break;
                        }
                    }
                }
                if ok && (0xDC00..=0xDFFF).contains(&other) {
                    character = (0x0001_0000 + ((value & 0x03FF) << 10) + (other & 0x03FF)) as i64;
                    end = p;
                }
            }
        }
        Some((character, end))
    }

    fn add_node(&mut self, kind: Kind) -> NodeId {
        self.nodes.push(Node {
            kind,
            step: 0,
            completion: 0,
            loop_off: 0,
        });
        self.nodes.len() - 1
    }

    // ---- character-set builders (fxCharSet*) ----

    fn charset_single(&mut self, character: i64) -> NodeId {
        self.add_node(Kind::CharSet {
            chars: vec![2, character as i32, (character + 1) as i32],
            strings: Vec::new(),
        })
    }

    /// `fxCharSetCanonicalizeSingle`: under the `i` flag, fold a
    /// single-character set to its canonical code point (so the compiled
    /// charset matches both cases). A no-op unless `I` is set and the set
    /// is exactly one code point.
    fn charset_canonicalize_single(&mut self, id: NodeId) -> NodeId {
        if self.flags & XS_REGEXP_I != 0 {
            if let Kind::CharSet { chars, .. } = &self.nodes[id].kind {
                if chars[0] == 2 && chars[1] + 1 == chars[2] {
                    // `fxCharSetCanonicalizeSingle`: fold table is `Fold` under
                    // `u`/`v` (flag == 1), `Ignore` otherwise.
                    let fold = self.flags & (XS_REGEXP_U | XS_REGEXP_V) != 0;
                    let c = crate::charcase::canonicalize(chars[1] as i64, fold) as i32;
                    if let Kind::CharSet { chars, .. } = &mut self.nodes[id].kind {
                        chars[1] = c;
                        chars[2] = c + 1;
                    }
                }
            }
        }
        id
    }

    fn charset_empty(&mut self) -> NodeId {
        self.add_node(Kind::CharSet {
            chars: vec![0],
            strings: Vec::new(),
        })
    }

    fn charset_any(&mut self) -> NodeId {
        let chars = if self.flags & XS_REGEXP_S != 0 {
            vec![2, 0x0000, 0x7FFF_FFFF]
        } else {
            vec![
                8,
                0x0000,
                0x000A,
                0x000B,
                0x000D,
                0x000E,
                0x2028,
                0x2030,
                0x7FFF_FFFF,
            ]
        };
        self.add_node(Kind::CharSet {
            chars,
            strings: Vec::new(),
        })
    }

    fn charset_digits(&mut self) -> NodeId {
        self.add_node(Kind::CharSet {
            chars: vec![2, b'0' as i32, b'9' as i32 + 1],
            strings: Vec::new(),
        })
    }

    fn charset_words(&mut self) -> NodeId {
        // Under `i`, the subject char is canonicalized at match time, so one
        // case of the ASCII letters suffices in the compiled `\w` set. The
        // non-`u`/`v` `Ignore` fold maps toward the upper case, so `\w` keeps
        // `A`..`Z` and drops `a`..`z`; the `u`/`v` `Fold` fold maps toward the
        // lower case, so it keeps `a`..`z` and drops `A`..`Z`
        // (`fxCharSetWords`, the two `I` branches). Endpoints stay sorted.
        let chars = if self.flags & XS_REGEXP_I != 0 {
            if self.flags & (XS_REGEXP_U | XS_REGEXP_V) != 0 {
                vec![
                    6,
                    b'0' as i32,
                    b'9' as i32 + 1,
                    b'_' as i32,
                    b'_' as i32 + 1,
                    b'a' as i32,
                    b'z' as i32 + 1,
                ]
            } else {
                vec![
                    6,
                    b'0' as i32,
                    b'9' as i32 + 1,
                    b'A' as i32,
                    b'Z' as i32 + 1,
                    b'_' as i32,
                    b'_' as i32 + 1,
                ]
            }
        } else {
            vec![
                8,
                b'0' as i32,
                b'9' as i32 + 1,
                b'A' as i32,
                b'Z' as i32 + 1,
                b'_' as i32,
                b'_' as i32 + 1,
                b'a' as i32,
                b'z' as i32 + 1,
            ]
        };
        self.add_node(Kind::CharSet {
            chars,
            strings: Vec::new(),
        })
    }

    fn charset_spaces(&mut self) -> NodeId {
        self.add_node(Kind::CharSet {
            chars: vec![
                20,
                0x0009,
                0x000D + 1,
                0x0020,
                0x0020 + 1,
                0x00A0,
                0x00A0 + 1,
                0x1680,
                0x1680 + 1,
                0x2000,
                0x200A + 1,
                0x2028,
                0x2029 + 1,
                0x202F,
                0x202F + 1,
                0x205F,
                0x205F + 1,
                0x3000,
                0x3000 + 1,
                0xFEFF,
                0xFEFF + 1,
            ],
            strings: Vec::new(),
        })
    }

    /// `fxCharSetNot`: complement over `[0, 0x7FFFFFFF)`.
    fn charset_not(&mut self, set: NodeId) -> PResult<NodeId> {
        let (src, strings) = self.charset_parts(set)?;
        if !strings.is_empty() {
            return Err(self.error("invalid pattern"));
        }
        let mut out = vec![0i32];
        let mut character = 0i32;
        let mut i = 1usize;
        let count = src[0] as usize;
        while i < 1 + count {
            let begin = src[i];
            let end = src[i + 1];
            i += 2;
            if character < begin {
                out.push(character);
                out.push(begin);
            }
            character = end;
        }
        if character < 0x7FFF_FFFF {
            out.push(character);
            out.push(0x7FFF_FFFF);
        }
        out[0] = (out.len() - 1) as i32;
        Ok(self.add_node(Kind::CharSet {
            chars: out,
            strings: Vec::new(),
        }))
    }

    /// `fxCharSetCombine`: merge two sorted endpoint lists and their finite
    /// string alternatives under a union/subtract/intersect operation.
    fn charset_combine(&mut self, set1: NodeId, set2: NodeId, op: i32) -> PResult<NodeId> {
        let (c1, s1) = self.charset_parts(set1)?;
        let (c2, s2) = self.charset_parts(set2)?;
        let count1 = c1[0] as usize;
        let count2 = c2[0] as usize;
        let mut i1 = 1usize;
        let lim1 = 1 + count1;
        let mut i2 = 1usize;
        let lim2 = 1 + count2;
        let mut out = vec![0i32];
        let mut flag = 0i32;
        let mut old = 0i32;
        while i1 < lim1 && i2 < lim2 {
            let test = c1[i1] - c2[i2];
            let mut character = 0i32;
            if test <= 0 {
                character = c1[i1];
                flag ^= 1;
                i1 += 1;
            }
            if test >= 0 {
                character = c2[i2];
                flag ^= 2;
                i2 += 1;
            }
            if flag == op || old == op {
                out.push(character);
            }
            old = flag;
        }
        if op & 2 == 0 {
            while i1 < lim1 {
                out.push(c1[i1]);
                i1 += 1;
            }
        }
        if op & 1 == 0 {
            while i2 < lim2 {
                out.push(c2[i2]);
                i2 += 1;
            }
        }
        out[0] = (out.len() - 1) as i32;
        let mut strings = match op {
            MX_CHARSET_UNION_OP => s1.iter().chain(s2.iter()).cloned().collect::<Vec<_>>(),
            MX_CHARSET_SUBTRACT_OP => s1
                .iter()
                .filter(|string| !s2.contains(string))
                .cloned()
                .collect::<Vec<_>>(),
            MX_CHARSET_INTERSECTION_OP => s1
                .iter()
                .filter(|string| s2.contains(string))
                .cloned()
                .collect::<Vec<_>>(),
            _ => unreachable!("known charset combine operation"),
        };
        Self::sort_strings(&mut strings);
        Ok(self.add_node(Kind::CharSet {
            chars: out,
            strings,
        }))
    }

    /// `fxCharSetRange`: build `[a-b]` from two singletons.
    fn charset_range(&mut self, set1: NodeId, set2: NodeId) -> PResult<NodeId> {
        let (c1, s1) = self.charset_parts(set1)?;
        let (c2, s2) = self.charset_parts(set2)?;
        if !s1.is_empty() || !s2.is_empty() {
            return Err(self.error("invalid pattern"));
        }
        if c1[0] == 0 {
            return Ok(set2);
        }
        if c2[0] == 0 {
            return Ok(set1);
        }
        if c1[0] != 2 || c2[0] != 2 {
            return Err(self.error("invalid range"));
        }
        if c1[1] + 1 != c1[2] || c2[1] + 1 != c2[2] {
            return Err(self.error("invalid range"));
        }
        if c1[1] > c2[1] {
            return Err(self.error("invalid range"));
        }
        if self.flags & XS_REGEXP_I != 0 {
            // Fold every code point in `[begin, end]` and union the
            // canonical singletons (fxCharSetRange, the `I` branch). The fold
            // table is `Fold` under `u`/`v` (flag == 1), `Ignore` otherwise.
            let fold = self.flags & (XS_REGEXP_U | XS_REGEXP_V) != 0;
            let begin = c1[1];
            let end = c2[1];
            let mut result = self.charset_empty();
            let mut ch = begin;
            while ch <= end {
                let canon = crate::charcase::canonicalize(ch as i64, fold) as i32;
                let single = self.add_node(Kind::CharSet {
                    chars: vec![2, canon, canon + 1],
                    strings: Vec::new(),
                });
                result = self.charset_combine(result, single, MX_CHARSET_UNION_OP)?;
                ch += 1;
            }
            return Ok(result);
        }
        Ok(self.add_node(Kind::CharSet {
            chars: vec![2, c1[1], c2[2]],
            strings: Vec::new(),
        }))
    }

    /// Borrow a node's character endpoints and finite string alternatives,
    /// erroring if the node is not a character set.
    fn charset_parts(&self, id: NodeId) -> PResult<(Vec<i32>, Vec<Vec<u32>>)> {
        match &self.nodes[id].kind {
            Kind::CharSet { chars, strings } => Ok((chars.clone(), strings.clone())),
            _ => Err(self.error("invalid pattern")),
        }
    }

    fn sort_strings(strings: &mut Vec<Vec<u32>>) {
        strings.sort_by(|left, right| right.len().cmp(&left.len()).then_with(|| right.cmp(left)));
        strings.dedup();
    }

    /// `fxCharSetParseEscape`: the `\`-escapes valid as a character set
    /// (both bare and inside `[...]`).
    fn charset_parse_escape(&mut self, punctuator: bool) -> PResult<NodeId> {
        let result = match self.character {
            c if c == C_EOF => return Err(self.error("invalid escape")),
            c if c == b'd' as i64 => {
                let r = self.charset_digits();
                self.next()?;
                r
            }
            c if c == b'D' as i64 => {
                let d = self.charset_digits();
                let r = self.charset_not(d)?;
                self.next()?;
                r
            }
            c if c == b's' as i64 => {
                let r = self.charset_spaces();
                self.next()?;
                r
            }
            c if c == b'S' as i64 => {
                let s = self.charset_spaces();
                let r = self.charset_not(s)?;
                self.next()?;
                r
            }
            c if c == b'w' as i64 => {
                let r = self.charset_words();
                self.next()?;
                r
            }
            c if c == b'W' as i64 => {
                let w = self.charset_words();
                let r = self.charset_not(w)?;
                self.next()?;
                r
            }
            c if (c == b'p' as i64 || c == b'P' as i64)
                && self.flags & (XS_REGEXP_U | XS_REGEXP_V) != 0 =>
            {
                self.charset_unicode_property()?
            }
            _ => {
                self.pattern_escape(punctuator)?;
                let r = self.charset_single(self.character);
                self.next()?;
                r
            }
        };
        Ok(result)
    }

    /// `fxCharSetUnicodeProperty`: parse the exact ECMAScript property alias
    /// grammar and copy the XS endpoint table into a normal charset node.
    fn charset_unicode_property(&mut self) -> PResult<NodeId> {
        let negate = self.character == b'P' as i64;
        self.next()?;
        if self.character != b'{' as i64 {
            return Err(self.error("invalid escape"));
        }
        self.next()?;
        let name = self.property_identifier()?;
        let value = if self.character == b'=' as i64 {
            self.next()?;
            Some(self.property_identifier()?)
        } else {
            None
        };
        if self.character != b'}' as i64 || name.is_empty() || value.as_deref() == Some("") {
            return Err(self.error("invalid escape"));
        }
        let character_property = crate::unicode_property::lookup(&name, value.as_deref());
        let string_property = if value.is_none() && self.flags & XS_REGEXP_V != 0 {
            crate::unicode_property::lookup_string_property(&name)
        } else {
            None
        };
        let (endpoints, strings) = if let Some(endpoints) = character_property {
            (endpoints, Vec::new())
        } else if let Some((endpoints, strings)) = string_property {
            (
                endpoints,
                strings
                    .iter()
                    .map(|string| string.chars().map(u32::from).collect())
                    .collect(),
            )
        } else {
            return Err(self.error("invalid escape"));
        };
        let mut chars = Vec::with_capacity(endpoints.len() + 1);
        chars.push(endpoints.len() as i32);
        chars.extend_from_slice(endpoints);
        let set = self.add_node(Kind::CharSet { chars, strings });
        self.next()?;
        if negate {
            self.charset_not(set)
        } else {
            Ok(set)
        }
    }

    fn property_identifier(&mut self) -> PResult<String> {
        let mut result = String::new();
        while matches!(self.character, c if (b'a' as i64..=b'z' as i64).contains(&c)
            || (b'A' as i64..=b'Z' as i64).contains(&c)
            || (b'0' as i64..=b'9' as i64).contains(&c)
            || c == b'_' as i64)
        {
            if result.len() == 127 {
                return Err(self.error("property name overflow"));
            }
            result.push(self.character as u8 as char);
            self.next()?;
        }
        Ok(result)
    }

    /// `fxPatternParserEscape`: resolve the control/hex/unicode/identity
    /// escape at `self.character`, updating `self.character` in place.
    fn pattern_escape(&mut self, punctuator: bool) -> PResult<()> {
        match self.character {
            c if c == C_EOF => {}
            c if c == b'f' as i64 => self.character = 0x0C,
            c if c == b'n' as i64 => self.character = 0x0A,
            c if c == b'r' as i64 => self.character = 0x0D,
            c if c == b't' as i64 => self.character = 0x09,
            c if c == b'v' as i64 => self.character = 0x0B,
            c if c == b'c' as i64 => {
                self.next()?;
                let value = self.character;
                if (b'a' as i64..=b'z' as i64).contains(&value)
                    || (b'A' as i64..=b'Z' as i64).contains(&value)
                {
                    self.character = value % 32;
                } else {
                    return Err(self.error("invalid escape"));
                }
            }
            c if c == b'0' as i64 => {
                let n = self.read8(self.offset);
                if !(b'0'..=b'9').contains(&n) {
                    self.character = 0;
                } else {
                    return Err(self.error("invalid escape"));
                }
            }
            c if c == b'x' as i64 => {
                if let Some((ch, off)) = self.parse_hex_escape(self.offset) {
                    self.character = ch;
                    self.offset = off;
                } else if self.flags & (XS_REGEXP_U | XS_REGEXP_V) != 0 {
                    // UV: a truncated `\x` is a syntax error (non-UV: an
                    // identity escape 'x').
                    return Err(self.error("invalid escape"));
                }
            }
            c if c == b'u' as i64 => {
                if self.flags & (XS_REGEXP_U | XS_REGEXP_V) != 0 {
                    // UV: the unicode form (`\u{H+}` or `\uHHHH`[+ low
                    // surrogate]); a malformed escape is a syntax error, not
                    // an identity escape.
                    match self.parse_unicode_escape_uform(self.offset) {
                        Some((ch, off)) => {
                            self.character = ch;
                            self.offset = off;
                        }
                        None => return Err(self.error("invalid escape")),
                    }
                } else if let Some((ch, off)) = self.parse_unicode_escape(self.offset) {
                    self.character = ch;
                    self.offset = off;
                }
                // Non-UV: a bad \u is an identity escape ('u').
            }
            // Syntax-character and forward-slash identity escapes.
            c if is_syntax_char(c) => {}
            _ => {
                if punctuator {
                    // Class-context punctuator escapes.
                    if self.character == b'b' as i64 {
                        self.character = 0x08;
                    }
                    // The remaining class punctuators are identity escapes.
                } else if self.flags & (XS_REGEXP_U | XS_REGEXP_V) != 0 {
                    // UV: only SyntaxCharacter / `/` identity escapes are
                    // legal; any other `\c` is `mxInvalidEscape`.
                    return Err(self.error("invalid escape"));
                }
                // Non-UV: any other escape is an identity escape.
            }
        }
        Ok(())
    }

    /// `fxParseHexEscape`: two hex digits at `offset` → `(char, offset')`.
    fn parse_hex_escape(&self, offset: usize) -> Option<(i64, usize)> {
        let mut value: u32 = 0;
        let mut p = offset;
        for _ in 0..2 {
            let d = hex_digit(self.read8(p))?;
            value = value * 16 + d;
            p += 1;
        }
        Some((value as i64, p))
    }

    /// `fxParseUnicodeEscape`, the non-`UV` four-hex form (`\uXXXX`).
    fn parse_unicode_escape(&self, offset: usize) -> Option<(i64, usize)> {
        let mut value: u32 = 0;
        let mut p = offset;
        for _ in 0..4 {
            let d = hex_digit(self.read8(p))?;
            value = value * 16 + d;
            p += 1;
        }
        Some((value as i64, p))
    }

    /// `fxCharSetParseItem`: one item within `[...]`.
    fn charset_parse_item(&mut self) -> PResult<NodeId> {
        if self.character == b'-' as i64 {
            let r = self.charset_single(b'-' as i64);
            self.next()?;
            Ok(r)
        } else if self.character == b'\\' as i64 {
            self.next()?;
            if self.character == b'b' as i64 {
                self.next()?;
                Ok(self.charset_single(8))
            } else if self.character == b'-' as i64 {
                self.next()?;
                Ok(self.charset_single(b'-' as i64))
            } else {
                self.charset_parse_escape(false)
            }
        } else if self.character == b']' as i64 {
            Ok(self.charset_empty())
        } else {
            let r = self.charset_single(self.character);
            self.next()?;
            Ok(r)
        }
    }

    /// `fxCharSetParseList`: the body of a non-`v` `[...]` class.
    fn charset_parse_list(&mut self) -> PResult<NodeId> {
        let mut not = false;
        let mut former: Option<NodeId> = None;
        let mut result: NodeId = self.charset_empty();
        if self.character == b'^' as i64 {
            self.next()?;
            not = true;
        }
        while self.character != C_EOF {
            result = self.charset_parse_item()?;
            if self.character == b'-' as i64 {
                self.next()?;
                if self.character == b']' as i64 {
                    result = self.charset_canonicalize_single(result);
                    let dash = self.charset_single(b'-' as i64);
                    result = self.charset_combine(result, dash, MX_CHARSET_UNION_OP)?;
                } else {
                    let hi = self.charset_parse_item()?;
                    result = self.charset_range(result, hi)?;
                }
            } else {
                result = self.charset_canonicalize_single(result);
            }
            if let Some(prev) = former {
                result = self.charset_combine(prev, result, MX_CHARSET_UNION_OP)?;
            }
            former = Some(result);
            if self.character == b']' as i64 {
                break;
            }
        }
        if not {
            result = self.charset_not(result)?;
        }
        Ok(result)
    }

    /// `fxCharSetStrings`: parse a v-mode `\q{...}` string disjunction.
    /// Empty branches contribute nothing, singleton branches join the
    /// character set, and longer branches are de-duplicated and sorted in
    /// XS's longest-first order before set operations consume them.
    fn charset_strings(&mut self) -> PResult<NodeId> {
        self.next()?;
        if self.character != b'{' as i64 {
            return Err(self.error("invalid escape"));
        }
        self.next()?;
        let mut result = self.charset_empty();
        let mut strings = Vec::new();
        let mut current = Vec::new();
        loop {
            match self.character {
                C_EOF => return Err(self.error("invalid escape")),
                c if c == b'}' as i64 || c == b'|' as i64 => {
                    if current.len() == 1 {
                        let single = self.charset_single(current[0] as i64);
                        result = self.charset_combine(result, single, MX_CHARSET_UNION_OP)?;
                    } else if current.len() > 1 {
                        strings.push(std::mem::take(&mut current));
                    }
                    if c == b'}' as i64 {
                        self.next()?;
                        break;
                    }
                    current.clear();
                    self.next()?;
                }
                _ => {
                    if self.character == b'\\' as i64 {
                        self.next()?;
                        self.pattern_escape(true)?;
                    }
                    let mut character = self.character;
                    if self.flags & XS_REGEXP_I != 0 {
                        character = crate::charcase::canonicalize(character, true);
                    }
                    current.push(character as u32);
                    self.next()?;
                }
            }
        }
        Self::sort_strings(&mut strings);
        if let Kind::CharSet {
            strings: target, ..
        } = &mut self.nodes[result].kind
        {
            *target = strings;
        }
        Ok(result)
    }

    /// `fxCharSetExpression`: the v-mode nested-set grammar, including
    /// subtraction, intersection, ordinary union/ranges, reserved doubled
    /// punctuators, and the no-mixing rule for set operators.
    fn charset_expression(&mut self) -> PResult<NodeId> {
        let mut not = false;
        if self.character == b'^' as i64 {
            self.next()?;
            not = true;
        }
        let (mut left, mut left_kind) = self.charset_operand()?;
        let mut result: Option<NodeId> = None;
        if self.character == b'-' as i64 && self.read8(self.offset) == b'-' {
            loop {
                self.next()?;
                self.next()?;
                let (right, _) = self.charset_operand()?;
                result = Some(self.charset_combine(left, right, MX_CHARSET_SUBTRACT_OP)?);
                if self.character == b']' as i64 {
                    break;
                }
                if self.character == b'-' as i64 && self.read8(self.offset) == b'-' {
                    left = result.expect("subtraction has a result");
                    continue;
                }
                return Err(self.error("invalid range"));
            }
        } else if self.character == b'&' as i64 && self.read8(self.offset) == b'&' {
            loop {
                self.next()?;
                self.next()?;
                let (right, _) = self.charset_operand()?;
                result = Some(self.charset_combine(left, right, MX_CHARSET_INTERSECTION_OP)?);
                if self.character == b']' as i64 {
                    break;
                }
                if self.character == b'&' as i64 && self.read8(self.offset) == b'&' {
                    left = result.expect("intersection has a result");
                    continue;
                }
                return Err(self.error("invalid range"));
            }
        } else {
            loop {
                if self.character == b'-' as i64 {
                    self.next()?;
                    let (right, right_kind) = self.charset_operand()?;
                    if left_kind != 0 && right_kind != 0 {
                        return Err(self.error("invalid range"));
                    }
                    left = self.charset_range(left, right)?;
                }
                result = Some(if let Some(former) = result {
                    self.charset_combine(former, left, MX_CHARSET_UNION_OP)?
                } else {
                    left
                });
                if self.character == b']' as i64 {
                    break;
                }
                (left, left_kind) = self.charset_operand()?;
            }
        }
        let mut result = result.expect("a v set expression starts with an operand");
        if not {
            result = self.charset_not(result)?;
        }
        Ok(result)
    }

    /// `fxCharSetOperand`: one v-mode set operand and its range kind (zero
    /// for a literal singleton, one for a class/string/nested set).
    fn charset_operand(&mut self) -> PResult<(NodeId, i32)> {
        match self.character {
            C_EOF => Err(self.error("invalid range")),
            c if c == b'[' as i64 => {
                self.next()?;
                let result = self.charset_expression()?;
                if self.character != b']' as i64 {
                    return Err(self.error("invalid range"));
                }
                self.next()?;
                Ok((result, 1))
            }
            c if c == b'\\' as i64 => {
                self.next()?;
                if self.character == b'q' as i64 {
                    Ok((self.charset_strings()?, 1))
                } else {
                    let class = matches!(
                        self.character,
                        c if c == b'd' as i64
                            || c == b'D' as i64
                            || c == b's' as i64
                            || c == b'S' as i64
                            || c == b'w' as i64
                            || c == b'W' as i64
                            || c == b'p' as i64
                            || c == b'P' as i64
                    );
                    Ok((self.charset_parse_escape(true)?, i32::from(class)))
                }
            }
            c if is_v_maybe_doubled_punctuator(c) => {
                let character = self.character;
                self.next()?;
                if self.character == character {
                    return Err(self.error("invalid range"));
                }
                Ok((self.charset_single(character), 0))
            }
            c if is_v_reserved_punctuator(c) => Err(self.error("invalid range")),
            _ => {
                let result = self.charset_single(self.character);
                self.next()?;
                Ok((result, 0))
            }
        }
    }

    /// Lower parser-only class strings into the same ordinary term tree XS
    /// emits: longest alternatives first, each as a right-nested sequence,
    /// followed by the character-set alternative when it is non-empty.
    fn charset_strings_disjunction(&mut self, set: NodeId) -> PResult<NodeId> {
        let (chars, strings) = self.charset_parts(set)?;
        if strings.is_empty() {
            return Ok(set);
        }
        let mut result: Option<NodeId> = None;
        for string in strings {
            let mut atoms = Vec::with_capacity(string.len());
            for character in string {
                let single = self.charset_single(character as i64);
                atoms.push(self.charset_canonicalize_single(single));
            }
            let mut sequence = *atoms
                .last()
                .expect("v strings contain at least two scalars");
            for &atom in atoms.iter().rev().skip(1) {
                sequence = self.add_node(Kind::Sequence {
                    left: atom,
                    right: sequence,
                });
            }
            result = Some(if let Some(left) = result {
                self.add_node(Kind::Disjunction {
                    left,
                    right: sequence,
                })
            } else {
                sequence
            });
        }
        if chars[0] != 0 {
            result = Some(self.add_node(Kind::Disjunction {
                left: result.expect("string alternatives exist"),
                right: set,
            }));
        }
        Ok(result.expect("string alternatives exist"))
    }

    // ---- quantifier parsing (fxQuantifierParse*) ----

    fn quantifier_parse(&mut self, term: NodeId, capture_index: i32) -> PResult<NodeId> {
        let (min, max) = match self.character {
            c if c == b'*' as i64 => {
                self.next()?;
                (0, MAX_QUANTIFIER)
            }
            c if c == b'+' as i64 => {
                self.next()?;
                (1, MAX_QUANTIFIER)
            }
            c if c == b'?' as i64 => {
                self.next()?;
                (0, 1)
            }
            c if c == b'{' as i64 => {
                if let Some((min, max)) = self.quantifier_parse_brace()? {
                    if min > max {
                        return Err(self.error("invalid quantifier"));
                    }
                    (min, max)
                } else {
                    return Ok(term);
                }
            }
            _ => return Ok(term),
        };
        let greedy = if self.character == b'?' as i64 {
            self.next()?;
            false
        } else {
            true
        };
        let capture_count = self.capture_index - capture_index;
        let quantifier_index = self.quantifier_index;
        self.quantifier_index += 1;
        Ok(self.add_node(Kind::Quantifier {
            term,
            min,
            max,
            greedy,
            capture_index,
            capture_count,
            quantifier_index,
        }))
    }

    /// `fxQuantifierParseBrace`: `{n}` / `{n,}` / `{n,m}` with backtrack.
    fn quantifier_parse_brace(&mut self) -> PResult<Option<(i32, i32)>> {
        let saved_offset = self.offset;
        self.next()?;
        let min = match self.quantifier_parse_digits()? {
            Some(v) => v,
            None => return Ok(self.brace_backtrack(saved_offset)),
        };
        let max;
        if self.character == b',' as i64 {
            self.next()?;
            if self.character == b'}' as i64 {
                max = MAX_QUANTIFIER;
            } else {
                match self.quantifier_parse_digits()? {
                    Some(v) => max = v,
                    None => return Ok(self.brace_backtrack(saved_offset)),
                }
            }
        } else {
            max = min;
        }
        if self.character != b'}' as i64 {
            return Ok(self.brace_backtrack(saved_offset));
        }
        self.next()?;
        Ok(Some((min, max)))
    }

    fn brace_backtrack(&mut self, saved_offset: usize) -> Option<(i32, i32)> {
        self.character = b'{' as i64;
        self.offset = saved_offset;
        None
    }

    fn quantifier_parse_digits(&mut self) -> PResult<Option<i32>> {
        let mut value: u32 = 0;
        if self.decimal(&mut value) {
            self.next()?;
            while self.decimal(&mut value) {
                self.next()?;
            }
        } else {
            return Ok(None);
        }
        if value > 0x7FFF_FFFF {
            value = 0x7FFF_FFFF;
        }
        Ok(Some(value as i32))
    }

    // ---- the recursive-descent grammar (fxDisjunctionParse etc.) ----

    fn disjunction_parse(&mut self, character: i64) -> PResult<NodeId> {
        let mut result = self.sequence_parse(character)?;
        if self.character == b'|' as i64 {
            self.next()?;
            let left = result;
            let right = self.disjunction_parse(character)?;
            result = self.add_node(Kind::Disjunction { left, right });
        }
        if self.character != character {
            return Err(self.error("invalid sequence"));
        }
        Ok(result)
    }

    fn sequence_parse(&mut self, character: i64) -> PResult<NodeId> {
        // Collect the ordered atoms, then fold into a right-nested
        // sequence spine. C threads a mutable `formerBranch->right` into a
        // right-nested `Seq(a0, Seq(a1, ... an))`; because a `Sequence`
        // node emits no bytes of its own and simply chains `left` then
        // `right`, the right-nested fold reproduces the identical measure
        // offsets and emitted step chain (each atom's sequel is the next
        // atom's step; the last atom's sequel is the outer sequel).
        let mut atoms: Vec<NodeId> = Vec::new();
        while self.character != C_EOF && self.character != character {
            if self.character == b'|' as i64 {
                break;
            }
            let current_index = self.capture_index;
            atoms.push(self.term_parse(current_index)?);
        }
        if atoms.is_empty() {
            return Ok(self.add_node(Kind::Empty));
        }
        let mut result = *atoms.last().unwrap();
        for &atom in atoms.iter().rev().skip(1) {
            result = self.add_node(Kind::Sequence {
                left: atom,
                right: result,
            });
        }
        Ok(result)
    }

    /// One atom (+ its optional quantifier) of a sequence — the big
    /// dispatch in `fxSequenceParse`.
    fn term_parse(&mut self, current_index: i32) -> PResult<NodeId> {
        let ch = self.character;
        if ch == b'^' as i64 {
            self.next()?;
            Ok(self.add_node(Kind::LineBegin))
        } else if ch == b'$' as i64 {
            self.next()?;
            Ok(self.add_node(Kind::LineEnd))
        } else if ch == b'\\' as i64 {
            self.next()?;
            self.backslash_atom(current_index)
        } else if ch == b'.' as i64 {
            let any = self.charset_any();
            self.next()?;
            self.quantifier_parse(any, current_index)
        } else if ch == b'*' as i64 || ch == b'+' as i64 || ch == b'?' as i64 {
            Err(self.error("invalid character"))
        } else if ch == b'(' as i64 {
            self.group_atom(current_index)
        } else if ch == b')' as i64 {
            Err(self.error("invalid character"))
        } else if ch == b'[' as i64 {
            self.next()?;
            let current = if self.flags & XS_REGEXP_V != 0 {
                let set = self.charset_expression()?;
                self.charset_strings_disjunction(set)?
            } else {
                self.charset_parse_list()?
            };
            if self.character != b']' as i64 {
                return Err(self.error("invalid range"));
            }
            self.next()?;
            self.quantifier_parse(current, current_index)
        } else if ch == b'|' as i64 {
            // Handled by disjunction_parse; sequence stops here. This is
            // unreachable because the while-guard covers `character`, but
            // the '|' case is an explicit break in C.
            Err(self.error("invalid character"))
        } else if (ch == b']' as i64 || ch == b'}' as i64)
            && self.flags & (XS_REGEXP_U | XS_REGEXP_V) != 0
        {
            // UV: a bare `]` or `}` is a syntax error (non-UV: an ordinary
            // character, Annex B).
            Err(self.error("invalid character"))
        } else {
            // Ordinary character (with the Annex-B `{` non-quantifier
            // tolerance the non-`UV` path allows; under UV a `{` that is not
            // a valid quantifier is itself a syntax error).
            if ch == b'{' as i64 {
                if self.flags & (XS_REGEXP_U | XS_REGEXP_V) != 0 {
                    return Err(self.error("invalid character"));
                }
                if let Some(_) = self.quantifier_parse_brace()? {
                    return Err(self.error("invalid quantifier"));
                }
            }
            let single = self.charset_single(self.character);
            let single = self.charset_canonicalize_single(single);
            self.next()?;
            self.quantifier_parse(single, current_index)
        }
    }

    /// The `\`-prefixed atoms in atom position (assertions, references,
    /// escaped charsets).
    fn backslash_atom(&mut self, current_index: i32) -> PResult<NodeId> {
        if self.character == b'b' as i64 {
            self.next()?;
            Ok(self.add_node(Kind::WordBreak))
        } else if self.character == b'B' as i64 {
            self.next()?;
            Ok(self.add_node(Kind::WordContinue))
        } else if self.character == b'k' as i64
            && self.flags & (XS_REGEXP_U | XS_REGEXP_V | XS_REGEXP_N) != 0
        {
            // `\k<name>` named backreference (only when the pattern is `u`/`v`
            // or contains a named group — `XS_REGEXP_N`). Require `<`,
            // validate the name syntax, and record the reference for the
            // post-parse existence check (`fxCaptureReferenceMeasure` →
            // `mxInvalidReferenceName` on a dangling name). Matcher codegen
            // for a named reference is unported.
            self.next()?;
            if self.character != b'<' as i64 {
                return Err(self.error("invalid name"));
            }
            self.flags |= XS_REGEXP_NAME;
            self.next()?;
            let name = self.capture_name_parse()?;
            self.named_refs.push(name.clone());
            // Emit a named reference: `capture_index = -1` with the name slot
            // resolved after the whole pattern is parsed (forward references
            // are legal). The matcher reads the live index out of `names[]`.
            let node = self.add_node(Kind::CaptureReference {
                capture_index: -1,
                name_slot: -1,
            });
            self.pending_named_refs.push((node, name));
            self.quantifier_parse(node, current_index)
        } else if (b'1' as i64..=b'9' as i64).contains(&self.character) {
            let mut value: u32 = (self.character - b'0' as i64) as u32;
            self.next()?;
            while self.decimal(&mut value) {
                self.next()?;
            }
            let node = self.add_node(Kind::CaptureReference {
                capture_index: value as i32,
                name_slot: -1,
            });
            self.quantifier_parse(node, current_index)
        } else {
            // \0, control, hex, \u, \d\w\s, identity escapes → a charset.
            let set = self.charset_parse_escape(false)?;
            let set = self.charset_canonicalize_single(set);
            let set = if self.flags & XS_REGEXP_V != 0 {
                self.charset_strings_disjunction(set)?
            } else {
                set
            };
            self.quantifier_parse(set, current_index)
        }
    }

    /// The `(`-prefixed atoms: capturing / non-capturing groups and
    /// lookaround assertions.
    fn group_atom(&mut self, mut current_index: i32) -> PResult<NodeId> {
        self.next()?;
        if self.character == b'?' as i64 {
            self.next()?;
            if self.character == b'=' as i64 {
                self.next()?;
                let term = self.disjunction_parse(b')' as i64)?;
                self.next()?;
                let ai = self.assertion_index;
                self.assertion_index += 1;
                Ok(self.add_node(Kind::Assertion {
                    term,
                    not: false,
                    direction: 1,
                    assertion_index: ai,
                }))
            } else if self.character == b'!' as i64 {
                self.next()?;
                let term = self.disjunction_parse(b')' as i64)?;
                self.next()?;
                let ai = self.assertion_index;
                self.assertion_index += 1;
                Ok(self.add_node(Kind::Assertion {
                    term,
                    not: true,
                    direction: 1,
                    assertion_index: ai,
                }))
            } else if self.character == b':' as i64 {
                self.next()?;
                let current = self.disjunction_parse(b')' as i64)?;
                self.next()?;
                self.quantifier_parse(current, current_index)
            } else if self.character == b'<' as i64 {
                // Peek past '<': `=`/`!` are lookbehind assertions; anything
                // else begins a group `<name>`, so latch XS_REGEXP_NAME
                // BEFORE reading the first name char, matching XS's astral
                // handling during a name.
                let peek = self.read8(self.offset);
                if peek != b'=' && peek != b'!' {
                    self.flags |= XS_REGEXP_NAME;
                }
                self.next()?;
                if self.character == b'=' as i64 {
                    self.next()?;
                    let term = self.disjunction_parse(b')' as i64)?;
                    self.next()?;
                    let ai = self.assertion_index;
                    self.assertion_index += 1;
                    Ok(self.add_node(Kind::Assertion {
                        term,
                        not: false,
                        direction: -1,
                        assertion_index: ai,
                    }))
                } else if self.character == b'!' as i64 {
                    self.next()?;
                    let term = self.disjunction_parse(b')' as i64)?;
                    self.next()?;
                    let ai = self.assertion_index;
                    self.assertion_index += 1;
                    Ok(self.add_node(Kind::Assertion {
                        term,
                        not: true,
                        direction: -1,
                        assertion_index: ai,
                    }))
                } else {
                    // `(?<name>…)` named capture. Validate the name
                    // (`fxCaptureNameParse`) and register it — a repeat is
                    // `mxDuplicateCapture` — then parse the body as a normal
                    // capturing group. It codegens exactly like a numbered
                    // group; the only difference is the name-slot operand on
                    // its completion, which the matcher records into `names[]`
                    // so `\k<name>` and the JS `.groups` object can resolve it.
                    self.saw_named_group = true;
                    self.capture_index += 1;
                    current_index += 1;
                    let name = self.capture_name_parse()?;
                    if self.capture_names.iter().any(|n| n == &name) {
                        return Err(self.error("duplicate capture"));
                    }
                    let slot = self.name_index;
                    self.capture_names.push(name.clone());
                    self.named_groups.push((name, current_index));
                    self.name_index += 1;
                    let term = self.disjunction_parse(b')' as i64)?;
                    self.next()?;
                    let capture = self.add_node(Kind::Capture {
                        term,
                        capture_index: current_index,
                        name_slot: slot,
                    });
                    self.quantifier_parse(capture, current_index - 1)
                }
            } else {
                // `Modifiers` is `ModifierFlags` optionally followed by
                // `- ModifierFlags`, where each side is a non-repeating run
                // of i/m/s and the two sets are disjoint. The matcher does
                // not implement the scoped flag semantics yet, but the lexer
                // must still reproduce XS's complete accept/reject decision:
                // validate the grammar, parse the enclosed disjunction, then
                // surface the valid feature as a named Unsupported result.
                let mut add = 0u8;
                let mut remove = 0u8;
                let mut removing = false;
                loop {
                    let bit = match self.character {
                        c if c == b'i' as i64 => Some(1u8),
                        c if c == b'm' as i64 => Some(2u8),
                        c if c == b's' as i64 => Some(4u8),
                        _ => None,
                    };
                    if let Some(bit) = bit {
                        if add & bit != 0 || remove & bit != 0 {
                            return Err(self.error("duplicate inline modifier"));
                        }
                        if removing {
                            remove |= bit;
                        } else {
                            add |= bit;
                        }
                        self.next()?;
                        continue;
                    }
                    if self.character == b'-' as i64 && !removing {
                        removing = true;
                        self.next()?;
                        continue;
                    }
                    break;
                }
                if self.character != b':' as i64 || (add | remove) == 0 || (removing && remove == 0)
                {
                    return Err(self.error("invalid inline modifiers"));
                }
                self.unsupported.get_or_insert("(?flags:) inline modifiers");
                self.next()?;
                let current = self.disjunction_parse(b')' as i64)?;
                self.next()?;
                self.quantifier_parse(current, current_index)
            }
        } else {
            self.capture_index += 1;
            current_index += 1;
            let term = self.disjunction_parse(b')' as i64)?;
            self.next()?;
            let capture = self.add_node(Kind::Capture {
                term,
                capture_index: current_index,
                name_slot: -1,
            });
            self.quantifier_parse(capture, current_index - 1)
        }
    }

    // ---- the measure pass (fx*Measure) ----

    fn measure(&mut self, id: NodeId, direction: i32) {
        // Split-borrow: read the kind's child ids first, mutate offsets
        // after. We recurse by id, so the arena stays coherent.
        match self.child_shape(id) {
            Shape::Term => {
                self.nodes[id].step = self.size as i32;
                self.size += 8; // mxTermStepSize
            }
            Shape::CharSet(count) => {
                self.nodes[id].step = self.size as i32;
                self.size += 8 + ((1 + count) as i64) * 4;
            }
            Shape::Disjunction(left, right) => {
                self.nodes[id].step = self.size as i32;
                self.size += 12; // mxDisjunctionStepSize
                self.measure(left, direction);
                self.measure(right, direction);
            }
            Shape::Sequence(left, right) => {
                if direction == 1 {
                    self.measure(left, direction);
                    let s = self.nodes[left].step;
                    self.nodes[id].step = s;
                    self.measure(right, direction);
                } else {
                    self.measure(right, direction);
                    let s = self.nodes[right].step;
                    self.nodes[id].step = s;
                    self.measure(left, direction);
                }
            }
            Shape::Capture(term) => {
                self.nodes[id].step = self.size as i32;
                self.size += 12; // mxCaptureStepSize
                self.measure(term, direction);
                self.nodes[id].completion = self.size as i32;
                self.size += 16; // mxCaptureCompletionSize
            }
            Shape::CaptureReference => {
                self.nodes[id].step = self.size as i32;
                self.size += 16; // mxCaptureReferenceStepSize
            }
            Shape::Assertion {
                term,
                not,
                direction: dir,
            } => {
                self.nodes[id].step = self.size as i32;
                self.size += if not { 16 } else { 12 };
                self.measure(term, dir);
                self.nodes[id].completion = self.size as i32;
                self.size += if not { 8 } else { 12 };
            }
            Shape::Quantifier(term) => {
                self.nodes[id].step = self.size as i32;
                self.size += 20; // mxQuantifierStepSize
                self.nodes[id].loop_off = self.size as i32;
                self.size += 24; // mxQuantifierLoopSize
                self.measure(term, direction);
                self.nodes[id].completion = self.size as i32;
                self.size += 24; // mxQuantifierCompletionSize
            }
        }
    }

    // ---- the code pass (fx*Code) ----

    fn emit(&mut self, id: NodeId, direction: i32, sequel: i32) {
        match self.child_shape(id) {
            Shape::Term => {
                let opcode = match &self.nodes[id].kind {
                    Kind::Empty => CX_EMPTY_STEP,
                    Kind::LineBegin => CX_LINE_BEGIN_STEP,
                    Kind::LineEnd => CX_LINE_END_STEP,
                    Kind::WordBreak => CX_WORD_BREAK_STEP,
                    Kind::WordContinue => CX_WORD_CONTINUE_STEP,
                    _ => unreachable!(),
                };
                let at = (self.nodes[id].step / 4) as usize;
                self.code[at] = opcode;
                self.code[at + 1] = sequel;
            }
            Shape::CharSet(count) => {
                let chars: Vec<i32> = match &self.nodes[id].kind {
                    Kind::CharSet { chars, .. } => chars.clone(),
                    _ => unreachable!(),
                };
                let at = (self.nodes[id].step / 4) as usize;
                self.code[at] = if direction == 1 {
                    CX_CHARSET_FORWARD_STEP
                } else {
                    CX_CHARSET_BACKWARD_STEP
                };
                self.code[at + 1] = sequel;
                self.code[at + 2] = count;
                for i in 0..count as usize {
                    self.code[at + 3 + i] = chars[1 + i];
                }
            }
            Shape::Disjunction(left, right) => {
                let at = (self.nodes[id].step / 4) as usize;
                self.code[at] = CX_DISJUNCTION_STEP;
                self.code[at + 1] = self.nodes[left].step;
                self.code[at + 2] = self.nodes[right].step;
                self.emit(left, direction, sequel);
                self.emit(right, direction, sequel);
            }
            Shape::Sequence(left, right) => {
                if direction == 1 {
                    let right_step = self.nodes[right].step;
                    self.emit(left, direction, right_step);
                    self.emit(right, direction, sequel);
                } else {
                    let left_step = self.nodes[left].step;
                    self.emit(right, direction, left_step);
                    self.emit(left, direction, sequel);
                }
            }
            Shape::Capture(term) => {
                let (step, completion, capture_index, name_slot) = {
                    let n = &self.nodes[id];
                    let (ci, ns) = match &n.kind {
                        Kind::Capture {
                            capture_index,
                            name_slot,
                            ..
                        } => (*capture_index, *name_slot),
                        _ => unreachable!(),
                    };
                    (n.step, n.completion, ci, ns)
                };
                let term_step = self.nodes[term].step;
                let at = (step / 4) as usize;
                self.code[at] = if direction == 1 {
                    CX_CAPTURE_FORWARD_STEP
                } else {
                    CX_CAPTURE_BACKWARD_STEP
                };
                self.code[at + 1] = term_step;
                self.code[at + 2] = capture_index;
                self.emit(term, direction, completion);
                let ct = (completion / 4) as usize;
                self.code[ct] = if direction == 1 {
                    CX_CAPTURE_FORWARD_COMPLETION
                } else {
                    CX_CAPTURE_BACKWARD_COMPLETION
                };
                self.code[ct + 1] = sequel;
                self.code[ct + 2] = capture_index;
                // The name-id operand: the group's name slot for a named
                // capture (so the matcher records `names[slot] = index` on
                // completion), or -1 for a plain numbered group.
                self.code[ct + 3] = name_slot;
            }
            Shape::CaptureReference => {
                let (capture_index, name_slot) = match &self.nodes[id].kind {
                    Kind::CaptureReference {
                        capture_index,
                        name_slot,
                    } => (*capture_index, *name_slot),
                    _ => unreachable!(),
                };
                let at = (self.nodes[id].step / 4) as usize;
                self.code[at] = if direction == 1 {
                    CX_CAPTURE_REFERENCE_FORWARD_STEP
                } else {
                    CX_CAPTURE_REFERENCE_BACKWARD_STEP
                };
                self.code[at + 1] = sequel;
                // A numbered `\N` reference carries its resolved index and a
                // name-id of -1; a `\k<name>` reference carries index -1 and
                // its name slot, resolved at match time through `names[]`.
                self.code[at + 2] = capture_index;
                self.code[at + 3] = name_slot;
            }
            Shape::Assertion {
                term,
                not,
                direction: dir,
            } => {
                let (step, completion, ai) = {
                    let n = &self.nodes[id];
                    let ai = match &n.kind {
                        Kind::Assertion {
                            assertion_index, ..
                        } => *assertion_index,
                        _ => unreachable!(),
                    };
                    (n.step, n.completion, ai)
                };
                let term_step = self.nodes[term].step;
                let at = (step / 4) as usize;
                if not {
                    self.code[at] = CX_ASSERTION_NOT_STEP;
                    self.code[at + 1] = term_step;
                    self.code[at + 2] = ai;
                    self.code[at + 3] = sequel;
                } else {
                    self.code[at] = CX_ASSERTION_STEP;
                    self.code[at + 1] = term_step;
                    self.code[at + 2] = ai;
                }
                self.emit(term, dir, completion);
                let ct = (completion / 4) as usize;
                if not {
                    self.code[ct] = CX_ASSERTION_NOT_COMPLETION;
                    self.code[ct + 1] = ai;
                } else {
                    self.code[ct] = CX_ASSERTION_COMPLETION;
                    self.code[ct + 1] = sequel;
                    self.code[ct + 2] = ai;
                }
            }
            Shape::Quantifier(term) => {
                let (
                    step,
                    loop_off,
                    completion,
                    greedy,
                    quantifier_index,
                    capture_index,
                    capture_count,
                    min,
                    max,
                ) = {
                    let n = &self.nodes[id];
                    match &n.kind {
                        Kind::Quantifier {
                            min,
                            max,
                            greedy,
                            capture_index,
                            capture_count,
                            quantifier_index,
                            ..
                        } => (
                            n.step,
                            n.loop_off,
                            n.completion,
                            *greedy,
                            *quantifier_index,
                            *capture_index,
                            *capture_count,
                            *min,
                            *max,
                        ),
                        _ => unreachable!(),
                    }
                };
                let term_step = self.nodes[term].step;
                let at = (step / 4) as usize;
                self.code[at] = CX_QUANTIFIER_STEP;
                self.code[at + 1] = loop_off;
                self.code[at + 2] = quantifier_index;
                self.code[at + 3] = min;
                self.code[at + 4] = max;
                let lp = (loop_off / 4) as usize;
                self.code[lp] = if greedy {
                    CX_QUANTIFIER_GREEDY_LOOP
                } else {
                    CX_QUANTIFIER_LAZY_LOOP
                };
                self.code[lp + 1] = term_step;
                self.code[lp + 2] = quantifier_index;
                self.code[lp + 3] = sequel;
                self.code[lp + 4] = capture_index + 1;
                self.code[lp + 5] = capture_index + capture_count;
                self.emit(term, direction, completion);
                let ct = (completion / 4) as usize;
                self.code[ct] = CX_QUANTIFIER_COMPLETION;
                self.code[ct + 1] = loop_off;
                self.code[ct + 2] = quantifier_index;
                self.code[ct + 3] = sequel;
                self.code[ct + 4] = capture_index + 1;
                self.code[ct + 5] = capture_index + capture_count;
            }
        }
    }

    /// Classify a node into its measure/code shape, reading child ids and
    /// charset count without holding a borrow across the recursive calls.
    fn child_shape(&self, id: NodeId) -> Shape {
        match &self.nodes[id].kind {
            Kind::CharSet { chars, .. } => Shape::CharSet(chars[0]),
            Kind::Empty
            | Kind::LineBegin
            | Kind::LineEnd
            | Kind::WordBreak
            | Kind::WordContinue => Shape::Term,
            Kind::Disjunction { left, right } => Shape::Disjunction(*left, *right),
            Kind::Sequence { left, right } => Shape::Sequence(*left, *right),
            Kind::Capture { term, .. } => Shape::Capture(*term),
            Kind::CaptureReference { .. } => Shape::CaptureReference,
            Kind::Assertion {
                term,
                not,
                direction,
                ..
            } => Shape::Assertion {
                term: *term,
                not: *not,
                direction: *direction,
            },
            Kind::Quantifier { term, .. } => Shape::Quantifier(*term),
        }
    }
}

enum Shape {
    Term,
    CharSet(i32),
    Disjunction(NodeId, NodeId),
    Sequence(NodeId, NodeId),
    Capture(NodeId),
    CaptureReference,
    Assertion {
        term: NodeId,
        not: bool,
        direction: i32,
    },
    Quantifier(NodeId),
}

fn hex_digit(c: u8) -> Option<u32> {
    match c {
        b'0'..=b'9' => Some((c - b'0') as u32),
        b'a'..=b'f' => Some((c - b'a' + 10) as u32),
        b'A'..=b'F' => Some((c - b'A' + 10) as u32),
        _ => None,
    }
}

/// Is the resolved group-name code point a valid `ID_Start` (`first`) or
/// `ID_Continue` (`fxIsIdentifierFirst` / `fxIsIdentifierNext`)? A negative
/// (`C_EOF`) or out-of-range value is never an identifier.
fn is_ident_scalar(c: i64, first: bool) -> bool {
    if !(0..=0x10_FFFF).contains(&c) {
        return false;
    }
    let c = c as u32;
    if first {
        crate::unicode::is_identifier_first(c)
    } else {
        crate::unicode::is_identifier_next(c)
    }
}

/// Append a validated group-name code point to the accumulated name. The
/// point has already passed `is_ident_scalar`, so it is a real scalar.
fn push_name_char(name: &mut String, c: i64) {
    if let Some(ch) = char::from_u32(c as u32) {
        name.push(ch);
    }
}

/// The syntax characters that are identity escapes (`fxPatternParserEscape`
/// explicit cases) regardless of `punctuator`.
fn is_syntax_char(c: i64) -> bool {
    matches!(
        c as u8 as char,
        '^' | '$' | '\\' | '.' | '*' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '|' | '/'
    ) && (0..=0x7F).contains(&c)
}

fn is_v_maybe_doubled_punctuator(c: i64) -> bool {
    (0..=0x7f).contains(&c)
        && matches!(
            c as u8 as char,
            '&' | '!'
                | '#'
                | '$'
                | '%'
                | '*'
                | '+'
                | ','
                | '.'
                | ':'
                | ';'
                | '<'
                | '='
                | '>'
                | '?'
                | '@'
                | '^'
                | '`'
                | '~'
        )
}

fn is_v_reserved_punctuator(c: i64) -> bool {
    (0..=0x7f).contains(&c)
        && matches!(
            c as u8 as char,
            '(' | ')' | '[' | ']' | '{' | '}' | '/' | '-' | '\\' | '|'
        )
}
