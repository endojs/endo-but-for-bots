//! Suspend inside a live `try` (the deferred-work checklist's engine
//! item): a `yield`/`await` with jump handlers installed snapshots the
//! run's handler chain into the saved frame (positions relative to the
//! frame base) and the resume rebases it — so a throw AFTER the resume
//! still lands in the try's catch, exactly as if the run had never
//! suspended.

use ironhorse_vm::{parse_symbols, Interp};

fn run1(src: &str) -> (bool, String) {
    let (b, syms) = ironhorse_compile::compile_atoms(src).expect("fixture compiles");
    let names = parse_symbols(&syms);
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    let o = m.run(&b);
    (
        o.completed,
        if o.completed {
            o.result
        } else {
            format!("{:?}", o.halt)
        },
    )
}

#[test]
fn yield_inside_try_resumes_and_catches_after_the_suspend() {
    // The sent value arrives inside the try; the throw AFTER the
    // resume unwinds into the catch that was live across the suspend.
    let (ok, r) = run1(
        "function g() { } \
         g = function* () { var x = 0; \
             try { x = yield 1; if (x) { throw x; } } catch (e) { return e + 10; } \
             return -1; }; \
         var it = g(); var a = it.next().value; var res = it.next(5); a + res.value",
    );
    assert!(ok, "halt: {r}");
    assert_eq!(r, "16", "1 (first yield) + 15 (5 thrown after resume, caught, +10)");
}

#[test]
fn yield_inside_try_completing_normally_pops_the_handler() {
    // No throw: the rebased handler is popped by the try's normal exit
    // and the generator completes; a later throw is NOT caught by it.
    let (ok, r) = run1(
        "function g() { } \
         g = function* () { var x = 0; \
             try { x = yield 1; } catch (e) { return 99; } \
             return x + 1; }; \
         var it = g(); it.next(); it.next(7).value",
    );
    assert!(ok, "halt: {r}");
    assert_eq!(r, "8", "the try exits normally and the body continues");
}

#[test]
fn nested_tries_survive_the_suspend() {
    // Two live handlers at the suspend; the inner catches and the
    // outer sees the rethrow.
    let (ok, r) = run1(
        "function g() { } \
         g = function* () { var x = 0; \
             try { \
                 try { x = yield 1; throw x; } catch (e) { throw e + 1; } \
             } catch (e2) { return e2 + 100; } } ; \
         var it = g(); it.next(); it.next(5).value",
    );
    assert!(ok, "halt: {r}");
    assert_eq!(r, "106", "inner rethrow (+1) lands in the rebased outer catch (+100)");
}

#[test]
fn generator_state_survives_multiple_suspends_in_one_try() {
    let (ok, r) = run1(
        "function g() { } \
         g = function* () { var x = 0; var y = 0; \
             try { x = yield 1; y = yield 2; throw x + y; } catch (e) { return e * 2; } }; \
         var it = g(); it.next(); it.next(3); it.next(4).value",
    );
    assert!(ok, "halt: {r}");
    assert_eq!(r, "14", "(3 + 4) thrown after the second resume, caught, *2");
}
