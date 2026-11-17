//! ONT-21 verifier probe: if one opcode were inserted at enum position k,
//! how many already-compiled programs would still pass a width-only walk
//! (the restore check) while containing a byte whose meaning shifted?
use ironhorse_vm::opcode::{CODE_SIZES, ID_SIZE, XS_CODE_COUNT};

#[path = "../../ironhorse-compile/tests/corpus_cases/mod.rs"]
mod corpus_cases;

fn size_after_insert(b: usize, k: usize, s_new: i8) -> Option<i8> {
    if b < k { Some(CODE_SIZES[b]) }
    else if b == k { Some(s_new) }
    else if b - 1 < XS_CODE_COUNT { Some(CODE_SIZES[b - 1]) }
    else { None }
}

fn walk(code: &[u8], table: &dyn Fn(usize) -> Option<i8>) -> bool {
    let mut pc = 0usize;
    while pc < code.len() {
        let Some(size) = table(code[pc] as usize) else { return false };
        let len = if size > 0 { size as usize } else {
            match size {
                0 => 1 + ID_SIZE,
                -1 => match code.get(pc + 1) { Some(&n) => 2 + n as usize, None => return false },
                -2 => match (code.get(pc + 1), code.get(pc + 2)) {
                    (Some(&lo), Some(&hi)) => 3 + (lo as usize | (hi as usize) << 8),
                    _ => return false },
                -4 => {
                    let mut v = 0usize;
                    for i in 0..4 { match code.get(pc + 1 + i) { Some(&x) => v |= (x as usize) << (8 * i), None => return false } }
                    5 + v
                }
                _ => return false,
            }
        };
        pc += len;
        if pc > code.len() { return false; }
    }
    pc == code.len()
}

#[test]
fn width_walk_catch_rate_for_mid_enum_insertion() {
    let programs: Vec<Vec<u8>> = corpus_cases::corpus_programs()
        .into_iter()
        .filter_map(|(_, src)| ironhorse_compile::compile(&src).ok())
        .collect();
    let identity = |b: usize| CODE_SIZES.get(b).copied();
    assert!(programs.iter().all(|c| walk(c, &identity)));
    println!("programs={}", programs.len());
    let mut total_silent = 0usize;
    let mut total_affected = 0usize;
    for k in [1usize, 30, 60, 90, 120, 150, 180, 210, 237, 238, 246] {
        for s_new in [1i8, 2] {
            let table = |b: usize| size_after_insert(b, k, s_new);
            let mut affected = 0; // programs containing an opcode byte >= k (meaning shifted)
            let mut silent = 0;   // ...that still pass the width-only walk
            for code in &programs {
                // opcode bytes at instruction starts under the OLD table
                let mut pc = 0; let mut touches = false;
                while pc < code.len() {
                    if code[pc] as usize >= k { touches = true; }
                    pc += ironhorse_vm::instruction_len(code, pc).unwrap();
                }
                if touches {
                    affected += 1;
                    if walk(code, &table) { silent += 1; }
                }
            }
            total_silent += silent; total_affected += affected;
            println!("insert@{k:3} width{s_new}: affected={affected:4} silently_accepted={silent:4}");
        }
    }
    println!("TOTAL affected={total_affected} silently_accepted={total_silent}");
}

#[test]
fn show_one_misread() {
    use ironhorse_vm::Opcode;
    let src = "var a = [1, 2, 3]; var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; s";
    let code = ironhorse_compile::compile(src).unwrap();
    let k = 120usize;
    let table = |b: usize| size_after_insert(b, k, 1);
    let accepted = walk(&code, &table);
    let mut pc = 0; let mut old = Vec::new(); let mut new = Vec::new();
    while pc < code.len() {
        let b = code[pc] as usize;
        old.push(format!("{:?}", Opcode::from_u8(b as u8).unwrap()));
        new.push(if b < k { format!("{:?}", Opcode::from_u8(b as u8).unwrap()) } else if b == k { "NEW".into() } else { format!("{:?}", Opcode::from_u8((b - 1) as u8).unwrap()) });
        pc += ironhorse_vm::instruction_len(&code, pc).unwrap();
    }
    let diffs: Vec<_> = old.iter().zip(&new).filter(|(a, b)| a != b).take(8).collect();
    println!("len={} accepted_by_width_walk={accepted} shifted={} of {} instrs; first diffs: {:?}", code.len(), old.iter().zip(&new).filter(|(a,b)| a!=b).count(), old.len(), diffs);
}
