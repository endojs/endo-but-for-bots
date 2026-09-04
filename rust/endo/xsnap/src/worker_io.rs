//! Worker I/O bridge between the envelope protocol and the XS machine.
//!
//! The Rust/XS worker communicates with a supervisor via CBOR
//! envelopes. Transport is abstracted by the [`WorkerTransport`] trait
//! so that a single XS runner can drive either:
//!
//! - [`PipeTransport`] — a child process speaking over fds 3/4.
//! - [`ChannelTransport`] — a co-process thread inside the supervisor
//!   swapping envelopes through tokio mpsc channels (byte-identical
//!   framing to the pipe path).
//!
//! Host functions that the XS bootstrap calls resolve the active
//! transport through a thread-local slot installed by the runner
//! before entering the machine loop. Every in-process XS machine runs
//! on its own dedicated `std::thread`, so one active transport per
//! thread is sufficient.
//!
//! The worker lifecycle is:
//! 1. Read init envelope → learn daemon handle
//! 2. Bootstrap XS machine with host powers and modules
//! 3. Enter main loop: read deliver envelopes → dispatch CapTP
//!    frames to XS → collect outbound frames → write deliver
//!    envelopes
//!
//! JS calling convention:
//!   recvFrame() -> ArrayBuffer | undefined (blocks until frame arrives)
//!   sendFrame(data: string) -> undefined
//!   getDaemonHandle() -> number

use crate::envelope::{self, Envelope, Handle};
use crate::ffi::*;
use std::any::Any;
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::ffi::CStr;
use std::io::{self, BufReader, BufWriter};
use std::os::unix::io::FromRawFd;
use std::panic::{self, AssertUnwindSafe};
use std::sync::mpsc as std_mpsc;
use std::sync::Once;

// ---------------------------------------------------------------------------
// WorkerTransport trait
// ---------------------------------------------------------------------------

/// Transport-agnostic peer communication for an XS machine running
/// under the Endo envelope protocol.
///
/// Implementations must carry byte-identical CBOR envelope frames
/// on the wire so that the daemon routing logic is oblivious to
/// whether the peer is a child process or an in-process thread.
/// Result of the init handshake.
#[derive(Debug)]
pub enum InitResult {
    /// Normal bootstrap — parent handle.
    Init(Handle),
    /// Restore from snapshot — parent handle + CAS file path bytes.
    Restore(Handle, Vec<u8>),
}

pub trait WorkerTransport: Send {
    /// Perform the init handshake: consume a pre-seeded init
    /// envelope and return the init result (normal or restore).
    fn init_handshake(&mut self) -> io::Result<InitResult>;

    /// Read one raw envelope frame (CBOR byte-string payload).
    /// Returns `Ok(None)` on clean EOF.
    fn recv_raw_envelope(&mut self) -> io::Result<Option<Vec<u8>>>;

    /// Non-blocking variant of `recv_raw_envelope`.  Returns
    /// `Ok(None)` when no envelope is immediately available (or on
    /// EOF).  Used by the reactive main loop to drain pending
    /// inbound envelopes between promise-job runs.
    fn try_recv_raw_envelope(&mut self) -> io::Result<Option<Vec<u8>>>;

    /// Write one raw CBOR byte-string frame.
    fn send_raw_frame(&mut self, data: &[u8]) -> io::Result<()>;

    /// Wrap `payload` in a `deliver` envelope and send it.
    fn send_frame(&mut self, payload: &[u8]) -> io::Result<()>;

    /// Consume the next buffered deliver-envelope payload, blocking
    /// until one arrives. Returns `Ok(None)` on EOF. Non-deliver
    /// envelopes are silently skipped.
    fn recv_frame(&mut self) -> io::Result<Option<Vec<u8>>>;

    /// Parent daemon handle as learned by `init_handshake`.
    fn daemon_handle(&self) -> Handle;
}

// ---------------------------------------------------------------------------
// PipeTransport (child-process peer, fds 3/4)
// ---------------------------------------------------------------------------

/// Child-process transport: reads from fd 4, writes to fd 3.
pub struct PipeTransport {
    reader: BufReader<std::fs::File>,
    writer: BufWriter<std::fs::File>,
    daemon_handle: Handle,
    inbound: VecDeque<Vec<u8>>,
}

impl PipeTransport {
    /// Create a new PipeTransport from raw fd 3 (write) and fd 4 (read).
    ///
    /// # Safety
    /// The caller must ensure fd 3 and fd 4 are valid, open pipe
    /// file descriptors owned by this process.
    pub unsafe fn from_fds() -> io::Result<Self> {
        let read_file = std::fs::File::from_raw_fd(4);
        let write_file = std::fs::File::from_raw_fd(3);
        Ok(PipeTransport {
            reader: BufReader::new(read_file),
            writer: BufWriter::new(write_file),
            daemon_handle: 0,
            inbound: VecDeque::new(),
        })
    }

    /// Create a PipeTransport from arbitrary readers/writers (for testing).
    pub fn from_streams(
        reader: BufReader<std::fs::File>,
        writer: BufWriter<std::fs::File>,
    ) -> Self {
        PipeTransport {
            reader,
            writer,
            daemon_handle: 0,
            inbound: VecDeque::new(),
        }
    }
}

impl WorkerTransport for PipeTransport {
    fn init_handshake(&mut self) -> io::Result<InitResult> {
        let env = envelope::read_envelope(&mut self.reader)?
            .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "no init envelope"))?;
        self.daemon_handle = env.handle;
        match env.verb.as_str() {
            "init" => Ok(InitResult::Init(self.daemon_handle)),
            "restore" => Ok(InitResult::Restore(self.daemon_handle, env.payload)),
            other => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("expected init or restore envelope, got verb '{other}'"),
            )),
        }
    }

    fn recv_raw_envelope(&mut self) -> io::Result<Option<Vec<u8>>> {
        envelope::read_frame(&mut self.reader)
    }

    fn try_recv_raw_envelope(&mut self) -> io::Result<Option<Vec<u8>>> {
        // Pipe workers do not currently need non-blocking recv.
        // If a child-process worker encounters the same quiesce
        // deadlock, this must be replaced with poll(2)/non-blocking I/O.
        Ok(None)
    }

    fn send_raw_frame(&mut self, data: &[u8]) -> io::Result<()> {
        envelope::write_frame(&mut self.writer, data)
    }

    fn send_frame(&mut self, payload: &[u8]) -> io::Result<()> {
        let env = Envelope {
            handle: self.daemon_handle,
            verb: "deliver".to_string(),
            payload: payload.to_vec(),
            nonce: 0,
        };
        envelope::write_envelope(&mut self.writer, &env)
    }

    fn recv_frame(&mut self) -> io::Result<Option<Vec<u8>>> {
        if let Some(frame) = self.inbound.pop_front() {
            return Ok(Some(frame));
        }
        loop {
            match envelope::read_envelope(&mut self.reader)? {
                None => return Ok(None),
                Some(env) => match env.verb.as_str() {
                    "deliver" => return Ok(Some(env.payload)),
                    _ => continue,
                },
            }
        }
    }

    fn daemon_handle(&self) -> Handle {
        self.daemon_handle
    }
}

// ---------------------------------------------------------------------------
// ChannelTransport (in-process peer, mpsc channels)
// ---------------------------------------------------------------------------

/// In-process transport: exchanges raw CBOR envelope bytes with the
/// supervisor through std mpsc channels.
///
/// The bytes on each channel are byte-identical to what the pipe
/// transport would read/write, so there is no parallel code path to
/// drift.
///
/// `init_handshake` consumes a pre-seeded init envelope that the
/// supervisor writes into the inbound channel before spawning the
/// machine thread, so there is no handshake roundtrip.
pub struct ChannelTransport {
    inbound: std_mpsc::Receiver<Vec<u8>>,
    outbound: std_mpsc::Sender<Vec<u8>>,
    daemon_handle: Handle,
    inbound_payloads: VecDeque<Vec<u8>>,
}

impl ChannelTransport {
    /// Create a new ChannelTransport. The `inbound` receiver carries
    /// raw CBOR envelope frames from the supervisor; the `outbound`
    /// sender carries raw CBOR envelope frames back to the
    /// supervisor.
    pub fn new(
        inbound: std_mpsc::Receiver<Vec<u8>>,
        outbound: std_mpsc::Sender<Vec<u8>>,
    ) -> Self {
        ChannelTransport {
            inbound,
            outbound,
            daemon_handle: 0,
            inbound_payloads: VecDeque::new(),
        }
    }

    fn recv_frame_blocking(&mut self) -> io::Result<Option<Vec<u8>>> {
        match self.inbound.recv() {
            Ok(bytes) => Ok(Some(bytes)),
            Err(_) => Ok(None),
        }
    }
}

impl WorkerTransport for ChannelTransport {
    fn init_handshake(&mut self) -> io::Result<InitResult> {
        // The supervisor pre-seeds the inbound channel with the init
        // envelope before starting the machine thread, so this
        // recv blocks only momentarily on the wake-up path.
        let bytes = match self.recv_frame_blocking()? {
            Some(b) => b,
            None => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "channel closed before init",
                ));
            }
        };
        let env = envelope::decode_envelope(&bytes)?;
        self.daemon_handle = env.handle;
        match env.verb.as_str() {
            "init" => Ok(InitResult::Init(self.daemon_handle)),
            "restore" => Ok(InitResult::Restore(self.daemon_handle, env.payload)),
            other => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("expected init or restore envelope, got verb '{other}'"),
            )),
        }
    }

    fn recv_raw_envelope(&mut self) -> io::Result<Option<Vec<u8>>> {
        self.recv_frame_blocking()
    }

    fn try_recv_raw_envelope(&mut self) -> io::Result<Option<Vec<u8>>> {
        match self.inbound.try_recv() {
            Ok(bytes) => Ok(Some(bytes)),
            Err(std_mpsc::TryRecvError::Empty) => Ok(None),
            Err(std_mpsc::TryRecvError::Disconnected) => Ok(None),
        }
    }

    fn send_raw_frame(&mut self, data: &[u8]) -> io::Result<()> {
        self.outbound
            .send(data.to_vec())
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "outbound channel closed"))
    }

    fn send_frame(&mut self, payload: &[u8]) -> io::Result<()> {
        let env = Envelope {
            handle: self.daemon_handle,
            verb: "deliver".to_string(),
            payload: payload.to_vec(),
            nonce: 0,
        };
        let bytes = envelope::encode_envelope(&env);
        self.outbound
            .send(bytes)
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "outbound channel closed"))
    }

    fn recv_frame(&mut self) -> io::Result<Option<Vec<u8>>> {
        if let Some(p) = self.inbound_payloads.pop_front() {
            return Ok(Some(p));
        }
        loop {
            let bytes = match self.recv_frame_blocking()? {
                Some(b) => b,
                None => return Ok(None),
            };
            let env = envelope::decode_envelope(&bytes)?;
            match env.verb.as_str() {
                "deliver" => return Ok(Some(env.payload)),
                _ => continue,
            }
        }
    }

    fn daemon_handle(&self) -> Handle {
        self.daemon_handle
    }
}

// ---------------------------------------------------------------------------
// Thread-local active transport
// ---------------------------------------------------------------------------

thread_local! {
    static ACTIVE_TRANSPORT: RefCell<Option<Box<dyn WorkerTransport>>> = RefCell::new(None);
    static PENDING_ENVELOPE: RefCell<Option<Vec<u8>>> = RefCell::new(None);
}

/// Store envelope bytes in the thread-local for retrieval by `host_get_pending_envelope`.
pub fn set_pending_envelope(data: Vec<u8>) {
    PENDING_ENVELOPE.with(|cell| {
        *cell.borrow_mut() = Some(data);
    });
}

/// Take the pending envelope bytes (used by `host_get_pending_envelope`).
fn take_pending_envelope() -> Option<Vec<u8>> {
    PENDING_ENVELOPE.with(|cell| cell.borrow_mut().take())
}

/// Install the given transport into the calling thread's slot.
///
/// Each in-process XS machine runs on its own dedicated
/// `std::thread`, so one active transport per thread is sufficient.
pub fn install_transport(transport: Box<dyn WorkerTransport>) {
    ACTIVE_TRANSPORT.with(|cell| {
        *cell.borrow_mut() = Some(transport);
    });
}

/// Remove the transport from this thread's slot.
pub fn clear_transport() {
    ACTIVE_TRANSPORT.with(|cell| {
        *cell.borrow_mut() = None;
    });
}

/// Access the currently installed transport on this thread.
pub fn with_transport<F, R>(f: F) -> R
where
    F: FnOnce(&mut dyn WorkerTransport) -> R,
{
    ACTIVE_TRANSPORT.with(|cell| {
        let mut borrow = cell.borrow_mut();
        let t = borrow
            .as_mut()
            .expect("WorkerTransport not installed on this thread");
        f(t.as_mut())
    })
}

// ---------------------------------------------------------------------------
// FFI panic guard
// ---------------------------------------------------------------------------
//
// The in-process XS worker invokes the `host_*` callbacks below through
// `unsafe extern "C"` frames: XS (C) calls back into Rust. Since Rust 1.71 a
// panic that unwinds *past* an `extern "C"` frame aborts the whole process —
// which, because the daemon co-locates many workers in one process, would kill
// every vat rather than the one that faulted, the opposite of per-vat
// isolation (design `designs/ironhorse-panic.md` § Scope: "The already-live FFI
// abort hazard"). Several of these callbacks already contain panicking calls
// today (e.g. `with_transport`'s `.expect(..)`), so the hazard is live, not
// hypothetical.
//
// The guard converts a Rust panic into a **worker-death value before it
// crosses the FFI boundary**: `guard_ffi` wraps each callback body in
// `catch_unwind`, and on a caught panic records a thread-local poison marker
// instead of unwinding. The XS run entry (`run_xs_program`) observes the
// marker at the next crank boundary — a pure-Rust frame with no intervening C
// — and returns `XsnapError::Panicked`, so the *one* worker thread tears down
// (its `unregister`) while its co-resident siblings on other threads keep
// serving. The poison is a **thread-local**, which is exactly what confines the
// death to one worker: each in-process XS machine runs on its own dedicated
// `std::thread`, so poisoning one thread cannot touch another.

/// A caught Rust panic from an `extern "C"` callback, recorded as this
/// worker's pending death. Mirrors the prospective Ironhorse
/// `PanicKind::EngineFault` payload (message + optional physical location);
/// the C-XS worker surfaces it as `XsnapError::Panicked` rather than a
/// `Halt`, since this path has no `Halt` return.
#[derive(Debug, Clone)]
pub struct FfiPanic {
    /// The caught panic's message.
    pub message: String,
    /// The panic's `file:line:col`, when the capture hook recovered it.
    pub location: Option<String>,
}

thread_local! {
    /// This worker thread's pending death from a caught FFI panic. `Some`
    /// once a guarded callback panicked; the run entry drains it.
    static FFI_PANIC: RefCell<Option<FfiPanic>> = const { RefCell::new(None) };
    /// Scratch slot the capture hook writes the panic location into while a
    /// guarded body is unwinding, read back by `guard_ffi`.
    static PANIC_LOCATION: RefCell<Option<String>> = const { RefCell::new(None) };
    /// True on this thread only while inside `guard_ffi`'s `catch_unwind`, so
    /// the process-wide hook records the location for *our* handled panic and
    /// suppresses its default abort-noise, while leaving every other panic to
    /// the previously-installed hook untouched.
    static CAPTURING: Cell<bool> = const { Cell::new(false) };
}

static HOOK_INIT: Once = Once::new();

/// Install (once, process-wide) a panic hook that records a guarded panic's
/// source location into a thread-local. It chains to the previously-installed
/// hook for every panic *not* inside `guard_ffi`, so ordinary panic reporting
/// elsewhere is unchanged.
fn install_capture_hook() {
    HOOK_INIT.call_once(|| {
        let previous_hook = panic::take_hook();
        panic::set_hook(Box::new(move |info| {
            if CAPTURING.with(|c| c.get()) {
                let location = info
                    .location()
                    .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()));
                PANIC_LOCATION.with(|slot| *slot.borrow_mut() = location);
                // Handled: the guard turns this into a Panicked worker-death,
                // so suppress the default hook's abort-style stderr dump.
                return;
            }
            previous_hook(info);
        }));
    });
}

/// Best-effort message from a caught panic payload (`catch_unwind`'s `Err`).
/// Exported so the machine-thread outer net (`inproc`) can recover the
/// message from a panic that never crossed an `extern "C"` frame, matching
/// the payload contract this module's guarded path publishes.
pub fn panic_payload_message(payload: &(dyn Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic".to_string()
    }
}

/// Run one `extern "C"` callback body that returns a value under panic
/// isolation, returning `on_panic` to the C caller if it panics.
///
/// The value-returning core of [`guard_ffi`]. If `f` panics, the panic is
/// caught *before* it can unwind past the enclosing `extern "C"` frame (which
/// would abort the process); the message and location are recorded as this
/// thread's pending [`FfiPanic`], and `on_panic` is returned to XS instead of
/// unwinding. Once poisoned, further guarded callbacks short-circuit (do no
/// effect work, returning `on_panic`) until the run entry drains the marker
/// and kills the worker. `on_panic` is the fail-closed sentinel each C caller
/// reads as "this callback did not succeed" (e.g. the snapshot-stream error
/// code `1`, or the metering-abort `0`).
pub fn guard_ffi_ret<R, F: FnOnce() -> R>(on_panic: R, f: F) -> R {
    if ffi_panicked() {
        // Already dying — do not run further host effects for this worker.
        return on_panic;
    }
    install_capture_hook();
    // Save and restore `CAPTURING` (not set-then-clear): a guarded callback
    // can re-enter JS that calls another `host_*` (e.g. `host_import_archive`
    // -> `install_archive`, `host_debug_poll` -> `run_debugger`), nesting
    // `guard_ffi`. Clearing the flag on the inner guard's exit would disarm
    // capture for the outer body, so a later panic there would lose its
    // location and leak the default hook's abort-style dump.
    let was_capturing = CAPTURING.with(|c| c.replace(true));
    // Clear any stale location before the body so a caught panic here records
    // its own site, never a drained inner guard's.
    PANIC_LOCATION.with(|slot| *slot.borrow_mut() = None);
    let result = panic::catch_unwind(AssertUnwindSafe(f));
    CAPTURING.with(|c| c.set(was_capturing));
    match result {
        Ok(value) => value,
        Err(payload) => {
            let message = panic_payload_message(payload.as_ref());
            let location = PANIC_LOCATION.with(|slot| slot.borrow_mut().take());
            FFI_PANIC.with(|cell| {
                *cell.borrow_mut() = Some(FfiPanic { message, location });
            });
            on_panic
        }
    }
}

/// Run one `extern "C"` callback body (returning `()`) under panic isolation.
///
/// If `f` panics, the panic is caught *before* it can unwind past the
/// enclosing `extern "C"` frame (which would abort the process); the message
/// and location are recorded as this thread's pending [`FfiPanic`], and the
/// callback returns normally to XS. Once poisoned, further guarded callbacks
/// short-circuit (do no effect work) until the run entry drains the marker and
/// kills the worker. Thin `()`-returning wrapper over [`guard_ffi_ret`].
pub fn guard_ffi<F: FnOnce()>(f: F) {
    guard_ffi_ret((), f)
}

/// Whether this worker thread has a pending FFI-panic death.
pub fn ffi_panicked() -> bool {
    FFI_PANIC.with(|cell| cell.borrow().is_some())
}

/// Take this worker thread's pending FFI-panic death, if any, clearing it.
pub fn take_ffi_panic() -> Option<FfiPanic> {
    FFI_PANIC.with(|cell| cell.borrow_mut().take())
}

// ---------------------------------------------------------------------------
// XS host functions
// ---------------------------------------------------------------------------

/// Read a string argument from the XS stack frame.
///
/// XS stores strings in CESU-8.  This function decodes surrogate
/// pairs into proper UTF-8 so that Rust string operations work
/// correctly on supplementary characters (emoji, etc.).
///
/// # Safety
/// Caller must ensure `the` is a valid XS machine pointer and
/// `index` is within the argument count.
pub unsafe fn arg_str(the: *mut XsMachine, index: usize) -> String {
    let slot = (*the).frame.sub(1 + index);
    let ptr = fxToString(the, slot);
    xs_string_to_utf8(ptr)
}

/// Set xsResult to a string.
///
/// Encodes the UTF-8 input as CESU-8 before passing to XS so that
/// supplementary characters round-trip correctly.
///
/// # Safety
/// Caller must ensure `the` is a valid XS machine pointer.
pub unsafe fn set_result_string(the: *mut XsMachine, s: &str) {
    let cesu = crate::cesu8::encode(s);
    let c_str = std::ffi::CString::new(cesu).unwrap_or_default();
    fxString(the, &mut (*the).scratch, c_str.as_ptr());
    *(*the).frame.add(1) = (*the).scratch;
}

/// Convert an XS C string (CESU-8) to a Rust UTF-8 `String`.
///
/// # Safety
/// `ptr` must be a valid null-terminated C string from XS.
pub(crate) unsafe fn xs_string_to_utf8(ptr: *const std::os::raw::c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let bytes = CStr::from_ptr(ptr).to_bytes();
    crate::cesu8::decode_lossy(bytes)
}

/// `recvFrame() -> string | undefined`
///
/// Blocks until the next CapTP frame arrives from the supervisor.
/// Returns the frame payload as a hex string, or undefined on EOF.
pub unsafe extern "C" fn host_recv_frame(the: *mut XsMachine) {
    guard_ffi(|| unsafe {
        let result = with_transport(|t| t.recv_frame());
        match result {
            Ok(Some(data)) => {
                set_result_string(the, &hex::encode(&data));
            }
            Ok(None) => {
                // EOF — leave result as undefined
            }
            Err(e) => {
                let msg = format!("Error: {}", e);
                set_result_string(the, &msg);
            }
        }
    });
}

/// `sendFrame(hexData: string) -> undefined`
pub unsafe extern "C" fn host_send_frame(the: *mut XsMachine) {
    guard_ffi(|| unsafe {
        let hex_data = arg_str(the, 0);
        match hex::decode(hex_data) {
            Ok(data) => {
                let _ = with_transport(|t| t.send_frame(&data));
            }
            Err(_) => {}
        }
    });
}

/// `getDaemonHandle() -> number`
pub unsafe extern "C" fn host_get_daemon_handle(the: *mut XsMachine) {
    guard_ffi(|| unsafe {
        let handle = with_transport(|t| t.daemon_handle());
        fxInteger(the, &mut (*the).scratch, handle as i32);
        *(*the).frame.add(1) = (*the).scratch;
    });
}

/// `issueCommand(uint8Array) -> undefined`
pub unsafe extern "C" fn host_issue_command(the: *mut XsMachine) {
    guard_ffi(|| unsafe {
        let slot = (*the).frame.sub(1);
        if let Some(buf) = read_typed_array_bytes(the, slot) {
            if let Err(e) = with_transport(|t| t.send_frame(&buf)) {
                eprintln!("endor: issueCommand error: {}", e);
            }
        }
    });
}

/// `sendRawFrame(uint8Array) -> undefined`
pub unsafe extern "C" fn host_send_raw_frame(the: *mut XsMachine) {
    guard_ffi(|| unsafe {
        let slot = (*the).frame.sub(1);
        if let Some(buf) = read_typed_array_bytes(the, slot) {
            if let Err(e) = with_transport(|t| t.send_raw_frame(&buf)) {
                eprintln!("endor: sendRawFrame error: {}", e);
            }
        }
    });
}

/// Read bytes from a TypedArray (e.g. Uint8Array) argument slot.
pub unsafe fn read_typed_array_bytes(the: *mut XsMachine, slot: *mut XsSlot) -> Option<Vec<u8>> {
    fx_push(the, *slot);
    let byte_length_id = fxID(the, c"byteLength".as_ptr());
    fxGetID(the, byte_length_id);
    let byte_length = fxToInteger(the, (*the).stack) as usize;
    fx_pop(the);

    if byte_length == 0 {
        return None;
    }

    fx_push(the, *slot);
    let byte_offset_id = fxID(the, c"byteOffset".as_ptr());
    fxGetID(the, byte_offset_id);
    let byte_offset = fxToInteger(the, (*the).stack) as i32;
    fx_pop(the);

    fx_push(the, *slot);
    let buffer_id = fxID(the, c"buffer".as_ptr());
    fxGetID(the, buffer_id);
    let buffer_slot = (*the).stack;

    let mut buf = vec![0u8; byte_length];
    fxGetArrayBufferData(
        the,
        buffer_slot,
        byte_offset,
        buf.as_mut_ptr() as *mut std::os::raw::c_void,
        byte_length as i32,
    );
    fx_pop(the);

    Some(buf)
}

/// Read the `byteLength` of a TypedArray (e.g. Uint8Array) argument
/// slot without copying its contents.
pub unsafe fn typed_array_byte_length(the: *mut XsMachine, slot: *mut XsSlot) -> usize {
    fx_push(the, *slot);
    let byte_length_id = fxID(the, c"byteLength".as_ptr());
    fxGetID(the, byte_length_id);
    let byte_length = fxToInteger(the, (*the).stack) as usize;
    fx_pop(the);
    byte_length
}

/// Write `data` into a TypedArray (e.g. Uint8Array) argument slot,
/// in place, mirroring `read_typed_array_bytes`. Writes exactly the
/// view's `byteLength` bytes at its `byteOffset` and returns the
/// number written; a `data` shorter than the view, or an empty view,
/// writes nothing and returns 0.
pub unsafe fn write_typed_array_bytes(
    the: *mut XsMachine,
    slot: *mut XsSlot,
    data: &[u8],
) -> usize {
    let byte_length = typed_array_byte_length(the, slot);
    if byte_length == 0 || data.len() < byte_length {
        return 0;
    }

    fx_push(the, *slot);
    let byte_offset_id = fxID(the, c"byteOffset".as_ptr());
    fxGetID(the, byte_offset_id);
    let byte_offset = fxToInteger(the, (*the).stack) as i32;
    fx_pop(the);

    fx_push(the, *slot);
    let buffer_id = fxID(the, c"buffer".as_ptr());
    fxGetID(the, buffer_id);
    let buffer_slot = (*the).stack;

    fxSetArrayBufferData(
        the,
        buffer_slot,
        byte_offset,
        data.as_ptr() as *mut std::os::raw::c_void,
        byte_length as i32,
    );
    fx_pop(the);

    byte_length
}

/// `importArchive(uint8Array) -> boolean`
pub unsafe extern "C" fn host_import_archive(the: *mut XsMachine) {
    guard_ffi(|| unsafe {
        let slot = (*the).frame.sub(1);
        let buf = match read_typed_array_bytes(the, slot) {
            Some(b) => b,
            None => {
                fxBoolean(the, &mut (*the).scratch, 0);
                *(*the).frame.add(1) = (*the).scratch;
                return;
            }
        };
        let cursor = std::io::Cursor::new(buf);
        match crate::archive::load_archive(cursor) {
            Ok(loaded) => {
                let machine = std::mem::ManuallyDrop::new(crate::Machine { raw: the, registered_callbacks: std::cell::RefCell::new(Vec::new()) });
                let ok = crate::archive::install_archive(&machine, &loaded);
                fxBoolean(the, &mut (*the).scratch, if ok { 1 } else { 0 });
                *(*the).frame.add(1) = (*the).scratch;
            }
            Err(_) => {
                fxBoolean(the, &mut (*the).scratch, 0);
                *(*the).frame.add(1) = (*the).scratch;
            }
        }
    });
}

/// `trace(msg: string) -> undefined`
pub unsafe extern "C" fn host_trace(the: *mut XsMachine) {
    guard_ffi(|| unsafe {
        let msg = arg_str(the, 0);
        eprintln!("endor: [trace] {}", msg);
    });
}

/// `stdoutLine(msg: string) -> undefined`
///
/// Writes a line to the process's real stdout. Endowed to the
/// standalone archive runner as the sink for `console.log` so a
/// program's own output is separable from the runner's stderr
/// diagnostics.
pub unsafe extern "C" fn host_stdout_line(the: *mut XsMachine) {
    guard_ffi(|| unsafe {
        let msg = arg_str(the, 0);
        println!("{}", msg);
    });
}

/// `getPendingEnvelope() -> ArrayBuffer | undefined`
///
/// Returns the pending envelope bytes (set by `set_pending_envelope`)
/// as an ArrayBuffer, or undefined if none is pending.
/// Used by `dispatch_envelope` to pass binary data to JS without
/// hex-encoding (which is O(n²) for large payloads).
pub unsafe extern "C" fn host_get_pending_envelope(the: *mut XsMachine) {
    guard_ffi(|| unsafe {
        if let Some(mut data) = take_pending_envelope() {
            fxArrayBuffer(
                the,
                &mut (*the).scratch,
                data.as_mut_ptr() as *mut std::ffi::c_void,
                data.len() as i32,
                data.len() as i32,
            );
            *(*the).frame.add(1) = (*the).scratch;
        }
        // If no pending envelope, result stays undefined.
    });
}

/// `hostBase64Decode(string) -> ArrayBuffer`
///
/// Decode a base64-encoded string and return the raw bytes as an
/// ArrayBuffer. This provides the native `Base64.decode` that
/// `@endo/base64` checks for, avoiding the pure-JS fallback which is
/// orders of magnitude too slow in XS for large inputs.
pub unsafe extern "C" fn host_base64_decode(the: *mut XsMachine) {
    guard_ffi(|| unsafe {
        let input = arg_str(the, 0);
        // Use the base64 standard engine with padding.
        use base64::Engine as _;
        match base64::engine::general_purpose::STANDARD.decode(input) {
            Ok(mut data) => {
                fxArrayBuffer(
                    the,
                    &mut (*the).scratch,
                    data.as_mut_ptr() as *mut std::ffi::c_void,
                    data.len() as i32,
                    data.len() as i32,
                );
                *(*the).frame.add(1) = (*the).scratch;
            }
            Err(e) => {
                let msg = format!("Error: invalid base64: {}", e);
                set_result_string(the, &msg);
            }
        }
    });
}

/// `hostBase64Encode(uint8Array) -> string`
///
/// Encode raw bytes as a base64 string. Paired with `hostBase64Decode`.
pub unsafe extern "C" fn host_base64_encode(the: *mut XsMachine) {
    guard_ffi(|| unsafe {
        let slot = (*the).frame.sub(1);
        if let Some(buf) = read_typed_array_bytes(the, slot) {
            use base64::Engine as _;
            let encoded = base64::engine::general_purpose::STANDARD.encode(&buf);
            let c_str = std::ffi::CString::new(encoded).unwrap_or_default();
            fxString(the, &mut (*the).scratch, c_str.as_ptr());
            *(*the).frame.add(1) = (*the).scratch;
        }
    });
}

/// `hostDecodeUtf8(uint8Array) -> string`
///
/// Decode a Uint8Array as UTF-8 and return it as a JavaScript string.
/// This bypasses XS's TextDecoder which is extremely slow for large
/// buffers (>100KB), causing the daemon to hang on large CapTP
/// payloads like bundled source code in storeBlob.
pub unsafe extern "C" fn host_decode_utf8(the: *mut XsMachine) {
    guard_ffi(|| unsafe {
        let slot = (*the).frame.sub(1);
        if let Some(buf) = read_typed_array_bytes(the, slot) {
            match std::str::from_utf8(&buf) {
                Ok(s) => {
                    // The input is valid UTF-8.  XS expects CESU-8, so
                    // re-encode supplementary characters as surrogate pairs.
                    set_result_string(the, s);
                }
                Err(e) => {
                    let msg = format!("Error: invalid UTF-8: {}", e);
                    set_result_string(the, &msg);
                }
            }
        }
    });
}

/// `hostEncodeUtf8(string) -> ArrayBuffer`
///
/// Encode a JavaScript string as UTF-8 and return the raw bytes as an
/// ArrayBuffer. This bypasses XS's TextEncoder which is extremely slow
/// for large strings (>100KB), causing the daemon to hang when
/// serializing large CapTP payloads like bundled source code.
pub unsafe extern "C" fn host_encode_utf8(the: *mut XsMachine) {
    guard_ffi(|| unsafe {
        let s = arg_str(the, 0);
        let bytes = s.as_bytes();
        let len = bytes.len();
        let mut data = bytes.to_vec();
        fxArrayBuffer(
            the,
            &mut (*the).scratch,
            data.as_mut_ptr() as *mut std::ffi::c_void,
            len as i32,
            len as i32,
        );
        *(*the).frame.add(1) = (*the).scratch;
    });
}

/// Serialize a parsed URL as the JSON record the JS `URL` veneer
/// caches: every WHATWG getter surface in its final shape (protocol
/// with the trailing ':', search with the leading '?', port `''`
/// when default), via the `url` crate's `quirks` module — the
/// spec-faithful getter/setter surface rust-url maintains for
/// implementing the URL class.
fn url_record_json(url: &url::Url) -> String {
    serde_json::json!({
        "href": url::quirks::href(url),
        "origin": url::quirks::origin(url),
        "protocol": url::quirks::protocol(url),
        "username": url::quirks::username(url),
        "password": url::quirks::password(url),
        "host": url::quirks::host(url),
        "hostname": url::quirks::hostname(url),
        "port": url::quirks::port(url),
        "pathname": url::quirks::pathname(url),
        "search": url::quirks::search(url),
        "hash": url::quirks::hash(url),
    })
    .to_string()
}

fn url_error_json(message: &str) -> String {
    serde_json::json!({ "error": message }).to_string()
}

/// `hostUrlParse(href, base) -> string`
///
/// Parse `href` (against `base` when non-empty — the empty string is
/// the no-base sentinel) and return a JSON url record, or
/// `{"error": ...}` when the input does not parse.
pub unsafe extern "C" fn host_url_parse(the: *mut XsMachine) {
    guard_ffi(|| unsafe {
        let href = arg_str(the, 0);
        let base = arg_str(the, 1);
        let parsed = if base.is_empty() {
            url::Url::parse(&href)
        } else {
            url::Url::parse(&base).and_then(|b| b.join(&href))
        };
        let json = match parsed {
            Ok(u) => url_record_json(&u),
            Err(e) => url_error_json(&e.to_string()),
        };
        set_result_string(the, &json);
    });
}

/// `hostUrlSet(href, field, value) -> string`
///
/// Apply one WHATWG URL setter to `href` and return the updated JSON
/// url record, or `{"error": ...}` when the setter rejects the value
/// (the JS side ignores that, per the spec's setter semantics, except
/// for `href` which throws).
pub unsafe extern "C" fn host_url_set(the: *mut XsMachine) {
    guard_ffi(|| unsafe {
        let href = arg_str(the, 0);
        let field = arg_str(the, 1);
        let value = arg_str(the, 2);
        let json = match url::Url::parse(&href) {
            Ok(mut u) => {
                let ok = match field.as_str() {
                    "href" => url::quirks::set_href(&mut u, &value).is_ok(),
                    "protocol" => url::quirks::set_protocol(&mut u, &value).is_ok(),
                    "username" => url::quirks::set_username(&mut u, &value).is_ok(),
                    "password" => url::quirks::set_password(&mut u, &value).is_ok(),
                    "host" => url::quirks::set_host(&mut u, &value).is_ok(),
                    "hostname" => url::quirks::set_hostname(&mut u, &value).is_ok(),
                    "port" => url::quirks::set_port(&mut u, &value).is_ok(),
                    "pathname" => {
                        url::quirks::set_pathname(&mut u, &value);
                        true
                    }
                    "search" => {
                        url::quirks::set_search(&mut u, &value);
                        true
                    }
                    "hash" => {
                        url::quirks::set_hash(&mut u, &value);
                        true
                    }
                    _ => false,
                };
                if ok {
                    url_record_json(&u)
                } else {
                    url_error_json(&format!("cannot set {field}"))
                }
            }
            Err(e) => url_error_json(&e.to_string()),
        };
        set_result_string(the, &json);
    });
}

/// `hostFormUrlDecode(query) -> string`
///
/// Parse an application/x-www-form-urlencoded string into a JSON
/// array of `[name, value]` pairs.
pub unsafe extern "C" fn host_form_urlencoded_decode(the: *mut XsMachine) {
    guard_ffi(|| unsafe {
        let input = arg_str(the, 0);
        let pairs: Vec<(String, String)> = url::form_urlencoded::parse(input.as_bytes())
            .into_owned()
            .collect();
        let json = serde_json::to_string(&pairs).unwrap_or_else(|_| "[]".to_string());
        set_result_string(the, &json);
    });
}

/// `hostFormUrlEncode(pairsJson) -> string`
///
/// Serialize a JSON array of `[name, value]` pairs as an
/// application/x-www-form-urlencoded string.
pub unsafe extern "C" fn host_form_urlencoded_encode(the: *mut XsMachine) {
    guard_ffi(|| unsafe {
        let input = arg_str(the, 0);
        let pairs: Vec<(String, String)> = serde_json::from_str(&input).unwrap_or_default();
        let mut serializer = url::form_urlencoded::Serializer::new(String::new());
        for (name, value) in &pairs {
            serializer.append_pair(name, value);
        }
        let encoded = serializer.finish();
        set_result_string(the, &encoded);
    });
}

/// `debugPoll() -> undefined`
///
/// Run the XS debugger command loop once, flushing any pending
/// debug output to the bus.  Called from JS bootstrap to drain
/// initial debug commands (e.g. set-all-breakpoints) that arrive
/// before the first eval.
///
/// When mxDebug is not compiled in, `run_debugger()` is a no-op.
pub unsafe extern "C" fn host_debug_poll(the: *mut XsMachine) {
    guard_ffi(|| {
        let machine = std::mem::ManuallyDrop::new(crate::Machine { raw: the, registered_callbacks: std::cell::RefCell::new(Vec::new()) });
        machine.run_debugger();
        crate::flush_debug_outbound();
    });
}

/// All worker I/O host callbacks in registration order.
/// Used for the snapshot callback table.
pub const WORKER_IO_CALLBACKS: &[crate::ffi::XsCallback] = &[
    host_recv_frame,
    host_send_frame,
    host_get_daemon_handle,
    host_issue_command,
    host_send_raw_frame,
    host_import_archive,
    host_trace,
    host_get_pending_envelope,
    host_decode_utf8,
    host_encode_utf8,
    host_base64_decode,
    host_base64_encode,
    host_debug_poll,
    host_stdout_line,
    host_url_parse,
    host_url_set,
    host_form_urlencoded_decode,
    host_form_urlencoded_encode,
];

/// Register worker I/O host functions on the machine.
pub unsafe fn register(machine: &crate::Machine) {
    machine.define_function("recvFrame", host_recv_frame, 0);
    machine.define_function("sendFrame", host_send_frame, 1);
    machine.define_function("getDaemonHandle", host_get_daemon_handle, 0);
    machine.define_function("issueCommand", host_issue_command, 1);
    machine.define_function("sendRawFrame", host_send_raw_frame, 1);
    machine.define_function("importArchive", host_import_archive, 1);
    machine.define_function("trace", host_trace, 1);
    machine.define_function("getPendingEnvelope", host_get_pending_envelope, 0);
    machine.define_function("hostDecodeUtf8", host_decode_utf8, 1);
    machine.define_function("hostEncodeUtf8", host_encode_utf8, 1);
    machine.define_function("hostBase64Decode", host_base64_decode, 1);
    machine.define_function("hostBase64Encode", host_base64_encode, 1);
    machine.define_function("debugPoll", host_debug_poll, 0);
    machine.define_function("stdoutLine", host_stdout_line, 1);
    machine.define_function("hostUrlParse", host_url_parse, 2);
    machine.define_function("hostUrlSet", host_url_set, 3);
    machine.define_function("hostFormUrlDecode", host_form_urlencoded_decode, 1);
    machine.define_function("hostFormUrlEncode", host_form_urlencoded_encode, 1);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope;
    use std::sync::mpsc as std_mpsc;

    /// Build a fake pipe pair from in-memory buffers for testing.
    fn make_test_pipe(inbound_envelopes: &[Envelope]) -> PipeTransport {
        let mut buf = Vec::new();
        for env in inbound_envelopes {
            envelope::write_envelope(&mut buf, env).unwrap();
        }

        let tmp_read = tempfile::tempfile().unwrap();
        {
            use std::io::Write;
            let mut w = &tmp_read;
            w.write_all(&buf).unwrap();
        }
        use std::io::Seek;
        let mut tmp_read = tmp_read;
        tmp_read.seek(std::io::SeekFrom::Start(0)).unwrap();

        let tmp_write = tempfile::tempfile().unwrap();

        PipeTransport::from_streams(
            BufReader::new(tmp_read),
            BufWriter::new(tmp_write),
        )
    }

    #[test]
    fn pipe_init_handshake() {
        let init = Envelope {
            handle: 5,
            verb: "init".to_string(),
            payload: vec![],
            nonce: 0,
        };
        let mut t = make_test_pipe(&[init]);
        let result = t.init_handshake().unwrap();
        match result {
            InitResult::Init(h) => assert_eq!(h, 5),
            other => panic!("expected Init(5), got {:?}", other),
        }
        assert_eq!(t.daemon_handle(), 5);
    }

    #[test]
    fn pipe_recv_deliver_frame() {
        let init = Envelope {
            handle: 3,
            verb: "init".to_string(),
            payload: vec![],
            nonce: 0,
        };
        let deliver = Envelope {
            handle: 3,
            verb: "deliver".to_string(),
            payload: b"captp-message".to_vec(),
            nonce: 0,
        };
        let mut t = make_test_pipe(&[init, deliver]);
        t.init_handshake().unwrap();

        let frame = t.recv_frame().unwrap().unwrap();
        assert_eq!(frame, b"captp-message");
    }

    #[test]
    fn pipe_send_frame_wraps_in_deliver() {
        let init = Envelope {
            handle: 7,
            verb: "init".to_string(),
            payload: vec![],
            nonce: 0,
        };
        let mut t = make_test_pipe(&[init]);
        t.init_handshake().unwrap();

        t.send_frame(b"response-data").unwrap();

        use std::io::Seek;
        let PipeTransport { writer, .. } = t;
        let mut file = writer.into_inner().unwrap();
        file.seek(std::io::SeekFrom::Start(0)).unwrap();
        let mut reader = BufReader::new(file);
        let env = envelope::read_envelope(&mut reader).unwrap().unwrap();

        assert_eq!(env.handle, 7); // daemon handle
        assert_eq!(env.verb, "deliver");
        assert_eq!(env.payload, b"response-data");
    }

    #[test]
    fn pipe_eof_returns_none() {
        let init = Envelope {
            handle: 1,
            verb: "init".to_string(),
            payload: vec![],
            nonce: 0,
        };
        let mut t = make_test_pipe(&[init]);
        t.init_handshake().unwrap();

        let frame = t.recv_frame().unwrap();
        assert!(frame.is_none());
    }

    // ChannelTransport tests

    fn make_channel_pair() -> (ChannelTransport, std_mpsc::Sender<Vec<u8>>, std_mpsc::Receiver<Vec<u8>>) {
        let (sup_to_machine_tx, sup_to_machine_rx) = std_mpsc::channel();
        let (machine_to_sup_tx, machine_to_sup_rx) = std_mpsc::channel();
        let t = ChannelTransport::new(sup_to_machine_rx, machine_to_sup_tx);
        (t, sup_to_machine_tx, machine_to_sup_rx)
    }

    #[test]
    fn channel_init_envelope_preseeded() {
        let (mut t, tx, _rx) = make_channel_pair();
        // Pre-seed the init envelope into the inbound channel.
        let init_bytes = envelope::encode_envelope(&Envelope {
            handle: 42,
            verb: "init".to_string(),
            payload: vec![],
            nonce: 0,
        });
        tx.send(init_bytes).unwrap();

        let result = t.init_handshake().unwrap();
        match result {
            InitResult::Init(h) => assert_eq!(h, 42),
            other => panic!("expected Init(42), got {:?}", other),
        }
        assert_eq!(t.daemon_handle(), 42);
    }

    #[test]
    fn channel_init_precedes_subsequent_envelopes() {
        let (mut t, tx, _rx) = make_channel_pair();
        // Seed init first, then a deliver. init_handshake() must
        // return the seeded init handle before any later envelope
        // reaches the machine via recv_raw_envelope().
        let init = envelope::encode_envelope(&Envelope {
            handle: 9,
            verb: "init".to_string(),
            payload: vec![],
            nonce: 0,
        });
        let deliver = envelope::encode_envelope(&Envelope {
            handle: 9,
            verb: "deliver".to_string(),
            payload: b"first".to_vec(),
            nonce: 0,
        });
        tx.send(init).unwrap();
        tx.send(deliver).unwrap();

        // init_handshake() must consume the init frame before the
        // next recv returns the deliver frame.
        let result = t.init_handshake().unwrap();
        match result {
            InitResult::Init(h) => assert_eq!(h, 9),
            other => panic!("expected Init(9), got {:?}", other),
        }

        let bytes = t.recv_raw_envelope().unwrap().unwrap();
        let env = envelope::decode_envelope(&bytes).unwrap();
        assert_eq!(env.verb, "deliver");
        assert_eq!(env.payload, b"first");
    }

    #[test]
    fn channel_send_frame_encodes_deliver() {
        let (mut t, tx, rx) = make_channel_pair();
        let init = envelope::encode_envelope(&Envelope {
            handle: 11,
            verb: "init".to_string(),
            payload: vec![],
            nonce: 0,
        });
        tx.send(init).unwrap();
        t.init_handshake().unwrap();

        t.send_frame(b"hello").unwrap();
        let bytes = rx.recv().unwrap();
        let env = envelope::decode_envelope(&bytes).unwrap();
        assert_eq!(env.handle, 11);
        assert_eq!(env.verb, "deliver");
        assert_eq!(env.payload, b"hello");
    }

    #[test]
    fn channel_closed_returns_none() {
        let (mut t, tx, _rx) = make_channel_pair();
        let init = envelope::encode_envelope(&Envelope {
            handle: 1,
            verb: "init".to_string(),
            payload: vec![],
            nonce: 0,
        });
        tx.send(init).unwrap();
        t.init_handshake().unwrap();
        drop(tx);

        let frame = t.recv_frame().unwrap();
        assert!(frame.is_none());
    }

    // -- FFI panic guard (design `designs/ironhorse-panic.md` § Scope: "The
    //    already-live FFI abort hazard") --------------------------------

    #[test]
    fn ffi_guard_catches_panic_and_records_message_and_location() {
        assert!(take_ffi_panic().is_none(), "start clean");
        guard_ffi(|| panic!("boom in a callback"));
        assert!(ffi_panicked(), "the guard must record a pending death");
        let p = take_ffi_panic().expect("a panic was recorded");
        assert!(
            p.message.contains("boom in a callback"),
            "message was {:?}",
            p.message
        );
        // The capture hook recovers the panic!'s source position.
        let location = p.location.expect("a location was captured");
        assert!(location.contains("worker_io.rs"), "location was {location:?}");
        assert!(!ffi_panicked(), "take clears the marker");
    }

    #[test]
    fn panic_payload_message_falls_back_for_non_string_payloads() {
        // A panic payload that is neither `&str` nor `String` (e.g. a
        // dependency's `panic_any(non_string)`) must still yield a message
        // rather than panic the recovery path itself.
        let payload: Box<dyn std::any::Any + Send> = Box::new(42i32);
        assert_eq!(panic_payload_message(payload.as_ref()), "unknown panic");
    }

    #[test]
    fn guard_ffi_records_a_non_string_panic_payload() {
        assert!(take_ffi_panic().is_none(), "start clean");
        guard_ffi(|| std::panic::panic_any(7u8));
        let p = take_ffi_panic().expect("a non-string panic is still recorded");
        assert_eq!(p.message, "unknown panic");
    }

    #[test]
    fn guard_ffi_ret_returns_sentinel_on_panic_and_value_otherwise() {
        assert!(take_ffi_panic().is_none(), "start clean");
        // Happy path: the closure's own value is returned, no poison.
        assert_eq!(guard_ffi_ret(1, || 0), 0);
        assert!(!ffi_panicked(), "a clean run leaves no poison");
        // Panic path: the fail-closed sentinel is returned and the worker is
        // poisoned (the snapshot-stream callbacks read `1` as "failed").
        assert_eq!(guard_ffi_ret(1, || panic!("stream boom")), 1);
        assert!(ffi_panicked(), "a panicking body poisons the worker");
        // Once poisoned, a further guarded call short-circuits to the sentinel
        // without running its body.
        let mut ran = false;
        assert_eq!(
            guard_ffi_ret(1, || {
                ran = true;
                0
            }),
            1,
        );
        assert!(!ran, "a poisoned worker must not run further guarded bodies");
        let _ = take_ffi_panic();
    }

    #[test]
    fn real_extern_c_callback_is_installed_under_the_guard() {
        // Regression: prove the guard is actually *installed* on the real
        // `extern "C"` callbacks, not merely that `guard_ffi` works when
        // called directly (reverting a wrapper leaves every direct-call test
        // green). `host_recv_frame` calls `with_transport(..)` — which
        // `.expect(..)`-panics on this transport-less test thread — before it
        // dereferences `the`, so a null machine pointer is safe: the panic
        // fires inside the guarded body and must be caught, leaving this
        // worker poisoned rather than aborting the process across the FFI
        // frame.
        assert!(take_ffi_panic().is_none(), "start clean");
        unsafe { host_recv_frame(std::ptr::null_mut()) };
        assert!(
            ffi_panicked(),
            "the real extern \"C\" callback must run its body under guard_ffi",
        );
        let _ = take_ffi_panic();
    }

    #[test]
    fn nested_guard_preserves_outer_capture() {
        // A guarded callback can re-enter JS that calls another `host_*`,
        // nesting `guard_ffi`. The inner guard must not disarm capture for
        // the outer body: a panic in the outer body *after* the inner guard
        // returns must still be caught and located, never dumped by the
        // default hook.
        assert!(take_ffi_panic().is_none(), "start clean");
        guard_ffi(|| {
            // Inner guarded callback runs to completion without panicking.
            guard_ffi(|| {});
            // The outer body now panics; capture must still be armed.
            panic!("outer body panic after a nested guard");
        });
        let p = take_ffi_panic().expect("the outer panic must be caught");
        assert!(
            p.message.contains("outer body panic after a nested guard"),
            "message was {:?}",
            p.message
        );
        let location = p
            .location
            .expect("the outer panic's location must survive nesting");
        assert!(location.contains("worker_io.rs"), "location was {location:?}");
        let _ = take_ffi_panic();
    }

    #[test]
    fn ffi_guard_catches_the_missing_transport_expect() {
        // The design's named live example: `with_transport`'s
        // `.expect("WorkerTransport not installed on this thread")` panics on
        // any thread with no transport installed (this test thread has none).
        // The guard must catch it rather than let it abort the process at the
        // `extern "C"` boundary.
        assert!(take_ffi_panic().is_none());
        guard_ffi(|| {
            with_transport(|_t| unreachable!("no transport is installed"));
        });
        let p = take_ffi_panic().expect("the expect() panic was caught");
        assert!(
            p.message.contains("WorkerTransport not installed"),
            "message was {:?}",
            p.message
        );
    }

    #[test]
    fn ffi_guard_short_circuits_once_poisoned() {
        assert!(take_ffi_panic().is_none());
        guard_ffi(|| panic!("first"));
        assert!(ffi_panicked());
        // A poisoned worker must not run further host effects: the second
        // body must not execute while the death is pending.
        let mut ran_after_poison = false;
        guard_ffi(|| ran_after_poison = true);
        assert!(
            !ran_after_poison,
            "guarded bodies must short-circuit while poisoned"
        );
        let _ = take_ffi_panic();
    }

    #[test]
    fn ffi_panic_is_confined_to_one_worker_thread() {
        // Models the design's acceptance scenario — two co-resident workers
        // in one daemon process, one panicking — at the unit level: each
        // in-process XS worker runs on its own dedicated `std::thread`, and
        // the poison is a thread-local, so a panic in one worker's callback
        // cannot touch a sibling. Worker A panics and dies; worker B runs its
        // callback normally and keeps serving, proving the death is confined
        // to one worker rather than aborting the shared process.
        let a = std::thread::spawn(|| {
            guard_ffi(|| panic!("boom in worker A"));
            ffi_panicked()
        });
        let b = std::thread::spawn(|| {
            let mut served = false;
            guard_ffi(|| served = true);
            (served, ffi_panicked())
        });

        let a_poisoned = a.join().expect("worker A thread joins");
        let (b_served, b_poisoned) = b.join().expect("worker B thread joins");

        assert!(a_poisoned, "the panicking worker A must be poisoned");
        assert!(b_served, "the sibling worker B must still run its callback");
        assert!(
            !b_poisoned,
            "worker A's panic must not poison the sibling worker B"
        );
    }
}
