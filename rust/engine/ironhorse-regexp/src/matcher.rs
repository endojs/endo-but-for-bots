//! The backtracking match VM: a faithful port of `fxMatchRegExp`
//! (`xsre.c`). It interprets the integer step stream the [`crate::compile`]
//! pass emits, using an explicit state stack for backtracking, and meters
//! `XS_REGEXP_METERING` per dispatched step — the matcher's consensus
//! cost, and the number the parity suite pins bit-exact against the pin.
//!
//! The C engine keeps its backtrack states as a linked list threaded
//! through the machine stack or `c_malloc`; the safe port keeps them in a
//! `Vec<State>` and records an assertion's saved point as a **length
//! marker** into that vector, which `fxPopStates(from, to)` becomes a
//! `truncate`. This is behaviorally identical and needs no `unsafe`.

use crate::compile::Program;
use crate::flags::*;
use crate::opcode::*;
use crate::encoding::{find_character, get_character};

/// `gxLineCharacters` (xsre.c): the line terminators, as charset ranges.
const LINE_CHARACTERS: [i32; 7] = [6, 0x000A, 0x000A + 1, 0x000D, 0x000D + 1, 0x2028, 0x2029 + 1];
/// `gxWordCharacters` (xsre.c): the `\w` set, as charset ranges.
const WORD_CHARACTERS: [i32; 9] =
    [8, b'0' as i32, b'9' as i32 + 1, b'A' as i32, b'Z' as i32 + 1, b'_' as i32, b'_' as i32 + 1, b'a' as i32, b'z' as i32 + 1];

/// The outcome of running a compiled pattern over a subject.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatchOutcome {
    /// `true` if the pattern matched at or after `start`.
    pub matched: bool,
    /// `(from, to)` byte-offset pairs — `capture_count` of them, index 0
    /// the whole match; an unset capture is `(-1, -1)`.
    pub captures: Vec<(i32, i32)>,
    /// Match meter in raw 16.16 fixed point: `steps * XS_REGEXP_METERING`.
    pub match_meter_raw: u64,
}

impl MatchOutcome {
    /// `match_meter_raw >> 16`, the integer match computrons.
    pub fn match_computrons(&self) -> u64 {
        self.match_meter_raw >> 16
    }
}

#[derive(Clone)]
struct State {
    step: i32,
    offset: i32,
    flags: i32,
    captures: Vec<(i32, i32)>,
}

#[derive(Clone, Copy)]
struct AssertionData {
    offset: i32,
    first_state: usize, // marker: states.len() at entry
}

#[derive(Clone, Copy)]
struct QuantifierData {
    min: i32,
    max: i32,
    offset: i32,
}

/// Port of `fxMatchCharacter`: binary search `character` in a charset's
/// sorted half-open ranges. `chars[0]` is the endpoint count; ranges are
/// `[chars[1],chars[2]), [chars[3],chars[4]), ...`.
fn match_character(chars: &[i32], base_at: usize, count: i32, character: i64) -> bool {
    // `base_at` points at chars[count]'s first endpoint (chars[base_at]).
    let mut min = 0i32;
    let mut max = count >> 1;
    while min < max {
        let mid = (min + max) >> 1;
        let begin = chars[base_at + (mid as usize * 2)] as i64;
        let end = chars[base_at + (mid as usize * 2) + 1] as i64;
        if character < begin {
            max = mid;
        } else if character >= end {
            min = mid + 1;
        } else {
            return true;
        }
    }
    false
}

/// Match a compiled `program` against `subject` (raw UTF-8 bytes, no
/// trailing NUL needed) starting at byte offset `start`.
pub fn match_regexp(program: &Program, subject: &[u8], start: i32) -> MatchOutcome {
    let code = &program.code;
    let stop = subject.len() as i32;
    let base_flags = code[0];
    let capture_count = program.capture_count;
    let name_count = program.name_count;

    let mut captures: Vec<(i32, i32)> = vec![(-1, -1); capture_count];
    let mut names: Vec<i32> = vec![-1; name_count];
    let mut assertions: Vec<AssertionData> =
        vec![AssertionData { offset: 0, first_state: 0 }; program.assertion_count];
    let mut quantifiers: Vec<QuantifierData> =
        vec![QuantifierData { min: 0, max: 0, offset: 0 }; program.quantifier_count];
    let mut states: Vec<State> = Vec::new();

    let mut meter: u64 = 0;
    let mut result = false;
    let mut start = start;

    let first_step = (5 + name_count as i32) * 4;

    if start >= 0 && start <= stop {
        'scan: loop {
            let mut step = first_step;
            let mut offset = start;
            let mut flags = base_flags;
            for c in captures.iter_mut() {
                *c = (-1, -1);
            }
            for n in names.iter_mut() {
                *n = -1;
            }

            while step != 0 {
                let at = (step / 4) as usize;
                let which = code[at];
                let mut p = at + 1; // operand cursor (past the opcode)
                meter += XS_REGEXP_METERING;

                // Set to true by a step that decides to backtrack.
                let mut pop = false;

                match which {
                    CX_MATCH_STEP => {
                        captures[0] = (start, offset);
                        step = 0;
                        result = true;
                    }
                    CX_ASSERTION_STEP => {
                        step = code[p];
                        p += 1;
                        let ai = code[p] as usize;
                        assertions[ai].offset = offset;
                        assertions[ai].first_state = states.len();
                    }
                    CX_ASSERTION_COMPLETION => {
                        step = code[p];
                        p += 1;
                        let ai = code[p] as usize;
                        offset = assertions[ai].offset;
                        states.truncate(assertions[ai].first_state);
                    }
                    CX_ASSERTION_NOT_STEP => {
                        step = code[p];
                        p += 1;
                        let ai = code[p] as usize;
                        p += 1;
                        assertions[ai].offset = offset;
                        assertions[ai].first_state = states.len();
                        let sequel = code[p];
                        states.push(State { step: sequel, offset, flags, captures: captures.clone() });
                    }
                    CX_ASSERTION_NOT_COMPLETION => {
                        let ai = code[p] as usize;
                        offset = assertions[ai].offset;
                        states.truncate(assertions[ai].first_state);
                        pop = true;
                    }
                    CX_CAPTURE_BACKWARD_STEP => {
                        step = code[p];
                        p += 1;
                        let e = code[p] as usize;
                        captures[e].1 = offset;
                    }
                    CX_CAPTURE_BACKWARD_COMPLETION => {
                        step = code[p];
                        p += 1;
                        let e = code[p] as usize;
                        p += 1;
                        captures[e].0 = offset;
                        let f = code[p];
                        if f >= 0 {
                            names[f as usize] = e as i32;
                        }
                    }
                    CX_CAPTURE_FORWARD_STEP => {
                        step = code[p];
                        p += 1;
                        let e = code[p] as usize;
                        captures[e].0 = offset;
                    }
                    CX_CAPTURE_FORWARD_COMPLETION => {
                        step = code[p];
                        p += 1;
                        let e = code[p] as usize;
                        p += 1;
                        captures[e].1 = offset;
                        let f = code[p];
                        if f >= 0 {
                            names[f as usize] = e as i32;
                        }
                    }
                    CX_CAPTURE_REFERENCE_BACKWARD_STEP => {
                        step = code[p];
                        p += 1;
                        let mut e = code[p];
                        if e < 0 {
                            let f = code[p + 1];
                            e = names[f as usize];
                            if e < 0 {
                                continue; // matched empty (unset named ref)
                            }
                        }
                        let cap = captures[e as usize];
                        let (mut from, to) = (cap.0, cap.1);
                        if from >= 0 && to >= 0 {
                            let target = offset - (to - from);
                            if target < 0 {
                                pop = true;
                            } else {
                                let mut g = target;
                                let mut ok = true;
                                while from < to {
                                    if get_character(subject, g as usize, flags as u32) != get_character(subject, from as usize, flags as u32) {
                                        ok = false;
                                        break;
                                    }
                                    g = find_character(subject, g as usize, 1) as i32;
                                    from = find_character(subject, from as usize, 1) as i32;
                                }
                                if ok {
                                    offset = target;
                                } else {
                                    pop = true;
                                }
                            }
                        }
                    }
                    CX_CAPTURE_REFERENCE_FORWARD_STEP => {
                        step = code[p];
                        p += 1;
                        let mut e = code[p];
                        if e < 0 {
                            let f = code[p + 1];
                            e = names[f as usize];
                            if e < 0 {
                                continue;
                            }
                        }
                        let cap = captures[e as usize];
                        let (mut from, to) = (cap.0, cap.1);
                        if from >= 0 && to >= 0 {
                            let target = offset + (to - from);
                            if target > stop {
                                pop = true;
                            } else {
                                let mut g = offset;
                                let mut ok = true;
                                while from < to {
                                    if get_character(subject, g as usize, flags as u32) != get_character(subject, from as usize, flags as u32) {
                                        ok = false;
                                        break;
                                    }
                                    g = find_character(subject, g as usize, 1) as i32;
                                    from = find_character(subject, from as usize, 1) as i32;
                                }
                                if ok {
                                    offset = target;
                                } else {
                                    pop = true;
                                }
                            }
                        }
                    }
                    CX_CHARSET_BACKWARD_STEP => {
                        step = code[p];
                        p += 1;
                        if offset == 0 {
                            pop = true;
                        } else {
                            let e = find_character(subject, offset as usize, -1) as i32;
                            let count = code[p];
                            if !match_character(code, p + 1, count, get_character(subject, e as usize, flags as u32)) {
                                pop = true;
                            } else {
                                offset = e;
                            }
                        }
                    }
                    CX_CHARSET_FORWARD_STEP => {
                        step = code[p];
                        p += 1;
                        if offset == stop {
                            pop = true;
                        } else {
                            let count = code[p];
                            if !match_character(code, p + 1, count, get_character(subject, offset as usize, flags as u32)) {
                                pop = true;
                            } else {
                                offset = find_character(subject, offset as usize, 1) as i32;
                            }
                        }
                    }
                    CX_DISJUNCTION_STEP => {
                        step = code[p];
                        p += 1;
                        let sequel = code[p];
                        states.push(State { step: sequel, offset, flags, captures: captures.clone() });
                    }
                    CX_EMPTY_STEP => {
                        step = code[p];
                    }
                    CX_LINE_BEGIN_STEP => {
                        step = code[p];
                        if offset == 0 {
                            // ok
                        } else if flags & XS_REGEXP_M as i32 != 0
                            && match_character(
                                &LINE_CHARACTERS,
                                1,
                                LINE_CHARACTERS[0],
                                get_character(subject, find_character(subject, offset as usize, -1), flags as u32),
                            )
                        {
                            // ok
                        } else {
                            pop = true;
                        }
                    }
                    CX_LINE_END_STEP => {
                        step = code[p];
                        if offset == stop {
                            // ok
                        } else if flags & XS_REGEXP_M as i32 != 0
                            && match_character(
                                &LINE_CHARACTERS,
                                1,
                                LINE_CHARACTERS[0],
                                get_character(subject, offset as usize, flags as u32),
                            )
                        {
                            // ok
                        } else {
                            pop = true;
                        }
                    }
                    CX_QUANTIFIER_STEP => {
                        step = code[p];
                        p += 1;
                        let qi = code[p] as usize;
                        p += 1;
                        quantifiers[qi].min = code[p];
                        p += 1;
                        quantifiers[qi].max = code[p];
                        quantifiers[qi].offset = offset;
                    }
                    CX_QUANTIFIER_GREEDY_LOOP => {
                        step = code[p];
                        p += 1;
                        let qi = code[p] as usize;
                        p += 1;
                        let sequel = code[p];
                        p += 1;
                        let from = code[p];
                        p += 1;
                        let to = code[p];
                        if quantifiers[qi].max == 0 {
                            step = sequel;
                        } else {
                            if quantifiers[qi].min == 0 {
                                states.push(State { step: sequel, offset, flags, captures: captures.clone() });
                            }
                            if from <= to {
                                for i in from..=to {
                                    captures[i as usize] = (-1, -1);
                                }
                            }
                        }
                    }
                    CX_QUANTIFIER_LAZY_LOOP => {
                        step = code[p];
                        p += 1;
                        let qi = code[p] as usize;
                        p += 1;
                        let sequel = code[p];
                        p += 1;
                        let from = code[p];
                        p += 1;
                        let to = code[p];
                        if quantifiers[qi].max == 0 {
                            step = sequel;
                        } else if quantifiers[qi].min == 0 {
                            states.push(State { step, offset, flags, captures: captures.clone() });
                            step = sequel;
                        } else if from <= to {
                            for i in from..=to {
                                captures[i as usize] = (-1, -1);
                            }
                        }
                    }
                    CX_QUANTIFIER_COMPLETION => {
                        step = code[p];
                        p += 1;
                        let qi = code[p] as usize;
                        p += 1;
                        let sequel = code[p];
                        p += 1;
                        let from = code[p];
                        p += 1;
                        let to = code[p];
                        if quantifiers[qi].min == 0 && quantifiers[qi].offset == offset {
                            if from <= to {
                                for i in from..=to {
                                    captures[i as usize] = (-1, -1);
                                }
                            }
                            step = sequel;
                        } else {
                            quantifiers[qi].min = if quantifiers[qi].min == 0 { 0 } else { quantifiers[qi].min - 1 };
                            quantifiers[qi].max = if quantifiers[qi].max == 0x7FFF_FFFF {
                                0x7FFF_FFFF
                            } else if quantifiers[qi].max == 0 {
                                0
                            } else {
                                quantifiers[qi].max - 1
                            };
                            quantifiers[qi].offset = offset;
                        }
                    }
                    CX_WORD_BREAK_STEP => {
                        step = code[p];
                        let e = word_at(subject, offset, 0, flags);
                        let f = word_at(subject, offset, stop, flags);
                        if e != f {
                            // ok
                        } else {
                            pop = true;
                        }
                    }
                    CX_WORD_CONTINUE_STEP => {
                        step = code[p];
                        let e = word_at(subject, offset, 0, flags);
                        let f = word_at(subject, offset, stop, flags);
                        if e == f {
                            // ok
                        } else {
                            pop = true;
                        }
                    }
                    CX_MODIFIERS_STEP => {
                        step = code[p];
                        p += 1;
                        flags = code[p];
                    }
                    _ => unreachable!("bad step opcode {}", which),
                }

                if pop {
                    // mxPopState.
                    match states.pop() {
                        None => {
                            step = 0;
                            flags = base_flags;
                        }
                        Some(st) => {
                            step = st.step;
                            offset = st.offset;
                            flags = st.flags;
                            captures.copy_from_slice(&st.captures);
                        }
                    }
                }
            }

            states.clear();
            if base_flags & XS_REGEXP_Y as i32 != 0 {
                break 'scan;
            }
            if result {
                break 'scan;
            }
            if start == stop {
                break 'scan;
            }
            start = find_character(subject, start as usize, 1) as i32;
        }
    }

    MatchOutcome { matched: result, captures, match_meter_raw: meter }
}

/// `(offset == boundary) ? 0 : \w-membership of the char before/at
/// offset`. `boundary` is `0` for the left probe (char before `offset`)
/// and `stop` for the right probe (char at `offset`), matching the two
/// `fxMatchCharacter` probes in `cxWordBreakStep`.
fn word_at(subject: &[u8], offset: i32, boundary: i32, flags: i32) -> bool {
    if offset == boundary {
        return false;
    }
    let at = if boundary == 0 {
        find_character(subject, offset as usize, -1)
    } else {
        offset as usize
    };
    match_character(&WORD_CHARACTERS, 1, WORD_CHARACTERS[0], get_character(subject, at, flags as u32))
}
