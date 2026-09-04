// GENERATED from c/moddable xs/sources/xsCommon.h (enum) and xsCommon.c
// (gxCodeNames, gxCodeSizes) at pin 48ee02d8cfe0. Do not edit by hand.
// Opcode discriminant == XS bytecode byte value (enum index).
#[allow(non_camel_case_types)]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Opcode {
    XS_NO_CODE = 0,
    XS_CODE_ADD = 1,
    XS_CODE_ARGUMENT = 2,
    XS_CODE_ARGUMENTS = 3,
    XS_CODE_ARGUMENTS_SLOPPY = 4,
    XS_CODE_ARGUMENTS_STRICT = 5,
    XS_CODE_ARRAY = 6,
    XS_CODE_ASYNC_FUNCTION = 7,
    XS_CODE_ASYNC_GENERATOR_FUNCTION = 8,
    XS_CODE_AT = 9,
    XS_CODE_AWAIT = 10,
    XS_CODE_BEGIN_SLOPPY = 11,
    XS_CODE_BEGIN_STRICT = 12,
    XS_CODE_BEGIN_STRICT_BASE = 13,
    XS_CODE_BEGIN_STRICT_DERIVED = 14,
    XS_CODE_BEGIN_STRICT_FIELD = 15,
    XS_CODE_BIGINT_1 = 16,
    XS_CODE_BIGINT_2 = 17,
    XS_CODE_BIT_AND = 18,
    XS_CODE_BIT_NOT = 19,
    XS_CODE_BIT_OR = 20,
    XS_CODE_BIT_XOR = 21,
    XS_CODE_BRANCH_1 = 22,
    XS_CODE_BRANCH_2 = 23,
    XS_CODE_BRANCH_4 = 24,
    XS_CODE_BRANCH_CHAIN_1 = 25,
    XS_CODE_BRANCH_CHAIN_2 = 26,
    XS_CODE_BRANCH_CHAIN_4 = 27,
    XS_CODE_BRANCH_COALESCE_1 = 28,
    XS_CODE_BRANCH_COALESCE_2 = 29,
    XS_CODE_BRANCH_COALESCE_4 = 30,
    XS_CODE_BRANCH_ELSE_1 = 31,
    XS_CODE_BRANCH_ELSE_2 = 32,
    XS_CODE_BRANCH_ELSE_4 = 33,
    XS_CODE_BRANCH_IF_1 = 34,
    XS_CODE_BRANCH_IF_2 = 35,
    XS_CODE_BRANCH_IF_4 = 36,
    XS_CODE_BRANCH_STATUS_1 = 37,
    XS_CODE_BRANCH_STATUS_2 = 38,
    XS_CODE_BRANCH_STATUS_4 = 39,
    XS_CODE_CALL = 40,
    XS_CODE_CATCH_1 = 41,
    XS_CODE_CATCH_2 = 42,
    XS_CODE_CATCH_4 = 43,
    XS_CODE_CHECK_INSTANCE = 44,
    XS_CODE_CLASS = 45,
    XS_CODE_CODE_1 = 46,
    XS_CODE_CODE_2 = 47,
    XS_CODE_CODE_4 = 48,
    XS_CODE_CODE_ARCHIVE_1 = 49,
    XS_CODE_CODE_ARCHIVE_2 = 50,
    XS_CODE_CODE_ARCHIVE_4 = 51,
    XS_CODE_CONST_CLOSURE_1 = 52,
    XS_CODE_CONST_CLOSURE_2 = 53,
    XS_CODE_CONST_LOCAL_1 = 54,
    XS_CODE_CONST_LOCAL_2 = 55,
    XS_CODE_CONSTRUCTOR_FUNCTION = 56,
    XS_CODE_COPY_OBJECT = 57,
    XS_CODE_CURRENT = 58,
    XS_CODE_DEBUGGER = 59,
    XS_CODE_DECREMENT = 60,
    XS_CODE_DELETE_PROPERTY = 61,
    XS_CODE_DELETE_PROPERTY_AT = 62,
    XS_CODE_DELETE_SUPER = 63,
    XS_CODE_DELETE_SUPER_AT = 64,
    XS_CODE_DIVIDE = 65,
    XS_CODE_DUB = 66,
    XS_CODE_DUB_AT = 67,
    XS_CODE_END = 68,
    XS_CODE_END_ARROW = 69,
    XS_CODE_END_BASE = 70,
    XS_CODE_END_DERIVED = 71,
    XS_CODE_ENVIRONMENT = 72,
    XS_CODE_EQUAL = 73,
    XS_CODE_EVAL = 74,
    XS_CODE_EVAL_ENVIRONMENT = 75,
    XS_CODE_EVAL_PRIVATE = 76,
    XS_CODE_EVAL_REFERENCE = 77,
    XS_CODE_EVAL_TAIL = 78,
    XS_CODE_EXCEPTION = 79,
    XS_CODE_EXPONENTIATION = 80,
    XS_CODE_EXTEND = 81,
    XS_CODE_FALSE = 82,
    XS_CODE_FILE = 83,
    XS_CODE_FOR_AWAIT_OF = 84,
    XS_CODE_FOR_IN = 85,
    XS_CODE_FOR_OF = 86,
    XS_CODE_FUNCTION = 87,
    XS_CODE_FUNCTION_ENVIRONMENT = 88,
    XS_CODE_GENERATOR_FUNCTION = 89,
    XS_CODE_GET_CLOSURE_1 = 90,
    XS_CODE_GET_CLOSURE_2 = 91,
    XS_CODE_GET_LOCAL_1 = 92,
    XS_CODE_GET_LOCAL_2 = 93,
    XS_CODE_GET_PRIVATE_1 = 94,
    XS_CODE_GET_PRIVATE_2 = 95,
    XS_CODE_GET_PROPERTY = 96,
    XS_CODE_GET_PROPERTY_AT = 97,
    XS_CODE_GET_RESULT = 98,
    XS_CODE_GET_SUPER = 99,
    XS_CODE_GET_SUPER_AT = 100,
    XS_CODE_GET_THIS = 101,
    XS_CODE_GET_THIS_VARIABLE = 102,
    XS_CODE_GET_VARIABLE = 103,
    XS_CODE_GLOBAL = 104,
    XS_CODE_HAS_PRIVATE_1 = 105,
    XS_CODE_HAS_PRIVATE_2 = 106,
    XS_CODE_HOST = 107,
    XS_CODE_IMPORT = 108,
    XS_CODE_IMPORT_META = 109,
    XS_CODE_IN = 110,
    XS_CODE_INCREMENT = 111,
    XS_CODE_INSTANCEOF = 112,
    XS_CODE_INSTANTIATE = 113,
    XS_CODE_INTEGER_1 = 114,
    XS_CODE_INTEGER_2 = 115,
    XS_CODE_INTEGER_4 = 116,
    XS_CODE_LEFT_SHIFT = 117,
    XS_CODE_LESS = 118,
    XS_CODE_LESS_EQUAL = 119,
    XS_CODE_LET_CLOSURE_1 = 120,
    XS_CODE_LET_CLOSURE_2 = 121,
    XS_CODE_LET_LOCAL_1 = 122,
    XS_CODE_LET_LOCAL_2 = 123,
    XS_CODE_LINE = 124,
    XS_CODE_MINUS = 125,
    XS_CODE_MODULE = 126,
    XS_CODE_MODULO = 127,
    XS_CODE_MORE = 128,
    XS_CODE_MORE_EQUAL = 129,
    XS_CODE_MULTIPLY = 130,
    XS_CODE_NAME = 131,
    XS_CODE_NEW = 132,
    XS_CODE_NEW_CLOSURE = 133,
    XS_CODE_NEW_LOCAL = 134,
    XS_CODE_NEW_PRIVATE_1 = 135,
    XS_CODE_NEW_PRIVATE_2 = 136,
    XS_CODE_NEW_PROPERTY = 137,
    XS_CODE_NEW_PROPERTY_AT = 138,
    XS_CODE_NEW_TEMPORARY = 139,
    XS_CODE_NOT = 140,
    XS_CODE_NOT_EQUAL = 141,
    XS_CODE_NULL = 142,
    XS_CODE_NUMBER = 143,
    XS_CODE_OBJECT = 144,
    XS_CODE_PLUS = 145,
    XS_CODE_POP = 146,
    XS_CODE_PROGRAM_ENVIRONMENT = 147,
    XS_CODE_PROGRAM_REFERENCE = 148,
    XS_CODE_PULL_CLOSURE_1 = 149,
    XS_CODE_PULL_CLOSURE_2 = 150,
    XS_CODE_PULL_LOCAL_1 = 151,
    XS_CODE_PULL_LOCAL_2 = 152,
    XS_CODE_REFRESH_CLOSURE_1 = 153,
    XS_CODE_REFRESH_CLOSURE_2 = 154,
    XS_CODE_REFRESH_LOCAL_1 = 155,
    XS_CODE_REFRESH_LOCAL_2 = 156,
    XS_CODE_REGEXP = 157,
    XS_CODE_RESERVE_1 = 158,
    XS_CODE_RESERVE_2 = 159,
    XS_CODE_RESET_CLOSURE_1 = 160,
    XS_CODE_RESET_CLOSURE_2 = 161,
    XS_CODE_RESET_LOCAL_1 = 162,
    XS_CODE_RESET_LOCAL_2 = 163,
    XS_CODE_RETHROW = 164,
    XS_CODE_RETRIEVE_1 = 165,
    XS_CODE_RETRIEVE_2 = 166,
    XS_CODE_RETRIEVE_TARGET = 167,
    XS_CODE_RETRIEVE_THIS = 168,
    XS_CODE_RETURN = 169,
    XS_CODE_RUN = 170,
    XS_CODE_RUN_1 = 171,
    XS_CODE_RUN_2 = 172,
    XS_CODE_RUN_4 = 173,
    XS_CODE_RUN_TAIL = 174,
    XS_CODE_RUN_TAIL_1 = 175,
    XS_CODE_RUN_TAIL_2 = 176,
    XS_CODE_RUN_TAIL_4 = 177,
    XS_CODE_SET_CLOSURE_1 = 178,
    XS_CODE_SET_CLOSURE_2 = 179,
    XS_CODE_SET_HOME = 180,
    XS_CODE_SET_LOCAL_1 = 181,
    XS_CODE_SET_LOCAL_2 = 182,
    XS_CODE_SET_PRIVATE_1 = 183,
    XS_CODE_SET_PRIVATE_2 = 184,
    XS_CODE_SET_PROPERTY = 185,
    XS_CODE_SET_PROPERTY_AT = 186,
    XS_CODE_SET_RESULT = 187,
    XS_CODE_SET_SUPER = 188,
    XS_CODE_SET_SUPER_AT = 189,
    XS_CODE_SET_THIS = 190,
    XS_CODE_SET_VARIABLE = 191,
    XS_CODE_SIGNED_RIGHT_SHIFT = 192,
    XS_CODE_START_ASYNC = 193,
    XS_CODE_START_ASYNC_GENERATOR = 194,
    XS_CODE_START_GENERATOR = 195,
    XS_CODE_STORE_1 = 196,
    XS_CODE_STORE_2 = 197,
    XS_CODE_STORE_ARROW = 198,
    XS_CODE_STRICT_EQUAL = 199,
    XS_CODE_STRICT_NOT_EQUAL = 200,
    XS_CODE_STRING_1 = 201,
    XS_CODE_STRING_2 = 202,
    XS_CODE_STRING_4 = 203,
    XS_CODE_STRING_ARCHIVE_1 = 204,
    XS_CODE_STRING_ARCHIVE_2 = 205,
    XS_CODE_STRING_ARCHIVE_4 = 206,
    XS_CODE_SUBTRACT = 207,
    XS_CODE_SUPER = 208,
    XS_CODE_SWAP = 209,
    XS_CODE_SYMBOL = 210,
    XS_CODE_TARGET = 211,
    XS_CODE_TEMPLATE = 212,
    XS_CODE_TEMPLATE_CACHE = 213,
    XS_CODE_THIS = 214,
    XS_CODE_THROW = 215,
    XS_CODE_THROW_STATUS = 216,
    XS_CODE_TO_INSTANCE = 217,
    XS_CODE_TO_NUMERIC = 218,
    XS_CODE_TO_STRING = 219,
    XS_CODE_TRANSFER = 220,
    XS_CODE_TRUE = 221,
    XS_CODE_TYPEOF = 222,
    XS_CODE_UNCATCH = 223,
    XS_CODE_UNDEFINED = 224,
    XS_CODE_UNSIGNED_RIGHT_SHIFT = 225,
    XS_CODE_UNWIND_1 = 226,
    XS_CODE_UNWIND_2 = 227,
    XS_CODE_VAR_CLOSURE_1 = 228,
    XS_CODE_VAR_CLOSURE_2 = 229,
    XS_CODE_VAR_LOCAL_1 = 230,
    XS_CODE_VAR_LOCAL_2 = 231,
    XS_CODE_VOID = 232,
    XS_CODE_WITH = 233,
    XS_CODE_WITHOUT = 234,
    XS_CODE_YIELD = 235,
    XS_CODE_PROFILE = 236,
    XS_CODE_YIELD_STAR = 237,
    XS_CODE_USED_1 = 238,
    XS_CODE_USED_2 = 239,
    XS_CODE_USING = 240,
    XS_CODE_USING_ASYNC = 241,
    XS_CODE_AT_2 = 242,
    XS_CODE_SUPER_AT = 243,
    XS_CODE_SUPER_AT_2 = 244,
    XS_CODE_TRANSFER_JSON = 245,
}

pub const XS_CODE_COUNT: usize = 246;

/// Instruction size in bytes (opcode + operands), indexed by opcode byte.
pub static CODE_SIZES: [i8; XS_CODE_COUNT] = [
    1, // XS_NO_CODE
    1, // XS_CODE_ADD
    2, // XS_CODE_ARGUMENT
    2, // XS_CODE_ARGUMENTS
    2, // XS_CODE_ARGUMENTS_SLOPPY
    2, // XS_CODE_ARGUMENTS_STRICT
    1, // XS_CODE_ARRAY
    0, // XS_CODE_ASYNC_FUNCTION
    0, // XS_CODE_ASYNC_GENERATOR_FUNCTION
    1, // XS_CODE_AT
    1, // XS_CODE_AWAIT
    2, // XS_CODE_BEGIN_SLOPPY
    2, // XS_CODE_BEGIN_STRICT
    2, // XS_CODE_BEGIN_STRICT_BASE
    2, // XS_CODE_BEGIN_STRICT_DERIVED
    2, // XS_CODE_BEGIN_STRICT_FIELD
    -1, // XS_CODE_BIGINT_1
    -2, // XS_CODE_BIGINT_2
    1, // XS_CODE_BIT_AND
    1, // XS_CODE_BIT_NOT
    1, // XS_CODE_BIT_OR
    1, // XS_CODE_BIT_XOR
    2, // XS_CODE_BRANCH_1
    3, // XS_CODE_BRANCH_2
    5, // XS_CODE_BRANCH_4
    2, // XS_CODE_BRANCH_CHAIN_1
    3, // XS_CODE_BRANCH_CHAIN_2
    5, // XS_CODE_BRANCH_CHAIN_4
    2, // XS_CODE_BRANCH_COALESCE_1
    3, // XS_CODE_BRANCH_COALESCE_2
    5, // XS_CODE_BRANCH_COALESCE_4
    2, // XS_CODE_BRANCH_ELSE_1
    3, // XS_CODE_BRANCH_ELSE_2
    5, // XS_CODE_BRANCH_ELSE_4
    2, // XS_CODE_BRANCH_IF_1
    3, // XS_CODE_BRANCH_IF_2
    5, // XS_CODE_BRANCH_IF_4
    2, // XS_CODE_BRANCH_STATUS_1
    3, // XS_CODE_BRANCH_STATUS_2
    5, // XS_CODE_BRANCH_STATUS_4
    1, // XS_CODE_CALL
    2, // XS_CODE_CATCH_1
    3, // XS_CODE_CATCH_2
    5, // XS_CODE_CATCH_4
    1, // XS_CODE_CHECK_INSTANCE
    1, // XS_CODE_CLASS
    2, // XS_CODE_CODE_1
    3, // XS_CODE_CODE_2
    5, // XS_CODE_CODE_4
    2, // XS_CODE_CODE_ARCHIVE_1
    3, // XS_CODE_CODE_ARCHIVE_2
    5, // XS_CODE_CODE_ARCHIVE_4
    2, // XS_CODE_CONST_CLOSURE_1
    3, // XS_CODE_CONST_CLOSURE_2
    2, // XS_CODE_CONST_LOCAL_1
    3, // XS_CODE_CONST_LOCAL_2
    0, // XS_CODE_CONSTRUCTOR_FUNCTION
    1, // XS_CODE_COPY_OBJECT
    1, // XS_CODE_CURRENT
    1, // XS_CODE_DEBUGGER
    1, // XS_CODE_DECREMENT
    0, // XS_CODE_DELETE_PROPERTY
    1, // XS_CODE_DELETE_PROPERTY_AT
    0, // XS_CODE_DELETE_SUPER
    1, // XS_CODE_DELETE_SUPER_AT
    1, // XS_CODE_DIVIDE
    1, // XS_CODE_DUB
    1, // XS_CODE_DUB_AT
    1, // XS_CODE_END
    1, // XS_CODE_END_ARROW
    1, // XS_CODE_END_BASE
    1, // XS_CODE_END_DERIVED
    1, // XS_CODE_ENVIRONMENT
    1, // XS_CODE_EQUAL
    1, // XS_CODE_EVAL
    1, // XS_CODE_EVAL_ENVIRONMENT
    0, // XS_CODE_EVAL_PRIVATE
    0, // XS_CODE_EVAL_REFERENCE
    1, // XS_CODE_EVAL_TAIL
    1, // XS_CODE_EXCEPTION
    1, // XS_CODE_EXPONENTIATION
    1, // XS_CODE_EXTEND
    1, // XS_CODE_FALSE
    0, // XS_CODE_FILE
    1, // XS_CODE_FOR_AWAIT_OF
    1, // XS_CODE_FOR_IN
    1, // XS_CODE_FOR_OF
    0, // XS_CODE_FUNCTION
    1, // XS_CODE_FUNCTION_ENVIRONMENT
    0, // XS_CODE_GENERATOR_FUNCTION
    2, // XS_CODE_GET_CLOSURE_1
    3, // XS_CODE_GET_CLOSURE_2
    2, // XS_CODE_GET_LOCAL_1
    3, // XS_CODE_GET_LOCAL_2
    2, // XS_CODE_GET_PRIVATE_1
    3, // XS_CODE_GET_PRIVATE_2
    0, // XS_CODE_GET_PROPERTY
    1, // XS_CODE_GET_PROPERTY_AT
    1, // XS_CODE_GET_RESULT
    0, // XS_CODE_GET_SUPER
    1, // XS_CODE_GET_SUPER_AT
    1, // XS_CODE_GET_THIS
    0, // XS_CODE_GET_THIS_VARIABLE
    0, // XS_CODE_GET_VARIABLE
    1, // XS_CODE_GLOBAL
    2, // XS_CODE_HAS_PRIVATE_1
    3, // XS_CODE_HAS_PRIVATE_2
    3, // XS_CODE_HOST
    1, // XS_CODE_IMPORT
    1, // XS_CODE_IMPORT_META
    1, // XS_CODE_IN
    1, // XS_CODE_INCREMENT
    1, // XS_CODE_INSTANCEOF
    1, // XS_CODE_INSTANTIATE
    2, // XS_CODE_INTEGER_1
    3, // XS_CODE_INTEGER_2
    5, // XS_CODE_INTEGER_4
    1, // XS_CODE_LEFT_SHIFT
    1, // XS_CODE_LESS
    1, // XS_CODE_LESS_EQUAL
    2, // XS_CODE_LET_CLOSURE_1
    3, // XS_CODE_LET_CLOSURE_2
    2, // XS_CODE_LET_LOCAL_1
    3, // XS_CODE_LET_LOCAL_2
    3, // XS_CODE_LINE
    1, // XS_CODE_MINUS
    2, // XS_CODE_MODULE
    1, // XS_CODE_MODULO
    1, // XS_CODE_MORE
    1, // XS_CODE_MORE_EQUAL
    1, // XS_CODE_MULTIPLY
    0, // XS_CODE_NAME
    1, // XS_CODE_NEW
    0, // XS_CODE_NEW_CLOSURE
    0, // XS_CODE_NEW_LOCAL
    2, // XS_CODE_NEW_PRIVATE_1
    3, // XS_CODE_NEW_PRIVATE_2
    0, // XS_CODE_NEW_PROPERTY
    1, // XS_CODE_NEW_PROPERTY_AT
    1, // XS_CODE_NEW_TEMPORARY
    1, // XS_CODE_NOT
    1, // XS_CODE_NOT_EQUAL
    1, // XS_CODE_NULL
    9, // XS_CODE_NUMBER
    1, // XS_CODE_OBJECT
    1, // XS_CODE_PLUS
    1, // XS_CODE_POP
    1, // XS_CODE_PROGRAM_ENVIRONMENT
    0, // XS_CODE_PROGRAM_REFERENCE
    2, // XS_CODE_PULL_CLOSURE_1
    3, // XS_CODE_PULL_CLOSURE_2
    2, // XS_CODE_PULL_LOCAL_1
    3, // XS_CODE_PULL_LOCAL_2
    2, // XS_CODE_REFRESH_CLOSURE_1
    3, // XS_CODE_REFRESH_CLOSURE_2
    2, // XS_CODE_REFRESH_LOCAL_1
    3, // XS_CODE_REFRESH_LOCAL_2
    1, // XS_CODE_REGEXP
    2, // XS_CODE_RESERVE_1
    3, // XS_CODE_RESERVE_2
    2, // XS_CODE_RESET_CLOSURE_1
    3, // XS_CODE_RESET_CLOSURE_2
    2, // XS_CODE_RESET_LOCAL_1
    3, // XS_CODE_RESET_LOCAL_2
    1, // XS_CODE_RETHROW
    2, // XS_CODE_RETRIEVE_1
    3, // XS_CODE_RETRIEVE_2
    1, // XS_CODE_RETRIEVE_TARGET
    1, // XS_CODE_RETRIEVE_THIS
    1, // XS_CODE_RETURN
    1, // XS_CODE_RUN
    2, // XS_CODE_RUN_1
    3, // XS_CODE_RUN_2
    5, // XS_CODE_RUN_4
    1, // XS_CODE_RUN_TAIL
    2, // XS_CODE_RUN_TAIL_1
    3, // XS_CODE_RUN_TAIL_2
    5, // XS_CODE_RUN_TAIL_4
    2, // XS_CODE_SET_CLOSURE_1
    3, // XS_CODE_SET_CLOSURE_2
    1, // XS_CODE_SET_HOME
    2, // XS_CODE_SET_LOCAL_1
    3, // XS_CODE_SET_LOCAL_2
    2, // XS_CODE_SET_PRIVATE_1
    3, // XS_CODE_SET_PRIVATE_2
    0, // XS_CODE_SET_PROPERTY
    1, // XS_CODE_SET_PROPERTY_AT
    1, // XS_CODE_SET_RESULT
    0, // XS_CODE_SET_SUPER
    1, // XS_CODE_SET_SUPER_AT
    1, // XS_CODE_SET_THIS
    0, // XS_CODE_SET_VARIABLE
    1, // XS_CODE_SIGNED_RIGHT_SHIFT
    1, // XS_CODE_START_ASYNC
    1, // XS_CODE_START_ASYNC_GENERATOR
    1, // XS_CODE_START_GENERATOR
    2, // XS_CODE_STORE_1
    3, // XS_CODE_STORE_2
    1, // XS_CODE_STORE_ARROW
    1, // XS_CODE_STRICT_EQUAL
    1, // XS_CODE_STRICT_NOT_EQUAL
    -1, // XS_CODE_STRING_1
    -2, // XS_CODE_STRING_2
    -4, // XS_CODE_STRING_4
    -1, // XS_CODE_STRING_ARCHIVE_1
    -2, // XS_CODE_STRING_ARCHIVE_2
    -4, // XS_CODE_STRING_ARCHIVE_4
    1, // XS_CODE_SUBTRACT
    1, // XS_CODE_SUPER
    1, // XS_CODE_SWAP
    0, // XS_CODE_SYMBOL
    1, // XS_CODE_TARGET
    1, // XS_CODE_TEMPLATE
    1, // XS_CODE_TEMPLATE_CACHE
    1, // XS_CODE_THIS
    1, // XS_CODE_THROW
    1, // XS_CODE_THROW_STATUS
    1, // XS_CODE_TO_INSTANCE
    1, // XS_CODE_TO_NUMERIC
    1, // XS_CODE_TO_STRING
    1, // XS_CODE_TRANSFER
    1, // XS_CODE_TRUE
    1, // XS_CODE_TYPEOF
    1, // XS_CODE_UNCATCH
    1, // XS_CODE_UNDEFINED
    1, // XS_CODE_UNSIGNED_RIGHT_SHIFT
    2, // XS_CODE_UNWIND_1
    3, // XS_CODE_UNWIND_2
    2, // XS_CODE_VAR_CLOSURE_1
    3, // XS_CODE_VAR_CLOSURE_2
    2, // XS_CODE_VAR_LOCAL_1
    3, // XS_CODE_VAR_LOCAL_2
    1, // XS_CODE_VOID
    1, // XS_CODE_WITH
    1, // XS_CODE_WITHOUT
    1, // XS_CODE_YIELD
    // XS_CODE_PROFILE is ID-SHAPED but deliberately NOT id-mapped, so it
    // keeps a POSITIVE size rather than the `0` sentinel. XS writes the
    // entry longhand under `#ifdef mx32bitID` (`5` with 4-byte IDs, `3`
    // without) — `xsCommon.c` — and this is a 2-byte-ID build, so `3` is
    // the right value; the `5` that stood here was the 32-bit branch
    // transcribed into a 16-bit build (review wave 4, G2-d).
    //
    // The `0` sentinel would be equally wrong, in the other direction:
    // `fxMapperMapIDs` (`xsAPI.c`) keys the symbol remap on `0 == offset`
    // and handles PROFILE inside the `0 < offset` branch, where it mints
    // a FRESH profile id via `fxGenerateProfileID` instead of mapping the
    // operand. PROFILE's operand is a profiling counter, not a
    // symbol-table position, so it must stay out of `remap_ids` (review
    // wave 5). Inert today either way — the coder never emits PROFILE.
    3, // XS_CODE_PROFILE
    1, // XS_CODE_YIELD_STAR
    2, // XS_CODE_USED_1
    3, // XS_CODE_USED_2
    1, // XS_CODE_USING
    1, // XS_CODE_USING_ASYNC
    1, // XS_CODE_AT_2
    1, // XS_CODE_SUPER_AT
    1, // XS_CODE_SUPER_AT_2
    1, // XS_CODE_TRANSFER_JSON
];

/// Lowercase mnemonic, indexed by opcode byte (from gxCodeNames).
pub static CODE_NAMES: [&str; XS_CODE_COUNT] = [
    "", // XS_NO_CODE
    "add", // XS_CODE_ADD
    "argument", // XS_CODE_ARGUMENT
    "arguments", // XS_CODE_ARGUMENTS
    "arguments_sloppy", // XS_CODE_ARGUMENTS_SLOPPY
    "arguments_strict", // XS_CODE_ARGUMENTS_STRICT
    "array", // XS_CODE_ARRAY
    "async_function", // XS_CODE_ASYNC_FUNCTION
    "async_generator_function", // XS_CODE_ASYNC_GENERATOR_FUNCTION
    "at", // XS_CODE_AT
    "await", // XS_CODE_AWAIT
    "begin_sloppy", // XS_CODE_BEGIN_SLOPPY
    "begin_strict", // XS_CODE_BEGIN_STRICT
    "begin_strict_base", // XS_CODE_BEGIN_STRICT_BASE
    "begin_strict_derived", // XS_CODE_BEGIN_STRICT_DERIVED
    "begin_strict_field", // XS_CODE_BEGIN_STRICT_FIELD
    "bigint", // XS_CODE_BIGINT_1
    "bigint_2", // XS_CODE_BIGINT_2
    "bit_and", // XS_CODE_BIT_AND
    "bit_not", // XS_CODE_BIT_NOT
    "bit_or", // XS_CODE_BIT_OR
    "bit_xor", // XS_CODE_BIT_XOR
    "branch", // XS_CODE_BRANCH_1
    "branch_2", // XS_CODE_BRANCH_2
    "branch_4", // XS_CODE_BRANCH_4
    "branch_chain", // XS_CODE_BRANCH_CHAIN_1
    "branch_chain_2", // XS_CODE_BRANCH_CHAIN_2
    "branch_chain_4", // XS_CODE_BRANCH_CHAIN_4
    "branch_coalesce", // XS_CODE_BRANCH_COALESCE_1
    "branch_coalesce_2", // XS_CODE_BRANCH_COALESCE_2
    "branch_coalesce_4", // XS_CODE_BRANCH_COALESCE_4
    "branch_else", // XS_CODE_BRANCH_ELSE_1
    "branch_else_2", // XS_CODE_BRANCH_ELSE_2
    "branch_else_4", // XS_CODE_BRANCH_ELSE_4
    "branch_if", // XS_CODE_BRANCH_IF_1
    "branch_if_2", // XS_CODE_BRANCH_IF_2
    "branch_if_4", // XS_CODE_BRANCH_IF_4
    "branch_status", // XS_CODE_BRANCH_STATUS_1
    "branch_status_2", // XS_CODE_BRANCH_STATUS_2
    "branch_status_4", // XS_CODE_BRANCH_STATUS_4
    "call", // XS_CODE_CALL
    "catch", // XS_CODE_CATCH_1
    "catch_2", // XS_CODE_CATCH_2
    "catch_4", // XS_CODE_CATCH_4
    "check_instance", // XS_CODE_CHECK_INSTANCE
    "class", // XS_CODE_CLASS
    "code", // XS_CODE_CODE_1
    "code_2", // XS_CODE_CODE_2
    "code_4", // XS_CODE_CODE_4
    "code_archive", // XS_CODE_CODE_ARCHIVE_1
    "code_archive_2", // XS_CODE_CODE_ARCHIVE_2
    "code_archive_4", // XS_CODE_CODE_ARCHIVE_4
    "const_closure", // XS_CODE_CONST_CLOSURE_1
    "const_closure_2", // XS_CODE_CONST_CLOSURE_2
    "const_local", // XS_CODE_CONST_LOCAL_1
    "const_local_2", // XS_CODE_CONST_LOCAL_2
    "constructor_function", // XS_CODE_CONSTRUCTOR_FUNCTION
    "copy_object", // XS_CODE_COPY_OBJECT
    "current", // XS_CODE_CURRENT
    "debugger", // XS_CODE_DEBUGGER
    "decrement", // XS_CODE_DECREMENT
    "delete_property", // XS_CODE_DELETE_PROPERTY
    "delete_property_at", // XS_CODE_DELETE_PROPERTY_AT
    "delete_super", // XS_CODE_DELETE_SUPER
    "delete_super_at", // XS_CODE_DELETE_SUPER_AT
    "divide", // XS_CODE_DIVIDE
    "dub", // XS_CODE_DUB
    "dub_at", // XS_CODE_DUB_AT
    "end", // XS_CODE_END
    "end_arrow", // XS_CODE_END_ARROW
    "end_base", // XS_CODE_END_BASE
    "end_derived", // XS_CODE_END_DERIVED
    "environment", // XS_CODE_ENVIRONMENT
    "equal", // XS_CODE_EQUAL
    "eval", // XS_CODE_EVAL
    "eval_environment", // XS_CODE_EVAL_ENVIRONMENT
    "eval_private", // XS_CODE_EVAL_PRIVATE
    "eval_reference", // XS_CODE_EVAL_REFERENCE
    "eval_tail", // XS_CODE_EVAL_TAIL
    "exception", // XS_CODE_EXCEPTION
    "exponentiation", // XS_CODE_EXPONENTIATION
    "extend", // XS_CODE_EXTEND
    "false", // XS_CODE_FALSE
    "file", // XS_CODE_FILE
    "for_await_of", // XS_CODE_FOR_AWAIT_OF
    "for_in", // XS_CODE_FOR_IN
    "for_of", // XS_CODE_FOR_OF
    "function", // XS_CODE_FUNCTION
    "function_environment", // XS_CODE_FUNCTION_ENVIRONMENT
    "generator", // XS_CODE_GENERATOR_FUNCTION
    "get_closure", // XS_CODE_GET_CLOSURE_1
    "get_closure_2", // XS_CODE_GET_CLOSURE_2
    "get_local", // XS_CODE_GET_LOCAL_1
    "get_local_2", // XS_CODE_GET_LOCAL_2
    "get_private", // XS_CODE_GET_PRIVATE_1
    "get_private_2", // XS_CODE_GET_PRIVATE_2
    "get_property", // XS_CODE_GET_PROPERTY
    "get_property_at", // XS_CODE_GET_PROPERTY_AT
    "get_result", // XS_CODE_GET_RESULT
    "get_super", // XS_CODE_GET_SUPER
    "get_super_at", // XS_CODE_GET_SUPER_AT
    "get_this", // XS_CODE_GET_THIS
    "get_this_variable", // XS_CODE_GET_THIS_VARIABLE
    "get_variable", // XS_CODE_GET_VARIABLE
    "global", // XS_CODE_GLOBAL
    "has_private", // XS_CODE_HAS_PRIVATE_1
    "has_private_2", // XS_CODE_HAS_PRIVATE_2
    "host", // XS_CODE_HOST
    "import", // XS_CODE_IMPORT
    "import.meta", // XS_CODE_IMPORT_META
    "in", // XS_CODE_IN
    "increment", // XS_CODE_INCREMENT
    "instanceof", // XS_CODE_INSTANCEOF
    "instantiate", // XS_CODE_INSTANTIATE
    "integer", // XS_CODE_INTEGER_1
    "integer_2", // XS_CODE_INTEGER_2
    "integer_4", // XS_CODE_INTEGER_4
    "left_shift", // XS_CODE_LEFT_SHIFT
    "less", // XS_CODE_LESS
    "less_equal", // XS_CODE_LESS_EQUAL
    "let_closure", // XS_CODE_LET_CLOSURE_1
    "let_closure_2", // XS_CODE_LET_CLOSURE_2
    "let_local", // XS_CODE_LET_LOCAL_1
    "let_local_2", // XS_CODE_LET_LOCAL_2
    "line", // XS_CODE_LINE
    "minus", // XS_CODE_MINUS
    "module", // XS_CODE_MODULE
    "modulo", // XS_CODE_MODULO
    "more", // XS_CODE_MORE
    "more_equal", // XS_CODE_MORE_EQUAL
    "multiply", // XS_CODE_MULTIPLY
    "name", // XS_CODE_NAME
    "new", // XS_CODE_NEW
    "new_closure", // XS_CODE_NEW_CLOSURE
    "new_local", // XS_CODE_NEW_LOCAL
    "new_private", // XS_CODE_NEW_PRIVATE_1
    "new_private_2", // XS_CODE_NEW_PRIVATE_2
    "new_property", // XS_CODE_NEW_PROPERTY
    "new_property_at", // XS_CODE_NEW_PROPERTY_AT
    "new_temporary", // XS_CODE_NEW_TEMPORARY
    "not", // XS_CODE_NOT
    "not_equal", // XS_CODE_NOT_EQUAL
    "null", // XS_CODE_NULL
    "number", // XS_CODE_NUMBER
    "object", // XS_CODE_OBJECT
    "plus", // XS_CODE_PLUS
    "pop", // XS_CODE_POP
    "program_environment", // XS_CODE_PROGRAM_ENVIRONMENT
    "program_reference", // XS_CODE_PROGRAM_REFERENCE
    "pull_closure", // XS_CODE_PULL_CLOSURE_1
    "pull_closure_2", // XS_CODE_PULL_CLOSURE_2
    "pull_local", // XS_CODE_PULL_LOCAL_1
    "pull_local_2", // XS_CODE_PULL_LOCAL_2
    "refresh_closure", // XS_CODE_REFRESH_CLOSURE_1
    "refresh_closure_2", // XS_CODE_REFRESH_CLOSURE_2
    "refresh_local", // XS_CODE_REFRESH_LOCAL_1
    "refresh_local_2", // XS_CODE_REFRESH_LOCAL_2
    "regexp", // XS_CODE_REGEXP
    "reserve", // XS_CODE_RESERVE_1
    "reserve_2", // XS_CODE_RESERVE_2
    "reset_closure", // XS_CODE_RESET_CLOSURE_1
    "reset_closure_2", // XS_CODE_RESET_CLOSURE_2
    "reset_local", // XS_CODE_RESET_LOCAL_1
    "reset_local_2", // XS_CODE_RESET_LOCAL_2
    "rethrow", // XS_CODE_RETHROW
    "retrieve", // XS_CODE_RETRIEVE_1
    "retrieve_2", // XS_CODE_RETRIEVE_2
    "retrieve_target", // XS_CODE_RETRIEVE_TARGET
    "retrieve_this", // XS_CODE_RETRIEVE_THIS
    "return", // XS_CODE_RETURN
    "run", // XS_CODE_RUN
    "run_1", // XS_CODE_RUN_1
    "run_2", // XS_CODE_RUN_2
    "run_4", // XS_CODE_RUN_4
    "run_tail", // XS_CODE_RUN_TAIL
    "run_tail_1", // XS_CODE_RUN_TAIL_1
    "run_tail_2", // XS_CODE_RUN_TAIL_2
    "run_tail_4", // XS_CODE_RUN_TAIL_4
    "set_closure", // XS_CODE_SET_CLOSURE_1
    "set_closure_2", // XS_CODE_SET_CLOSURE_2
    "set_home", // XS_CODE_SET_HOME
    "set_local", // XS_CODE_SET_LOCAL_1
    "set_local_2", // XS_CODE_SET_LOCAL_2
    "set_private", // XS_CODE_SET_PRIVATE_1
    "set_private_2", // XS_CODE_SET_PRIVATE_2
    "set_property", // XS_CODE_SET_PROPERTY
    "set_property_at", // XS_CODE_SET_PROPERTY_AT
    "set_result", // XS_CODE_SET_RESULT
    "set_super", // XS_CODE_SET_SUPER
    "set_super_at", // XS_CODE_SET_SUPER_AT
    "set_this", // XS_CODE_SET_THIS
    "set_variable", // XS_CODE_SET_VARIABLE
    "signed_right_shift", // XS_CODE_SIGNED_RIGHT_SHIFT
    "start_async", // XS_CODE_START_ASYNC
    "start_async_generator", // XS_CODE_START_ASYNC_GENERATOR
    "start_generator", // XS_CODE_START_GENERATOR
    "store_1", // XS_CODE_STORE_1
    "store_2", // XS_CODE_STORE_2
    "store_arrow", // XS_CODE_STORE_ARROW
    "strict_equal", // XS_CODE_STRICT_EQUAL
    "strict_not_equal", // XS_CODE_STRICT_NOT_EQUAL
    "string", // XS_CODE_STRING_1
    "string_2", // XS_CODE_STRING_2
    "string_4", // XS_CODE_STRING_4
    "string_archive", // XS_CODE_STRING_ARCHIVE_1
    "string_archive_2", // XS_CODE_STRING_ARCHIVE_2
    "string_archive_4", // XS_CODE_STRING_ARCHIVE_4
    "subtract", // XS_CODE_SUBTRACT
    "super", // XS_CODE_SUPER
    "swap", // XS_CODE_SWAP
    "symbol", // XS_CODE_SYMBOL
    "target", // XS_CODE_TARGET
    "template", // XS_CODE_TEMPLATE
    "template_cache", // XS_CODE_TEMPLATE_CACHE
    "this", // XS_CODE_THIS
    "throw", // XS_CODE_THROW
    "throw_status", // XS_CODE_THROW_STATUS
    "to_instance", // XS_CODE_TO_INSTANCE
    "to_numeric", // XS_CODE_TO_NUMERIC
    "to_string", // XS_CODE_TO_STRING
    "transfer", // XS_CODE_TRANSFER
    "true", // XS_CODE_TRUE
    "typeof", // XS_CODE_TYPEOF
    "uncatch", // XS_CODE_UNCATCH
    "undefined", // XS_CODE_UNDEFINED
    "unsigned_right_shift", // XS_CODE_UNSIGNED_RIGHT_SHIFT
    "unwind", // XS_CODE_UNWIND_1
    "unwind_2", // XS_CODE_UNWIND_2
    "var_closure_1", // XS_CODE_VAR_CLOSURE_1
    "var_closure_2", // XS_CODE_VAR_CLOSURE_2
    "var_local_1", // XS_CODE_VAR_LOCAL_1
    "var_local_2", // XS_CODE_VAR_LOCAL_2
    "void", // XS_CODE_VOID
    "with", // XS_CODE_WITH
    "without", // XS_CODE_WITHOUT
    "yield", // XS_CODE_YIELD
    "profile", // XS_CODE_PROFILE
    "yield*", // XS_CODE_YIELD_STAR
    "used_1", // XS_CODE_USED_1
    "used_2", // XS_CODE_USED_2
    "using", // XS_CODE_USING
    "await using", // XS_CODE_USING_ASYNC
    "at_2", // XS_CODE_AT_2
    "super_at", // XS_CODE_SUPER_AT
    "super_at_2", // XS_CODE_SUPER_AT_2
    "transfer_json", // XS_CODE_TRANSFER_JSON
];

impl Opcode {
    /// Decode an opcode byte. `None` for a byte outside the known
    /// XS_CODE_* range (corrupt or truncated stream).
    #[inline]
    pub fn from_u8(byte: u8) -> Option<Opcode> {
        Some(match byte {
            0 => Opcode::XS_NO_CODE,
            1 => Opcode::XS_CODE_ADD,
            2 => Opcode::XS_CODE_ARGUMENT,
            3 => Opcode::XS_CODE_ARGUMENTS,
            4 => Opcode::XS_CODE_ARGUMENTS_SLOPPY,
            5 => Opcode::XS_CODE_ARGUMENTS_STRICT,
            6 => Opcode::XS_CODE_ARRAY,
            7 => Opcode::XS_CODE_ASYNC_FUNCTION,
            8 => Opcode::XS_CODE_ASYNC_GENERATOR_FUNCTION,
            9 => Opcode::XS_CODE_AT,
            10 => Opcode::XS_CODE_AWAIT,
            11 => Opcode::XS_CODE_BEGIN_SLOPPY,
            12 => Opcode::XS_CODE_BEGIN_STRICT,
            13 => Opcode::XS_CODE_BEGIN_STRICT_BASE,
            14 => Opcode::XS_CODE_BEGIN_STRICT_DERIVED,
            15 => Opcode::XS_CODE_BEGIN_STRICT_FIELD,
            16 => Opcode::XS_CODE_BIGINT_1,
            17 => Opcode::XS_CODE_BIGINT_2,
            18 => Opcode::XS_CODE_BIT_AND,
            19 => Opcode::XS_CODE_BIT_NOT,
            20 => Opcode::XS_CODE_BIT_OR,
            21 => Opcode::XS_CODE_BIT_XOR,
            22 => Opcode::XS_CODE_BRANCH_1,
            23 => Opcode::XS_CODE_BRANCH_2,
            24 => Opcode::XS_CODE_BRANCH_4,
            25 => Opcode::XS_CODE_BRANCH_CHAIN_1,
            26 => Opcode::XS_CODE_BRANCH_CHAIN_2,
            27 => Opcode::XS_CODE_BRANCH_CHAIN_4,
            28 => Opcode::XS_CODE_BRANCH_COALESCE_1,
            29 => Opcode::XS_CODE_BRANCH_COALESCE_2,
            30 => Opcode::XS_CODE_BRANCH_COALESCE_4,
            31 => Opcode::XS_CODE_BRANCH_ELSE_1,
            32 => Opcode::XS_CODE_BRANCH_ELSE_2,
            33 => Opcode::XS_CODE_BRANCH_ELSE_4,
            34 => Opcode::XS_CODE_BRANCH_IF_1,
            35 => Opcode::XS_CODE_BRANCH_IF_2,
            36 => Opcode::XS_CODE_BRANCH_IF_4,
            37 => Opcode::XS_CODE_BRANCH_STATUS_1,
            38 => Opcode::XS_CODE_BRANCH_STATUS_2,
            39 => Opcode::XS_CODE_BRANCH_STATUS_4,
            40 => Opcode::XS_CODE_CALL,
            41 => Opcode::XS_CODE_CATCH_1,
            42 => Opcode::XS_CODE_CATCH_2,
            43 => Opcode::XS_CODE_CATCH_4,
            44 => Opcode::XS_CODE_CHECK_INSTANCE,
            45 => Opcode::XS_CODE_CLASS,
            46 => Opcode::XS_CODE_CODE_1,
            47 => Opcode::XS_CODE_CODE_2,
            48 => Opcode::XS_CODE_CODE_4,
            49 => Opcode::XS_CODE_CODE_ARCHIVE_1,
            50 => Opcode::XS_CODE_CODE_ARCHIVE_2,
            51 => Opcode::XS_CODE_CODE_ARCHIVE_4,
            52 => Opcode::XS_CODE_CONST_CLOSURE_1,
            53 => Opcode::XS_CODE_CONST_CLOSURE_2,
            54 => Opcode::XS_CODE_CONST_LOCAL_1,
            55 => Opcode::XS_CODE_CONST_LOCAL_2,
            56 => Opcode::XS_CODE_CONSTRUCTOR_FUNCTION,
            57 => Opcode::XS_CODE_COPY_OBJECT,
            58 => Opcode::XS_CODE_CURRENT,
            59 => Opcode::XS_CODE_DEBUGGER,
            60 => Opcode::XS_CODE_DECREMENT,
            61 => Opcode::XS_CODE_DELETE_PROPERTY,
            62 => Opcode::XS_CODE_DELETE_PROPERTY_AT,
            63 => Opcode::XS_CODE_DELETE_SUPER,
            64 => Opcode::XS_CODE_DELETE_SUPER_AT,
            65 => Opcode::XS_CODE_DIVIDE,
            66 => Opcode::XS_CODE_DUB,
            67 => Opcode::XS_CODE_DUB_AT,
            68 => Opcode::XS_CODE_END,
            69 => Opcode::XS_CODE_END_ARROW,
            70 => Opcode::XS_CODE_END_BASE,
            71 => Opcode::XS_CODE_END_DERIVED,
            72 => Opcode::XS_CODE_ENVIRONMENT,
            73 => Opcode::XS_CODE_EQUAL,
            74 => Opcode::XS_CODE_EVAL,
            75 => Opcode::XS_CODE_EVAL_ENVIRONMENT,
            76 => Opcode::XS_CODE_EVAL_PRIVATE,
            77 => Opcode::XS_CODE_EVAL_REFERENCE,
            78 => Opcode::XS_CODE_EVAL_TAIL,
            79 => Opcode::XS_CODE_EXCEPTION,
            80 => Opcode::XS_CODE_EXPONENTIATION,
            81 => Opcode::XS_CODE_EXTEND,
            82 => Opcode::XS_CODE_FALSE,
            83 => Opcode::XS_CODE_FILE,
            84 => Opcode::XS_CODE_FOR_AWAIT_OF,
            85 => Opcode::XS_CODE_FOR_IN,
            86 => Opcode::XS_CODE_FOR_OF,
            87 => Opcode::XS_CODE_FUNCTION,
            88 => Opcode::XS_CODE_FUNCTION_ENVIRONMENT,
            89 => Opcode::XS_CODE_GENERATOR_FUNCTION,
            90 => Opcode::XS_CODE_GET_CLOSURE_1,
            91 => Opcode::XS_CODE_GET_CLOSURE_2,
            92 => Opcode::XS_CODE_GET_LOCAL_1,
            93 => Opcode::XS_CODE_GET_LOCAL_2,
            94 => Opcode::XS_CODE_GET_PRIVATE_1,
            95 => Opcode::XS_CODE_GET_PRIVATE_2,
            96 => Opcode::XS_CODE_GET_PROPERTY,
            97 => Opcode::XS_CODE_GET_PROPERTY_AT,
            98 => Opcode::XS_CODE_GET_RESULT,
            99 => Opcode::XS_CODE_GET_SUPER,
            100 => Opcode::XS_CODE_GET_SUPER_AT,
            101 => Opcode::XS_CODE_GET_THIS,
            102 => Opcode::XS_CODE_GET_THIS_VARIABLE,
            103 => Opcode::XS_CODE_GET_VARIABLE,
            104 => Opcode::XS_CODE_GLOBAL,
            105 => Opcode::XS_CODE_HAS_PRIVATE_1,
            106 => Opcode::XS_CODE_HAS_PRIVATE_2,
            107 => Opcode::XS_CODE_HOST,
            108 => Opcode::XS_CODE_IMPORT,
            109 => Opcode::XS_CODE_IMPORT_META,
            110 => Opcode::XS_CODE_IN,
            111 => Opcode::XS_CODE_INCREMENT,
            112 => Opcode::XS_CODE_INSTANCEOF,
            113 => Opcode::XS_CODE_INSTANTIATE,
            114 => Opcode::XS_CODE_INTEGER_1,
            115 => Opcode::XS_CODE_INTEGER_2,
            116 => Opcode::XS_CODE_INTEGER_4,
            117 => Opcode::XS_CODE_LEFT_SHIFT,
            118 => Opcode::XS_CODE_LESS,
            119 => Opcode::XS_CODE_LESS_EQUAL,
            120 => Opcode::XS_CODE_LET_CLOSURE_1,
            121 => Opcode::XS_CODE_LET_CLOSURE_2,
            122 => Opcode::XS_CODE_LET_LOCAL_1,
            123 => Opcode::XS_CODE_LET_LOCAL_2,
            124 => Opcode::XS_CODE_LINE,
            125 => Opcode::XS_CODE_MINUS,
            126 => Opcode::XS_CODE_MODULE,
            127 => Opcode::XS_CODE_MODULO,
            128 => Opcode::XS_CODE_MORE,
            129 => Opcode::XS_CODE_MORE_EQUAL,
            130 => Opcode::XS_CODE_MULTIPLY,
            131 => Opcode::XS_CODE_NAME,
            132 => Opcode::XS_CODE_NEW,
            133 => Opcode::XS_CODE_NEW_CLOSURE,
            134 => Opcode::XS_CODE_NEW_LOCAL,
            135 => Opcode::XS_CODE_NEW_PRIVATE_1,
            136 => Opcode::XS_CODE_NEW_PRIVATE_2,
            137 => Opcode::XS_CODE_NEW_PROPERTY,
            138 => Opcode::XS_CODE_NEW_PROPERTY_AT,
            139 => Opcode::XS_CODE_NEW_TEMPORARY,
            140 => Opcode::XS_CODE_NOT,
            141 => Opcode::XS_CODE_NOT_EQUAL,
            142 => Opcode::XS_CODE_NULL,
            143 => Opcode::XS_CODE_NUMBER,
            144 => Opcode::XS_CODE_OBJECT,
            145 => Opcode::XS_CODE_PLUS,
            146 => Opcode::XS_CODE_POP,
            147 => Opcode::XS_CODE_PROGRAM_ENVIRONMENT,
            148 => Opcode::XS_CODE_PROGRAM_REFERENCE,
            149 => Opcode::XS_CODE_PULL_CLOSURE_1,
            150 => Opcode::XS_CODE_PULL_CLOSURE_2,
            151 => Opcode::XS_CODE_PULL_LOCAL_1,
            152 => Opcode::XS_CODE_PULL_LOCAL_2,
            153 => Opcode::XS_CODE_REFRESH_CLOSURE_1,
            154 => Opcode::XS_CODE_REFRESH_CLOSURE_2,
            155 => Opcode::XS_CODE_REFRESH_LOCAL_1,
            156 => Opcode::XS_CODE_REFRESH_LOCAL_2,
            157 => Opcode::XS_CODE_REGEXP,
            158 => Opcode::XS_CODE_RESERVE_1,
            159 => Opcode::XS_CODE_RESERVE_2,
            160 => Opcode::XS_CODE_RESET_CLOSURE_1,
            161 => Opcode::XS_CODE_RESET_CLOSURE_2,
            162 => Opcode::XS_CODE_RESET_LOCAL_1,
            163 => Opcode::XS_CODE_RESET_LOCAL_2,
            164 => Opcode::XS_CODE_RETHROW,
            165 => Opcode::XS_CODE_RETRIEVE_1,
            166 => Opcode::XS_CODE_RETRIEVE_2,
            167 => Opcode::XS_CODE_RETRIEVE_TARGET,
            168 => Opcode::XS_CODE_RETRIEVE_THIS,
            169 => Opcode::XS_CODE_RETURN,
            170 => Opcode::XS_CODE_RUN,
            171 => Opcode::XS_CODE_RUN_1,
            172 => Opcode::XS_CODE_RUN_2,
            173 => Opcode::XS_CODE_RUN_4,
            174 => Opcode::XS_CODE_RUN_TAIL,
            175 => Opcode::XS_CODE_RUN_TAIL_1,
            176 => Opcode::XS_CODE_RUN_TAIL_2,
            177 => Opcode::XS_CODE_RUN_TAIL_4,
            178 => Opcode::XS_CODE_SET_CLOSURE_1,
            179 => Opcode::XS_CODE_SET_CLOSURE_2,
            180 => Opcode::XS_CODE_SET_HOME,
            181 => Opcode::XS_CODE_SET_LOCAL_1,
            182 => Opcode::XS_CODE_SET_LOCAL_2,
            183 => Opcode::XS_CODE_SET_PRIVATE_1,
            184 => Opcode::XS_CODE_SET_PRIVATE_2,
            185 => Opcode::XS_CODE_SET_PROPERTY,
            186 => Opcode::XS_CODE_SET_PROPERTY_AT,
            187 => Opcode::XS_CODE_SET_RESULT,
            188 => Opcode::XS_CODE_SET_SUPER,
            189 => Opcode::XS_CODE_SET_SUPER_AT,
            190 => Opcode::XS_CODE_SET_THIS,
            191 => Opcode::XS_CODE_SET_VARIABLE,
            192 => Opcode::XS_CODE_SIGNED_RIGHT_SHIFT,
            193 => Opcode::XS_CODE_START_ASYNC,
            194 => Opcode::XS_CODE_START_ASYNC_GENERATOR,
            195 => Opcode::XS_CODE_START_GENERATOR,
            196 => Opcode::XS_CODE_STORE_1,
            197 => Opcode::XS_CODE_STORE_2,
            198 => Opcode::XS_CODE_STORE_ARROW,
            199 => Opcode::XS_CODE_STRICT_EQUAL,
            200 => Opcode::XS_CODE_STRICT_NOT_EQUAL,
            201 => Opcode::XS_CODE_STRING_1,
            202 => Opcode::XS_CODE_STRING_2,
            203 => Opcode::XS_CODE_STRING_4,
            204 => Opcode::XS_CODE_STRING_ARCHIVE_1,
            205 => Opcode::XS_CODE_STRING_ARCHIVE_2,
            206 => Opcode::XS_CODE_STRING_ARCHIVE_4,
            207 => Opcode::XS_CODE_SUBTRACT,
            208 => Opcode::XS_CODE_SUPER,
            209 => Opcode::XS_CODE_SWAP,
            210 => Opcode::XS_CODE_SYMBOL,
            211 => Opcode::XS_CODE_TARGET,
            212 => Opcode::XS_CODE_TEMPLATE,
            213 => Opcode::XS_CODE_TEMPLATE_CACHE,
            214 => Opcode::XS_CODE_THIS,
            215 => Opcode::XS_CODE_THROW,
            216 => Opcode::XS_CODE_THROW_STATUS,
            217 => Opcode::XS_CODE_TO_INSTANCE,
            218 => Opcode::XS_CODE_TO_NUMERIC,
            219 => Opcode::XS_CODE_TO_STRING,
            220 => Opcode::XS_CODE_TRANSFER,
            221 => Opcode::XS_CODE_TRUE,
            222 => Opcode::XS_CODE_TYPEOF,
            223 => Opcode::XS_CODE_UNCATCH,
            224 => Opcode::XS_CODE_UNDEFINED,
            225 => Opcode::XS_CODE_UNSIGNED_RIGHT_SHIFT,
            226 => Opcode::XS_CODE_UNWIND_1,
            227 => Opcode::XS_CODE_UNWIND_2,
            228 => Opcode::XS_CODE_VAR_CLOSURE_1,
            229 => Opcode::XS_CODE_VAR_CLOSURE_2,
            230 => Opcode::XS_CODE_VAR_LOCAL_1,
            231 => Opcode::XS_CODE_VAR_LOCAL_2,
            232 => Opcode::XS_CODE_VOID,
            233 => Opcode::XS_CODE_WITH,
            234 => Opcode::XS_CODE_WITHOUT,
            235 => Opcode::XS_CODE_YIELD,
            236 => Opcode::XS_CODE_PROFILE,
            237 => Opcode::XS_CODE_YIELD_STAR,
            238 => Opcode::XS_CODE_USED_1,
            239 => Opcode::XS_CODE_USED_2,
            240 => Opcode::XS_CODE_USING,
            241 => Opcode::XS_CODE_USING_ASYNC,
            242 => Opcode::XS_CODE_AT_2,
            243 => Opcode::XS_CODE_SUPER_AT,
            244 => Opcode::XS_CODE_SUPER_AT_2,
            245 => Opcode::XS_CODE_TRANSFER_JSON,
            _ => return None,
        })
    }

    /// Raw `gxCodeSizes` entry. A positive value is the fixed
    /// instruction size; `0` marks an ID-operand opcode (size `1 +
    /// ID_SIZE`); a negative `-n` marks a length-prefixed variable
    /// opcode (`1 + n + payload`). Use [`Opcode::instruction_len`] to
    /// resolve the concrete length against a byte stream.
    #[inline]
    pub fn size(self) -> i8 { CODE_SIZES[self as usize] }

    /// Lowercase mnemonic from gxCodeNames, for disassembly.
    #[inline]
    pub fn name(self) -> &'static str { CODE_NAMES[self as usize] }
}

/// The width of an ID operand in the code stream. XS builds ironhorse with
/// 2-byte IDs (`mxRunID == mxRunS2`, no `mx32bitID`), so an ID-bearing
/// opcode (`gxCodeSizes == 0`) is `1 + ID_SIZE` = 3 bytes.
pub const ID_SIZE: usize = 2;

/// The concrete byte length of the instruction at `code[pc]`, resolving
/// the `gxCodeSizes` sentinels exactly as XS's `fxReadCode`
/// (`xsSnapshot.c`) walks the stream:
///
/// - `size > 0`: fixed length `size`.
/// - `size == 0`: `1 + ID_SIZE` (an ID operand).
/// - `size == -1`: `1 + 1 + code[pc+1]` (u8 length prefix, then bytes).
/// - `size == -2`: `1 + 2 + u16` (u16 LE length prefix, then bytes).
/// - `size == -4`: `1 + 4 + u32` (u32 LE length prefix, then bytes).
///
/// Returns `None` on an unknown opcode byte, a truncated length
/// prefix, or a TRUNCATED INSTRUCTION — one whose operands or declared
/// payload run past the end of the stream (wave-6 W6-22: the sentinel
/// arms used to size a truncated trailing payload "successfully", so
/// the relink walk accepted bytes the dispatch loop refuses; bounding
/// the whole instruction here makes every walker agree). Never
/// panicking — the bytecode-decoder fuzz target (design § Fuzzability,
/// target 2) relies on this.
pub fn instruction_len(code: &[u8], pc: usize) -> Option<usize> {
    let byte = *code.get(pc)?;
    let op = Opcode::from_u8(byte)?;
    let size = op.size();
    let len = if size > 0 {
        size as usize
    } else {
        match size {
            0 => 1 + ID_SIZE,
            -1 => {
                let n = *code.get(pc + 1)? as usize;
                2 + n
            }
            -2 => {
                let lo = *code.get(pc + 1)? as usize;
                let hi = *code.get(pc + 2)? as usize;
                3 + (lo | (hi << 8))
            }
            -4 => {
                let b0 = *code.get(pc + 1)? as usize;
                let b1 = *code.get(pc + 2)? as usize;
                let b2 = *code.get(pc + 3)? as usize;
                let b3 = *code.get(pc + 4)? as usize;
                5 + (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24))
            }
            // Every negative sentinel XS emits is -1/-2/-4; anything
            // else is an impossible table entry.
            _ => return None,
        }
    };
    // The whole instruction — operands and payload included — must lie
    // inside the stream; an instruction ending exactly at the end is
    // complete, one running past it is truncation.
    (pc.checked_add(len)? <= code.len()).then_some(len)
}

/// Rewrite every 2-byte little-endian ID operand through `map`,
/// walking the stream with [`instruction_len`] exactly as the
/// disassembler does (side-table ledger G2: the bytecode half of
/// per-crank relinking). `gxCodeSizes == 0` marks ID-bearing opcodes
/// — XS's own snapshot remap keys off the same table entry — so the
/// coverage cannot drift from the length walk. Nested function bodies
/// are covered: a `CODE_X` operand carries only the body LENGTH and
/// the body's instructions follow inline, so the walk enters them;
/// length-prefixed data payloads (strings, bigints, host names) are
/// skipped whole by their `-1/-2/-4` sentinels. Returns `None` on an
/// unknown opcode, a truncated instruction, or a `map` refusal — the
/// caller treats all three as "this bytecode cannot be relinked".
pub fn remap_ids(bytecode: &[u8], mut map: impl FnMut(u16) -> Option<u16>) -> Option<Vec<u8>> {
    let mut out = bytecode.to_vec();
    let mut pc = 0usize;
    while pc < out.len() {
        let op = Opcode::from_u8(out[pc])?;
        let len = instruction_len(&out, pc)?;
        if op.size() == 0 {
            if pc + 1 + ID_SIZE > out.len() {
                return None;
            }
            let id = u16::from_le_bytes([out[pc + 1], out[pc + 2]]);
            let new = map(id)?;
            out[pc + 1..pc + 1 + ID_SIZE].copy_from_slice(&new.to_le_bytes());
        }
        pc = pc.checked_add(len)?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every SYMBOL-operand opcode must carry the `0` sentinel, because
    /// that is what [`remap_ids`] keys on and what [`instruction_len`]
    /// resolves to `1 + ID_SIZE`. A concrete size on one of these is
    /// doubly wrong: the relink skips its operand AND mis-advances the
    /// scan, desynchronizing every instruction after it.
    ///
    /// The list is exactly XS's own `gxCodeSizes` ZERO entries, read off
    /// `xsCommon.c`. `XS_CODE_PROFILE` is deliberately NOT among them:
    /// it is ID-shaped but XS gives it a positive size (`3` in a
    /// 2-byte-ID build) precisely so the symbol remap skips it —
    /// `fxMapperMapIDs` handles it in the `0 < offset` branch and mints a
    /// fresh profile id rather than mapping the operand. Both directions
    /// are asserted below, so neither "PROFILE joins the sentinel set"
    /// nor "a real symbol op leaves it" can land silently (review waves
    /// 4 and 5).
    #[test]
    fn every_id_bearing_opcode_uses_the_computed_size_sentinel() {
        let id_bearing = [
            Opcode::XS_CODE_ASYNC_FUNCTION,
            Opcode::XS_CODE_ASYNC_GENERATOR_FUNCTION,
            Opcode::XS_CODE_CONSTRUCTOR_FUNCTION,
            Opcode::XS_CODE_DELETE_PROPERTY,
            Opcode::XS_CODE_DELETE_SUPER,
            Opcode::XS_CODE_FILE,
            Opcode::XS_CODE_FUNCTION,
            Opcode::XS_CODE_GENERATOR_FUNCTION,
            Opcode::XS_CODE_GET_PROPERTY,
            Opcode::XS_CODE_GET_SUPER,
            Opcode::XS_CODE_GET_THIS_VARIABLE,
            Opcode::XS_CODE_GET_VARIABLE,
            Opcode::XS_CODE_EVAL_PRIVATE,
            Opcode::XS_CODE_EVAL_REFERENCE,
            Opcode::XS_CODE_NAME,
            Opcode::XS_CODE_NEW_CLOSURE,
            Opcode::XS_CODE_NEW_LOCAL,
            Opcode::XS_CODE_NEW_PROPERTY,
            Opcode::XS_CODE_PROGRAM_REFERENCE,
            Opcode::XS_CODE_SET_PROPERTY,
            Opcode::XS_CODE_SET_SUPER,
            Opcode::XS_CODE_SET_VARIABLE,
            Opcode::XS_CODE_SYMBOL,
        ];
        for op in id_bearing {
            assert_eq!(
                op.size(),
                0,
                "{} carries an ID operand and must use the computed-size sentinel",
                op.name(),
            );
        }
        // And the converse: nothing else claims the sentinel, so
        // `remap_ids` never rewrites two bytes of a non-ID operand.
        for byte in 0..XS_CODE_COUNT {
            let Some(op) = Opcode::from_u8(byte as u8) else {
                continue;
            };
            if op.size() == 0 {
                assert!(
                    id_bearing.contains(&op),
                    "{} claims the computed-size sentinel but is not ID-bearing",
                    op.name(),
                );
            }
        }
        // PROFILE specifically: ID-shaped, positive size, out of the
        // remap set. `3` is `1 + ID_SIZE` — XS's own non-`mx32bitID`
        // value — so the instruction WALK agrees with the sentinel form
        // while the symbol REMAP correctly skips it.
        assert_eq!(
            Opcode::XS_CODE_PROFILE.size(),
            (1 + ID_SIZE) as i8,
            "PROFILE must keep XS's positive 2-byte-ID size, not the remap sentinel",
        );
        assert!(
            !id_bearing.contains(&Opcode::XS_CODE_PROFILE),
            "PROFILE's operand is a profile counter, not a symbol id",
        );
    }

    /// Wave-6 W6-22: a TRUNCATED TRAILING payload must refuse to walk.
    /// A length-prefixed instruction declaring more payload bytes than
    /// the stream holds used to size "successfully" (the sentinel arms
    /// computed the length without checking the payload exists), so
    /// `remap_ids` walked off the end and reported the truncated
    /// bytecode relinkable — while the dispatch loop fails closed on
    /// the same bytes. The two walkers must agree: truncation is a
    /// refusal in both.
    #[test]
    fn a_truncated_trailing_payload_refuses_to_walk() {
        // STRING_1 (`-1` sentinel: u8 length prefix, then bytes)
        // declaring 8 payload bytes with only 2 present.
        let truncated = [Opcode::XS_CODE_STRING_1 as u8, 8, b'a', b'b'];
        assert_eq!(
            instruction_len(&truncated, 0),
            None,
            "a truncated payload must not size"
        );
        assert!(
            remap_ids(&truncated, Some).is_none(),
            "a truncated payload must not relink"
        );
        // A truncated FIXED-size operand at the tail refuses the same
        // way (INTEGER_2 is 3 bytes; only the opcode byte is present).
        let short_fixed = [Opcode::XS_CODE_INTEGER_2 as u8];
        assert_eq!(instruction_len(&short_fixed, 0), None);
        assert!(remap_ids(&short_fixed, Some).is_none());
        // The well-formed forms still walk: a payload ending EXACTLY at
        // the end of the stream is complete, not truncated.
        let exact = [Opcode::XS_CODE_STRING_1 as u8, 2, b'a', b'b'];
        assert_eq!(instruction_len(&exact, 0), Some(4));
        assert!(remap_ids(&exact, Some).is_some());
    }
}
