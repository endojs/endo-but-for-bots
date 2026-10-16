//! Stack painting: the high-water mark of a stage's host-stack use, in bytes
//! below the caller's frame. Included by path from the native harness
//! (`ironhorse-vm/tests/stack_height.rs`) and the probe (`probe/src/main.rs`).
//!
//! `stage(f)` paints the unused stack below its frame with a sentinel, runs
//! `f`, then finds the lowest byte `f` dirtied. One run, read to the byte, no
//! bisection. Frame sizes are a property of the build, but what runs at the
//! deepest point is not fixed by it: the engine's hash tables are seeded per
//! process, so marks of one native build vary from run to run by up to about
//! 184 B (`benches/README.md`).
//!
//! The paint stops `STAGE_GAP` bytes below the stage's frame, so a stage that
//! dirties nothing past that reads exactly `STAGE_GAP`, the floor. The gap is
//! measured from the stage's frame rather than rounded to a page: rounded, the
//! floor took any value in a 4 KiB range depending on the frame's address, so
//! a frame above the stage that moved by a few bytes could raise every
//! shallow mark by up to 4 KiB without any stage getting deeper.
//!
//! The painter needs a downward-growing, contiguous stack below the caller
//! with at least `NATIVE_STACK_BYTES` of room, which the harness and the
//! native probe give it by running on a thread of that size. On wasm32 the
//! shadow stack lives in linear memory and is painted by the host instead
//! (`node/run.cjs`), so [`stage`] there runs `f` and reports zero.

#![allow(dead_code)]

use ironhorse_vm::NATIVE_STACK_BYTES;

const SENTINEL: u8 = 0xA5;
const PAGE: usize = 4096;
/// Left unpainted at the bottom of the thread's stack: the guard pages, and the
/// thread's own start frames above the painter, whose sizes are not known.
const BOTTOM_MARGIN: usize = 256 * 1024;
/// Left unpainted below the stage's frame: the least a mark can read. Every
/// stage the harness measures uses more (the smallest, an empty program's run,
/// 2,287 B on x86-64 Linux).
pub const STAGE_GAP: usize = 2048;
/// The least of that gap left below the painter's own frame: the rest of that
/// frame, the fill it calls, and `high_water`'s frame, which sits at the same
/// depth, must not reach the paint. The stage's and the painter's frames take
/// 152 B of the gap in release and 352 B in debug (x86-64 Linux).
const PAINTER_ROOM: usize = 1024;

pub struct Painted {
    top: usize,
    bottom: usize,
}

/// Paint the unused stack from `STAGE_GAP` below `base`, the stage's frame,
/// down. Pages are touched from the top down: Windows commits thread stacks
/// through a moving guard page and faults on a touch more than one page below
/// it.
#[inline(never)]
pub fn paint(base: usize) -> Painted {
    let marker = 0u8;
    let here = std::hint::black_box(&marker) as *const u8 as usize;
    let top = base - STAGE_GAP;
    assert!(
        top + PAINTER_ROOM <= here,
        "the stage's and the painter's frames take {} B of the {STAGE_GAP} B gap, \
         leaving less than {PAINTER_ROOM} B below the painter: raise STAGE_GAP",
        base - here
    );
    let bottom = (here + BOTTOM_MARGIN - NATIVE_STACK_BYTES) & !(PAGE - 1);
    let mut end = top;
    while end > bottom {
        // The rest of the page below `end`; `bottom` is a page boundary.
        let start = (end - 1) & !(PAGE - 1);
        // SAFETY: `[bottom, top)` lies inside this thread's stack mapping and
        // below every live frame; nothing owns it until a callee grows into it.
        unsafe { std::ptr::write_bytes(start as *mut u8, SENTINEL, end - start) };
        end = start;
    }
    Painted { top, bottom }
}

/// Bytes below `base` that were dirtied since `paint`, or the floor
/// (`STAGE_GAP`) when nothing below the gap was touched.
#[inline(never)]
pub fn high_water(painted: &Painted, base: usize) -> usize {
    let mut addr = painted.bottom;
    while addr < painted.top {
        // SAFETY: as in `paint`.
        if unsafe { std::ptr::read_volatile(addr as *const u8) } != SENTINEL {
            return base - addr;
        }
        addr += 1;
    }
    base - painted.top
}

/// Run `f` with the stack below this frame painted; return its value and the
/// bytes of stack it used below this frame.
#[inline(never)]
pub fn stage<T>(f: impl FnOnce() -> T) -> (T, usize) {
    if cfg!(target_arch = "wasm32") {
        return (f(), 0);
    }
    let marker = 0u8;
    let base = std::hint::black_box(&marker) as *const u8 as usize;
    let painted = paint(base);
    let value = f();
    let used = high_water(&painted, base);
    (value, used)
}
