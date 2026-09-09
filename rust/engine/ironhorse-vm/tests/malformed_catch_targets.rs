//! Catch offsets are untrusted bytecode, including before a handler is used.
use ironhorse_vm::{run_program_bounded, Halt, Opcode};

#[test]
fn catch_targets_outside_the_buffer_are_decode_errors() {
    for (opcode, width) in [
        (Opcode::XS_CODE_CATCH_1, 1),
        (Opcode::XS_CODE_CATCH_2, 2),
        (Opcode::XS_CODE_CATCH_4, 4),
    ] {
        // With one THROW after the operand, +1 lands exactly at EOF;
        // -size-1 lands before the buffer. Also exercise distant targets.
        for offset in [1_i32, 127, -(width as i32 + 2), -128] {
            let mut code = vec![opcode as u8];
            code.extend_from_slice(&offset.to_le_bytes()[..width]);
            code.push(Opcode::XS_CODE_THROW as u8);
            for tail in [Opcode::XS_CODE_THROW, Opcode::XS_CODE_RETURN] {
                // Reject bad handlers even when the try body would return
                // without ever using them.
                *code.last_mut().unwrap() = tail as u8;
                let out = run_program_bounded(&code, 100);
                assert!(matches!(out.halt, Halt::Decode(_)), "{code:?}: {out:?}");
            }
        }
    }
}

#[test]
fn catch_can_resume_at_the_last_byte() {
    for (opcode, width) in [
        (Opcode::XS_CODE_CATCH_1, 1),
        (Opcode::XS_CODE_CATCH_2, 2),
        (Opcode::XS_CODE_CATCH_4, 4),
    ] {
        let mut code = vec![opcode as u8];
        code.extend_from_slice(&1_i32.to_le_bytes()[..width]);
        code.extend([Opcode::XS_CODE_THROW as u8, Opcode::XS_CODE_RETURN as u8]);
        assert_eq!(run_program_bounded(&code, 100).halt, Halt::Return);
    }
}

#[test]
fn arbitrary_byte_sweep_does_not_panic_without_the_xs_oracle() {
    // The same deterministic corpus as ironhorse-fuzz's decoder smoke test,
    // available on the oracle-free macOS lane as well.
    for seed in 0u32..2000 {
        let mut state = seed.wrapping_mul(2654435761);
        let mut bytes = Vec::new();
        for _ in 0..state % 40 {
            state = state.wrapping_mul(1103515245).wrapping_add(12345);
            bytes.push((state >> 16) as u8);
        }
        let _ = run_program_bounded(&bytes, 2_000_000);
    }
}
