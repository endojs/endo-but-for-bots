//! Disassembly + dual-run probe for stage-2 development: compiles a
//! program on the XS oracle, prints the emitted bytecode disassembled
//! with decoded operands, plus the oracle's (result, run computrons).

use ironhorse_vm::opcode::{instruction_len, Opcode};

fn decode_operand(op: Opcode, code: &[u8], pc: usize) -> String {
    let sz = op.size();
    let rd_s1 = |o: usize| code[pc + o] as i8 as i32;
    let rd_s2 = |o: usize| i16::from_le_bytes([code[pc + o], code[pc + o + 1]]) as i32;
    let rd_s4 = |o: usize| {
        i32::from_le_bytes([code[pc + o], code[pc + o + 1], code[pc + o + 2], code[pc + o + 3]])
    };
    let rd_u2 = |o: usize| u16::from_le_bytes([code[pc + o], code[pc + o + 1]]) as u32;
    use Opcode::*;
    match op {
        XS_CODE_INTEGER_1 | XS_CODE_BRANCH_1 | XS_CODE_BRANCH_ELSE_1 | XS_CODE_BRANCH_IF_1
        | XS_CODE_CATCH_1 | XS_CODE_CODE_1 | XS_CODE_RUN_1 | XS_CODE_RUN_TAIL_1
        | XS_CODE_BRANCH_STATUS_1 | XS_CODE_BRANCH_CHAIN_1 | XS_CODE_BRANCH_COALESCE_1 => {
            format!("{}", rd_s1(1))
        }
        XS_CODE_INTEGER_2 | XS_CODE_BRANCH_2 | XS_CODE_BRANCH_ELSE_2 | XS_CODE_BRANCH_IF_2
        | XS_CODE_CATCH_2 | XS_CODE_CODE_2 | XS_CODE_RUN_2 => format!("{}", rd_s2(1)),
        XS_CODE_INTEGER_4 | XS_CODE_BRANCH_4 | XS_CODE_CODE_4 => format!("{}", rd_s4(1)),
        XS_CODE_RESERVE_1 | XS_CODE_GET_LOCAL_1 | XS_CODE_SET_LOCAL_1 | XS_CODE_VAR_LOCAL_1
        | XS_CODE_LET_LOCAL_1 | XS_CODE_CONST_LOCAL_1 | XS_CODE_PULL_LOCAL_1
        | XS_CODE_GET_CLOSURE_1 | XS_CODE_SET_CLOSURE_1 | XS_CODE_VAR_CLOSURE_1
        | XS_CODE_LET_CLOSURE_1 | XS_CODE_CONST_CLOSURE_1 | XS_CODE_PULL_CLOSURE_1
        | XS_CODE_UNWIND_1 | XS_CODE_RETRIEVE_1 | XS_CODE_STORE_1 => {
            format!("#{}", code[pc + 1])
        }
        XS_CODE_NUMBER => {
            let mut b = [0u8; 8];
            b.copy_from_slice(&code[pc + 1..pc + 9]);
            format!("{}", f64::from_le_bytes(b))
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
        vec!["(function(x){return x+1})(5)".to_string()]
    } else {
        progs
    };
    for src in progs {
        match xs_oracle::run(&src) {
            Some(o) => {
                println!(
                    "SRC {:?}\n  ok={} result={:?} comp={} raw={} frac={} nbytes={}",
                    src, o.completed, o.result, o.computrons, o.meter_raw,
                    o.meter_raw as i64 - (o.computrons as i64) * 65536, o.bytecode.len()
                );
                print!("{}", disasm(&o.bytecode));
            }
            None => println!("SRC {} <fail>", src),
        }
    }
}
