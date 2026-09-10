#![cfg(test)]
use super::*;

std::thread_local! {
    static MATERIALIZED: Cell<(usize, usize)> = const { Cell::new((0, 0)) };
}

pub(super) fn record_code_words(words: usize) {
    MATERIALIZED.with(|counts| {
        let (code, programs) = counts.get();
        counts.set((code + words, programs));
    });
}

pub(super) fn record_program() {
    MATERIALIZED.with(|counts| {
        let (code, programs) = counts.get();
        counts.set((code, programs + 1));
    });
}

#[test]
fn public_validation_materializes_neither_code_nor_program() {
    let pattern = "(?<name>[a-z]+)|(?<=x)\\k<name>".repeat(64);
    // Duplicate names are legal across these mutually exclusive alternatives.
    MATERIALIZED.with(|counts| counts.set((0, 0)));
    let validated = validate_checked(&pattern, "u", u64::MAX, None);
    assert_eq!(validated.result, Ok(()));
    assert_eq!(MATERIALIZED.with(Cell::get), (0, 0));
    let compiled = compile_checked(&pattern, "u", u64::MAX, None);
    let program = compiled.result.unwrap();
    assert!(program.code.len() > 1024);
    assert_eq!(MATERIALIZED.with(Cell::get), (program.code.len(), 1));
    assert_eq!(validated.work_meter_raw, compiled.work_meter_raw);
}

fn resources<const MATERIALIZE: bool>(
    mutate: impl FnOnce(&mut Compiler<'_, '_, MATERIALIZE>),
) -> (PResult<()>, u64) {
    checked_work(u64::MAX, None, |work| {
        let mut compiler = compile_inner::<MATERIALIZE>(b"", "", work, false)?;
        mutate(&mut compiler);
        Ok(())
    })
}

#[test]
fn validation_keeps_code_and_cumulative_payload_admission() {
    for size in [-4, MAX_CODE_BYTES as i64 + 4] {
        let materialized = resources::<true>(|c| {
            c.size = size;
            c.prepare_code();
        });
        let validated = resources::<false>(|c| {
            c.size = size;
            c.prepare_code();
        });
        assert_eq!(validated.0, Err(CompileError::ResourceLimit));
        assert_eq!(validated, materialized);
    }
    // Exact code-limit admission without a 64-MiB physical output buffer.
    let accepted = resources::<false>(|c| {
        c.size = MAX_CODE_BYTES as i64;
        c.work.payload_bytes.set(0);
        c.prepare_code();
        assert_eq!(c.code.capacity(), 0);
        assert_eq!(c.work.payload_bytes.get(), MAX_CODE_BYTES);
    });
    assert_eq!(accepted.0, Ok(()));
    // Even when nothing is materialized, code must fit the cumulative payload
    // allowance already consumed by the parser.
    let materialized = resources::<true>(|c| {
        c.work.payload_bytes.set(MAX_COMPILE_PAYLOAD_BYTES);
        c.prepare_code();
    });
    let validated = resources::<false>(|c| {
        c.work.payload_bytes.set(MAX_COMPILE_PAYLOAD_BYTES);
        c.prepare_code();
    });
    assert_eq!(validated.0, Err(CompileError::ResourceLimit));
    assert_eq!(validated, materialized);
}

#[test]
fn validation_keeps_the_node_count_ceiling() {
    fn at_node_limit<const MATERIALIZE: bool>() -> (PResult<()>, u64) {
        resources::<MATERIALIZE>(|c| {
            c.nodes.resize_with(MAX_COMPILE_NODES, || Node {
                kind: Kind::Empty,
                step: 0,
                completion: 0,
                loop_off: 0,
            });
            c.add_node(Kind::Empty);
        })
    }
    let compiled = at_node_limit::<true>();
    let validated = at_node_limit::<false>();
    assert_eq!(validated.0, Err(CompileError::ResourceLimit));
    assert_eq!(validated, compiled);
}

#[test]
fn cancellation_during_charset_emission_matches_without_materialization() {
    let pattern = "[a-z]".repeat(512);
    MATERIALIZED.with(|counts| counts.set((0, 0)));
    let mut compiled_calls = Vec::new();
    let compiled = compile_checked(
        &pattern,
        "i",
        u64::MAX,
        Some(&mut |raw| {
            compiled_calls.push(raw);
            MATERIALIZED.with(|counts| counts.get().0 == 0)
        }),
    );
    assert_eq!(compiled.result.unwrap_err(), CompileError::BudgetExceeded);
    let (words, programs) = MATERIALIZED.with(Cell::get);
    assert!(words > 1024, "cancellation must follow output allocation");
    assert_eq!(
        programs, 0,
        "cancellation must precede Program construction"
    );
    let stop_at = *compiled_calls.last().unwrap();
    MATERIALIZED.with(|counts| counts.set((0, 0)));
    let mut validated_calls = Vec::new();
    let validated = validate_checked(
        &pattern,
        "i",
        u64::MAX,
        Some(&mut |raw| {
            validated_calls.push(raw);
            raw < stop_at
        }),
    );
    assert_eq!(validated.result, Err(CompileError::BudgetExceeded));
    assert_eq!(validated.work_meter_raw, compiled.work_meter_raw);
    assert_eq!(validated_calls, compiled_calls);
    assert_eq!(MATERIALIZED.with(Cell::get), (0, 0));
}
