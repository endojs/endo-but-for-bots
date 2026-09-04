//! The XSRE step opcodes (`cx*Step` enum in `xsre.c`) and the two
//! metering weights. The enum values are the dispatch indices shared by
//! the compiler's code emission and the matcher's `mxSwitch`, so they
//! must stay identical to the pin's ordering.

/// `cx*Step` enum values (xsre.c, verbatim ordering).
pub const CX_MATCH_STEP: i32 = 0;
pub const CX_ASSERTION_STEP: i32 = 1;
pub const CX_ASSERTION_COMPLETION: i32 = 2;
pub const CX_ASSERTION_NOT_STEP: i32 = 3;
pub const CX_ASSERTION_NOT_COMPLETION: i32 = 4;
pub const CX_CAPTURE_FORWARD_STEP: i32 = 5;
pub const CX_CAPTURE_FORWARD_COMPLETION: i32 = 6;
pub const CX_CAPTURE_BACKWARD_STEP: i32 = 7;
pub const CX_CAPTURE_BACKWARD_COMPLETION: i32 = 8;
pub const CX_CAPTURE_REFERENCE_FORWARD_STEP: i32 = 9;
pub const CX_CAPTURE_REFERENCE_BACKWARD_STEP: i32 = 10;
pub const CX_CHARSET_FORWARD_STEP: i32 = 11;
pub const CX_CHARSET_BACKWARD_STEP: i32 = 12;
pub const CX_DISJUNCTION_STEP: i32 = 13;
pub const CX_EMPTY_STEP: i32 = 14;
pub const CX_LINE_BEGIN_STEP: i32 = 15;
pub const CX_LINE_END_STEP: i32 = 16;
pub const CX_QUANTIFIER_STEP: i32 = 17;
pub const CX_QUANTIFIER_GREEDY_LOOP: i32 = 18;
pub const CX_QUANTIFIER_LAZY_LOOP: i32 = 19;
pub const CX_QUANTIFIER_COMPLETION: i32 = 20;
pub const CX_WORD_BREAK_STEP: i32 = 21;
pub const CX_WORD_CONTINUE_STEP: i32 = 22;
pub const CX_MODIFIERS_STEP: i32 = 23;

/// `XS_REGEXP_METERING` (`xsCommon.h`): the 16.16 fixed-point cost of
/// dispatching one match step.
pub const XS_REGEXP_METERING: u64 = 1 << 16;

/// `XS_PARSE_REGEXP_METERING` (`xsCommon.h`): the per-byte compile cost;
/// `fxCompileRegExp` charges `size * XS_PARSE_REGEXP_METERING`.
pub const XS_PARSE_REGEXP_METERING: u64 = 1 << 10;
