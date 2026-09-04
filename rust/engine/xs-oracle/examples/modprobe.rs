//! Module-goal disassembly probe for the stage-5 modules child: compiles
//! each argument as a MODULE on the XS oracle (parse + code, no run) and
//! prints the emitted module bytecode disassembled with decoded operands.
//! Used to read the ground-truth module bytecode the Rust coder targets.

use ironhorse_vm::opcode::{instruction_len, Opcode};

fn decode_operand(op: Opcode, code: &[u8], pc: usize) -> String {
    let sz = op.size();
    let rd_s1 = |o: usize| code[pc + o] as i8 as i32;
    let rd_u2 = |o: usize| u16::from_le_bytes([code[pc + o], code[pc + o + 1]]) as u32;
    use Opcode::*;
    match op {
        XS_CODE_INTEGER_1 | XS_CODE_BRANCH_1 | XS_CODE_BRANCH_ELSE_1 | XS_CODE_BRANCH_IF_1
        | XS_CODE_CATCH_1 | XS_CODE_CODE_1 => format!("{}", rd_s1(1)),
        XS_CODE_RESERVE_1 | XS_CODE_GET_LOCAL_1 | XS_CODE_SET_LOCAL_1 | XS_CODE_VAR_LOCAL_1
        | XS_CODE_LET_LOCAL_1 | XS_CODE_CONST_LOCAL_1 | XS_CODE_PULL_LOCAL_1
        | XS_CODE_GET_CLOSURE_1 | XS_CODE_SET_CLOSURE_1 | XS_CODE_VAR_CLOSURE_1
        | XS_CODE_LET_CLOSURE_1 | XS_CODE_CONST_CLOSURE_1 | XS_CODE_PULL_CLOSURE_1
        | XS_CODE_STORE_1 | XS_CODE_RETRIEVE_1 | XS_CODE_UNWIND_1 => format!("#{}", code[pc + 1]),
        XS_CODE_STRING_1 => {
            let len = code[pc + 1] as usize;
            let s = &code[pc + 2..pc + 2 + len.min(code.len() - pc - 2)];
            format!("{}:{:?}", len, String::from_utf8_lossy(s))
        }
        _ if sz == 0 => format!("id={}", rd_u2(1)),
        _ => String::new(),
    }
}

fn disasm(code: &[u8]) -> String {
    let mut out = String::new();
    let mut pc = 0usize;
    while pc < code.len() {
        let op = match Opcode::from_u8(code[pc]) {
            Some(o) => o,
            None => {
                out.push_str(&format!("  {:04}: <bad {:#04x}>\n", pc, code[pc]));
                break;
            }
        };
        let operand = decode_operand(op, code, pc);
        out.push_str(&format!("  {:04}: {} {}\n", pc, op.name(), operand));
        match instruction_len(code, pc) {
            Some(l) if l > 0 => pc += l,
            _ => break,
        }
    }
    out
}

fn main() {
    let progs: Vec<String> = std::env::args().skip(1).collect();
    let progs = if progs.is_empty() {
        vec!["export const x = 1;".to_string()]
    } else {
        progs
    };
    for src in progs {
        match xs_oracle::compile_module(&src) {
            Some(o) => {
                println!(
                    "SRC {:?}\n  compiled={} err={:?} nbytes={} bytes={:02x?}",
                    src, o.compiled, o.error, o.bytecode.len(), o.bytecode
                );
                print!("{}", disasm(&o.bytecode));
            }
            None => println!("SRC {} <machine fail>", src),
        }
    }
}
