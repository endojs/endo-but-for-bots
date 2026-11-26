//! The Thixotrope Ironhorse worker as a WebAssembly module: the
//! `thixotrope-ironhorse-core` worker over `ironhorse-store-do`'s `DoStore`,
//! behind the export ABI below. This comment is the specification the
//! JavaScript host (`packages/thixotrope/src/ironhorse/wasm/host-abi.mjs`)
//! is written against.
//!
//! # Build
//!
//! `wasm32-wasip1`, with the engine's wasm recipe (`build.py`): unwinding
//! over exnref exception handling and a 4 MiB shadow stack. The module needs
//! the host to support wasm exception handling.
//!
//! The import block and the exports exist only under
//! `cfg(target_family = "wasm")`; a native build compiles and tests the
//! safe parts ([`Instance`], [`HostExecutor`], [`HostTokens`]), which is
//! everything but the pointer handling.
//!
//! # Imports
//!
//! Module `env`, every pointer and length a `u32` address or count in the
//! module's linear memory:
//!
//! - `host_exec(sql_ptr, sql_len, params_ptr, params_len) -> i32`: run one
//!   SQL statement (UTF-8 text) with its parameters, encoded as
//!   `ironhorse_store_do::wire` documents (a tag byte per value: null, an
//!   f64, a blob, UTF-8 text). Answers the byte length `n >= 0` of the
//!   encoded rows, now pending; or, if the statement failed, `-1 - m`, with
//!   the `m` bytes of the error's UTF-8 text pending instead.
//! - `host_take(dst, cap) -> u32`: copy at most `cap` pending bytes to
//!   `dst`, answer how many, and clear what is pending. The guest always
//!   asks for exactly the announced length and treats a short copy as a
//!   failed statement.
//! - `host_log(ptr, len)`: one diagnostic line of UTF-8 text.
//! - `host_random(dst, len)`: fill `len` bytes from the host's cryptographic
//!   randomness. Every commit token comes from here.
//!
//! An import reads or writes only the buffer it is given, never calls back
//! into the module, and never lets a JavaScript exception propagate (it
//! reports a failed statement through `host_exec`'s negative answer). Since
//! the module's memory can grow during any export, a host re-reads
//! `memory.buffer` on every import call.
//!
//! The standard library also imports from `wasi_snapshot_preview1`; the
//! exact list is checked into `build.py`, which fails the build on any
//! other. The worker itself reads no clock, environment or file. The module
//! logs through `host_log` only a panic's message, from its panic hook,
//! before the unwind is caught.
//!
//! # Exports
//!
//! All `extern "C-unwind"`; pointers and lengths are `u32`.
//!
//! | Export | Answers |
//! |---|---|
//! | `ih_abi_version() -> u32` | `1` |
//! | `ih_alloc(len) -> ptr` | a buffer of `len` bytes for the host to fill; `0` if memory cannot grow |
//! | `ih_free(ptr, len)` | frees what `ih_alloc(len)` answered |
//! | `ih_message_len() -> u32` | the pending message's length |
//! | `ih_message_copy(dst, cap) -> u32` | copies at most `cap` bytes of it to `dst`; answers how many |
//! | `ih_open(fresh, lazy, profile_ptr, profile_len, limits_ptr, limits_len) -> i32` | opens the worker (below) |
//! | `ih_boot(name_ptr, name_len, src_ptr, src_len) -> i32` | evaluates one boot source |
//! | `ih_ready() -> i32` | the message is the ready line |
//! | `ih_request(line_ptr, line_len) -> i32` | answers one request line |
//! | `ih_close() -> i32` | checkpoints and closes the worker |
//!
//! The first five have no path that unwinds and never change the pending
//! message. The others run under `catch_unwind` and answer a status, with a
//! message pending that the host reads with `ih_message_len` and
//! `ih_message_copy` (it stays pending until the next status-answering
//! call):
//!
//! | Status | Meaning |
//! |---|---|
//! | `0` | success; the message is the result: empty, the ready line, or the reply line |
//! | `1` | an error, the message is its text; from `ih_request` only, `close` was requested and there is no message |
//! | `2` | an unwind was caught, the message is its text; the instance is poisoned |
//! | `3` | `ih_request` only: the crank failed, the message is the `fatal` reply line and the worker is dead |
//! | `4` | `ih_request` only: refused before anything ran (not serving, close already requested, a line that is not UTF-8, a dead worker), the message is the text |
//!
//! Text arguments must be UTF-8 (otherwise status `1`, or `4` from
//! `ih_request`); a null pointer with a non-zero length is refused the same
//! way. A request line arrives without its line terminator. Reply lines,
//! the ready line and fatal lines are exactly the core's, each ending in
//! `\n`, to be written as they stand.
//!
//! # Calling sequence
//!
//! 1. Instantiate; check `ih_abi_version() == 1`.
//! 2. `ih_open(fresh, lazy, profile, limits)`: `fresh` and `lazy` are `0` or
//!    `1`; `profile` is the runtime profile text, signed into every commit
//!    (`Signature::new`); `limits` is the worker-limits JSON
//!    (`WorkerLimits::parse`). The store is `DoStore` with store id 1.
//!    Fresh begins an empty store (refused if it is populated); otherwise
//!    the stored machine is migrated and resumed, eagerly or lazily. A
//!    second `ih_open` while a worker is open is an error.
//! 3. Fresh only: `ih_boot(name, source)` for each boot source, in order.
//!    The error text is the core's (`boot <name>: ...`); a failed boot
//!    discards the worker uncommitted.
//! 4. `ih_ready()`: after a fresh open it first commits the booted heap
//!    (the error text is `boot checkpoint: ...`, and a failure discards the
//!    worker); then the message is the ready line. Once only.
//! 5. `ih_request(line)` per line: `0` write the reply and continue; `1` stop
//!    reading and go to 6; `3` write the fatal line and stop, without 6;
//!    `4` stop, without 6.
//! 6. `ih_close()`: commit every crank since the last commit, then drop the
//!    session and the store; the error text is the `WorkerError`'s. The
//!    worker is gone whatever the status, and a new `ih_open` is allowed.
//!    On a dead worker it answers `1`, committing nothing.
//!
//! The module holds one worker in a thread-local: it is built without the
//! threads feature, so its memory is unshared and no two exports ever run at
//! once. An export called while another is running (an import calling back
//! in) answers `2` and poisons the instance.
//!
//! # Poison
//!
//! After any status `2` the instance is poisoned: a panic left the machine
//! in an unknown state and nothing may be committed from it. Every later
//! status-answering export answers `2` with a fixed message ([`POISONED`])
//! without touching the worker. The allocator and message exports still
//! work. The host drops the instance.
//!
//! # The host's transaction
//!
//! The host runs every status-answering export call inside one host
//! transaction (`transactionSync` in a Durable Object; `BEGIN IMMEDIATE`
//! and `COMMIT` over SQLite) and commits it only when the status is `0`, or
//! `1` from `ih_request`; on every other status it rolls back. The module
//! issues no transaction statements. `ih_open` may write the schema and the
//! database stamp, and a fresh open writes the first commit; a request
//! writes nothing until `ih_close` (a crank is committed at close, not per
//! request), and a lazy worker's requests read rows. A host that rolls back
//! a successful call's transaction must drop the instance: the machine has
//! advanced past what the database holds.
//!
//! A fresh open's commit is the bare machine, before any boot source, and a
//! later fresh open over it is refused (`begin: NotEmpty`). A host that
//! wants a failed boot to leave the database empty instead holds one
//! transaction from a fresh `ih_open` through `ih_ready`, committing it only
//! if every call answered `0`.
#![deny(unsafe_code)]
#![deny(unsafe_op_in_unsafe_fn)]

mod host;
mod instance;

#[cfg(target_family = "wasm")]
#[allow(unsafe_code)]
mod ffi;

pub use host::{HostExecutor, HostTokens, Imports};
pub use instance::{
    Arg, Instance, ABI_VERSION, POISONED, STATUS_CLOSE, STATUS_ERROR, STATUS_FATAL, STATUS_OK,
    STATUS_REFUSED, STATUS_UNWIND, STORE_ID,
};

#[cfg(test)]
mod tests;
