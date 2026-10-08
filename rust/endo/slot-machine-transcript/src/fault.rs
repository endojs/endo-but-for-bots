//! Deterministic fault injection for the transcript's durability operations.
//!
//! The design's acceptance bar (designs/ironhorse-panic.md § Verification,
//! crash-injection matrix) asks for "a seam that fails the Nth fsync/write",
//! so that every ordering point of a committing crank can be hit on purpose
//! instead of by a stochastic soak. [`FaultPlan`] is that seam. It counts
//! every *mutating* durability operation the transcript performs, in order:
//!
//! - SQLite's own file writes, truncations, syncs, and deletes, observed
//!   through a wrapping VFS ([`FaultPlan::vfs_name`]) that delegates to the
//!   platform default VFS;
//! - the CAS snapshot publication steps performed in Rust (blob write, blob
//!   sync, rename, directory sync), counted by the CAS writer ([`crate::ContentAddressedStore`]).
//!
//! Reads, locks, and SQLite's shared-memory index are not counted: they
//! cannot make a durable state torn.
//!
//! The plan fires once, at operation number `n` (1-based), in one of the
//! [`FaultMode`]s. [`FaultMode::Crash`] and [`FaultMode::TornWrite`] model a
//! process kill: the operation does not happen (or happens halfway) and every
//! later mutating operation is refused, so nothing after the kill reaches the
//! disk. The test then drops the transcript and reopens the same files
//! without the plan, which is exactly what a restarted supervisor sees.
//! [`FaultMode::FailOnce`] and [`FaultMode::FailAfterEffect`] model an I/O
//! error the process survives; the second is the ambiguous-commit shape,
//! where the data reached the disk but the caller was told it failed.

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::io;
use std::ptr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::ffi;

/// How the plan's one fault behaves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FaultMode {
    /// The process dies before operation `n` takes effect.
    Crash,
    /// The process dies halfway through operation `n`: a write lands its
    /// first half, and any other operation behaves as [`FaultMode::Crash`].
    TornWrite,
    /// Operation `n` fails without effect; the process survives and later
    /// operations proceed normally.
    FailOnce,
    /// Operation `n` takes effect but reports failure; later operations
    /// proceed normally. On a sync inside COMMIT this is an ambiguous commit.
    FailAfterEffect,
}

impl FaultMode {
    /// Every mode, for matrix drivers.
    pub const ALL: [FaultMode; 4] = [
        FaultMode::Crash,
        FaultMode::TornWrite,
        FaultMode::FailOnce,
        FaultMode::FailAfterEffect,
    ];

    /// Whether the mode models process death rather than a survivable error.
    pub fn is_crash(self) -> bool {
        matches!(self, FaultMode::Crash | FaultMode::TornWrite)
    }
}

/// What a counted operation should do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Decision {
    Proceed,
    Fail,
    /// Perform only the first half of a write, then fail.
    Tear,
    /// Perform the operation, then fail.
    ProceedThenFail,
}

#[derive(Debug, Default)]
struct PlanState {
    count: u64,
    trigger: Option<(u64, FaultMode)>,
    dead: bool,
    fired: bool,
    log: Vec<String>,
    syncs: u64,
}

/// A deterministic fault plan shared by a transcript's VFS and CAS writer.
///
/// Cloning shares the plan.
#[derive(Clone, Debug)]
pub struct FaultPlan {
    state: Arc<Mutex<PlanState>>,
    vfs_name: Arc<CString>,
}

static VFS_SEQUENCE: AtomicU64 = AtomicU64::new(0);

impl FaultPlan {
    /// A plan that never fires: counts and logs operations only.
    pub fn counting() -> FaultPlan {
        FaultPlan::build(None)
    }

    /// A plan that fires `mode` at operation `n` (1-based).
    pub fn fail_at(trigger_index: u64, mode: FaultMode) -> FaultPlan {
        assert!(trigger_index >= 1, "fault operations are numbered from 1");
        FaultPlan::build(Some((trigger_index, mode)))
    }

    fn build(trigger: Option<(u64, FaultMode)>) -> FaultPlan {
        let sequence = VFS_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let name = CString::new(format!(
            "slot-machine-fault-{}-{sequence}",
            std::process::id()
        ))
        .expect("vfs name has no NUL");
        let plan = FaultPlan {
            state: Arc::new(Mutex::new(PlanState {
                trigger,
                ..PlanState::default()
            })),
            vfs_name: Arc::new(name),
        };
        register_vfs(&plan);
        plan
    }

    fn lock(&self) -> MutexGuard<'_, PlanState> {
        // A panic while holding the lock is a test failure already; keep
        // counting so the diagnostics survive it.
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// The SQLite VFS name to open the transcript with.
    pub fn vfs_name(&self) -> &str {
        self.vfs_name.to_str().expect("vfs name is ASCII")
    }

    /// Number of counted operations so far (including the faulted one).
    pub fn count(&self) -> u64 {
        self.lock().count
    }

    /// Number of counted sync operations (SQLite xSync plus CAS syncs).
    pub fn syncs(&self) -> u64 {
        self.lock().syncs
    }

    /// Whether the plan's fault has fired.
    pub fn fired(&self) -> bool {
        self.lock().fired
    }

    /// Whether a crash-mode fault has fired, so the simulated process is dead.
    pub fn dead(&self) -> bool {
        self.lock().dead
    }

    /// The label of every counted operation, in order (1-based index `i` is
    /// `log()[i - 1]`).
    pub fn log(&self) -> Vec<String> {
        self.lock().log.clone()
    }

    /// Count one operation and decide its fate.
    pub(crate) fn decide(&self, label: &str, is_write: bool, is_sync: bool) -> Decision {
        let mut state = self.lock();
        if state.dead {
            return Decision::Fail;
        }
        state.count += 1;
        state.log.push(label.to_string());
        if is_sync {
            state.syncs += 1;
        }
        let Some((trigger_index, mode)) = state.trigger else {
            return Decision::Proceed;
        };
        if state.count != trigger_index {
            return Decision::Proceed;
        }
        state.fired = true;
        match mode {
            FaultMode::Crash => {
                state.dead = true;
                Decision::Fail
            }
            FaultMode::TornWrite => {
                state.dead = true;
                if is_write {
                    Decision::Tear
                } else {
                    Decision::Fail
                }
            }
            FaultMode::FailOnce => Decision::Fail,
            FaultMode::FailAfterEffect => Decision::ProceedThenFail,
        }
    }

    /// Run one counted Rust-side durability operation under the plan.
    /// `half` performs half of a write for [`FaultMode::TornWrite`]; pass
    /// `None` for operations that are not writes.
    pub(crate) fn run_operation(
        &self,
        label: &str,
        is_sync: bool,
        full: impl FnOnce() -> io::Result<()>,
        half: Option<&mut dyn FnMut() -> io::Result<()>>,
    ) -> io::Result<()> {
        let is_write = half.is_some();
        match self.decide(label, is_write, is_sync) {
            Decision::Proceed => full(),
            Decision::Fail => Err(injected(label)),
            Decision::Tear => {
                if let Some(half) = half {
                    half()?;
                }
                Err(injected(label))
            }
            Decision::ProceedThenFail => {
                full()?;
                Err(injected(label))
            }
        }
    }
}

fn injected(label: &str) -> io::Error {
    io::Error::other(format!("injected fault at {label}"))
}

/// VFS-level application data: the platform VFS we delegate to and the plan.
struct VfsApp {
    real: *mut ffi::sqlite3_vfs,
    plan: FaultPlan,
}

/// Our `sqlite3_file`. SQLite allocates `szOsFile` bytes for it; the real
/// VFS's file lives in the tail of the same allocation.
#[repr(C)]
struct FaultFile {
    base: ffi::sqlite3_file,
    app: *const VfsApp,
    kind: &'static str,
    real: *mut ffi::sqlite3_file,
}

const fn align_to_eight(size: usize) -> usize {
    (size + 7) & !7
}

fn register_vfs(plan: &FaultPlan) {
    // SAFETY: sqlite3_vfs_find(NULL) returns the process default VFS, which
    // lives for the life of the process. The VFS struct and its app data
    // are leaked deliberately: SQLite keeps a pointer to them for as long as
    // any connection might use the name, and a plan is a test-scoped object
    // whose count per process is small.
    unsafe {
        let real = ffi::sqlite3_vfs_find(ptr::null());
        assert!(!real.is_null(), "no default SQLite VFS");
        let app = Box::into_raw(Box::new(VfsApp {
            real,
            plan: plan.clone(),
        }));
        let mut vfs: ffi::sqlite3_vfs = ptr::read(real);
        vfs.iVersion = 2;
        vfs.szOsFile =
            (align_to_eight(std::mem::size_of::<FaultFile>()) + (*real).szOsFile as usize) as c_int;
        vfs.pNext = ptr::null_mut();
        vfs.zName = plan.vfs_name.as_ptr();
        vfs.pAppData = app.cast();
        vfs.xOpen = Some(vfs_open);
        vfs.xDelete = Some(vfs_delete);
        vfs.xAccess = Some(vfs_access);
        vfs.xFullPathname = Some(vfs_full_pathname);
        vfs.xDlOpen = None;
        vfs.xDlError = None;
        vfs.xDlSym = None;
        vfs.xDlClose = None;
        vfs.xRandomness = Some(vfs_randomness);
        vfs.xSleep = Some(vfs_sleep);
        vfs.xCurrentTime = Some(vfs_current_time);
        vfs.xGetLastError = Some(vfs_get_last_error);
        vfs.xCurrentTimeInt64 = Some(vfs_current_time_int64);
        vfs.xSetSystemCall = None;
        vfs.xGetSystemCall = None;
        vfs.xNextSystemCall = None;
        let rc = ffi::sqlite3_vfs_register(Box::into_raw(Box::new(vfs)), 0);
        assert_eq!(rc, ffi::SQLITE_OK, "registering the fault VFS");
    }
}

unsafe fn app<'a>(vfs: *mut ffi::sqlite3_vfs) -> &'a VfsApp {
    &*((*vfs).pAppData as *const VfsApp)
}

fn file_kind(flags: c_int) -> &'static str {
    if flags & ffi::SQLITE_OPEN_MAIN_DB != 0 {
        "database"
    } else if flags & ffi::SQLITE_OPEN_WAL != 0 {
        "wal"
    } else if flags & ffi::SQLITE_OPEN_MAIN_JOURNAL != 0 {
        "journal"
    } else {
        "temp"
    }
}

unsafe extern "C" fn vfs_open(
    vfs: *mut ffi::sqlite3_vfs,
    name: ffi::sqlite3_filename,
    file: *mut ffi::sqlite3_file,
    flags: c_int,
    out_flags: *mut c_int,
) -> c_int {
    let app = app(vfs);
    let ours = file as *mut FaultFile;
    let real_file = (file as *mut u8).add(align_to_eight(std::mem::size_of::<FaultFile>()))
        as *mut ffi::sqlite3_file;
    (*ours).base.pMethods = ptr::null();
    let rc = ((*app.real).xOpen.expect("xOpen"))(app.real, name, real_file, flags, out_flags);
    if rc != ffi::SQLITE_OK {
        return rc;
    }
    (*ours).app = app;
    (*ours).kind = file_kind(flags);
    (*ours).real = real_file;
    (*ours).base.pMethods = &FAULT_IO_METHODS;
    ffi::SQLITE_OK
}

unsafe extern "C" fn vfs_delete(
    vfs: *mut ffi::sqlite3_vfs,
    name: *const c_char,
    sync_dir: c_int,
) -> c_int {
    let app = app(vfs);
    let label = format!("sqlite:delete:{}", short_name(name));
    match app.plan.decide(&label, false, sync_dir != 0) {
        Decision::Proceed => ((*app.real).xDelete.expect("xDelete"))(app.real, name, sync_dir),
        Decision::Fail | Decision::Tear => ffi::SQLITE_IOERR_DELETE,
        Decision::ProceedThenFail => {
            ((*app.real).xDelete.expect("xDelete"))(app.real, name, sync_dir);
            ffi::SQLITE_IOERR_DELETE
        }
    }
}

unsafe fn short_name(name: *const c_char) -> String {
    if name.is_null() {
        return "<anon>".into();
    }
    let path = CStr::from_ptr(name).to_string_lossy();
    path.rsplit('/').next().unwrap_or("").to_string()
}

unsafe extern "C" fn vfs_access(
    vfs: *mut ffi::sqlite3_vfs,
    name: *const c_char,
    flags: c_int,
    out: *mut c_int,
) -> c_int {
    let real = app(vfs).real;
    ((*real).xAccess.expect("xAccess"))(real, name, flags, out)
}

unsafe extern "C" fn vfs_full_pathname(
    vfs: *mut ffi::sqlite3_vfs,
    name: *const c_char,
    size: c_int,
    out: *mut c_char,
) -> c_int {
    let real = app(vfs).real;
    ((*real).xFullPathname.expect("xFullPathname"))(real, name, size, out)
}

unsafe extern "C" fn vfs_randomness(
    vfs: *mut ffi::sqlite3_vfs,
    size: c_int,
    out: *mut c_char,
) -> c_int {
    let real = app(vfs).real;
    ((*real).xRandomness.expect("xRandomness"))(real, size, out)
}

unsafe extern "C" fn vfs_sleep(vfs: *mut ffi::sqlite3_vfs, micros: c_int) -> c_int {
    let real = app(vfs).real;
    ((*real).xSleep.expect("xSleep"))(real, micros)
}

unsafe extern "C" fn vfs_current_time(vfs: *mut ffi::sqlite3_vfs, out: *mut f64) -> c_int {
    let real = app(vfs).real;
    ((*real).xCurrentTime.expect("xCurrentTime"))(real, out)
}

unsafe extern "C" fn vfs_get_last_error(
    vfs: *mut ffi::sqlite3_vfs,
    size: c_int,
    out: *mut c_char,
) -> c_int {
    let real = app(vfs).real;
    match (*real).xGetLastError {
        Some(method) => method(real, size, out),
        None => 0,
    }
}

unsafe extern "C" fn vfs_current_time_int64(
    vfs: *mut ffi::sqlite3_vfs,
    out: *mut ffi::sqlite3_int64,
) -> c_int {
    let real = app(vfs).real;
    match (*real).xCurrentTimeInt64 {
        Some(method) => method(real, out),
        None => {
            let mut day = 0.0;
            let rc = vfs_current_time(vfs, &mut day);
            *out = (day * 86_400_000.0) as ffi::sqlite3_int64;
            rc
        }
    }
}

static FAULT_IO_METHODS: ffi::sqlite3_io_methods = ffi::sqlite3_io_methods {
    // Version 2: shared memory is delegated; memory-mapped I/O (version 3)
    // is not offered, so every page write goes through xWrite and is counted.
    iVersion: 2,
    xClose: Some(io_close),
    xRead: Some(io_read),
    xWrite: Some(io_write),
    xTruncate: Some(io_truncate),
    xSync: Some(io_sync),
    xFileSize: Some(io_file_size),
    xLock: Some(io_lock),
    xUnlock: Some(io_unlock),
    xCheckReservedLock: Some(io_check_reserved_lock),
    xFileControl: Some(io_file_control),
    xSectorSize: Some(io_sector_size),
    xDeviceCharacteristics: Some(io_device_characteristics),
    xShmMap: Some(io_shm_map),
    xShmLock: Some(io_shm_lock),
    xShmBarrier: Some(io_shm_barrier),
    xShmUnmap: Some(io_shm_unmap),
    xFetch: None,
    xUnfetch: None,
};

unsafe fn parts<'a>(
    file: *mut ffi::sqlite3_file,
) -> (
    &'a FaultFile,
    *mut ffi::sqlite3_file,
    &'a ffi::sqlite3_io_methods,
) {
    let ours = &*(file as *const FaultFile);
    let real = ours.real;
    (ours, real, &*(*real).pMethods)
}

unsafe extern "C" fn io_close(file: *mut ffi::sqlite3_file) -> c_int {
    let (_, real, methods) = parts(file);
    (methods.xClose.expect("xClose"))(real)
}

unsafe extern "C" fn io_read(
    file: *mut ffi::sqlite3_file,
    buf: *mut c_void,
    size: c_int,
    off: ffi::sqlite3_int64,
) -> c_int {
    let (_, real, methods) = parts(file);
    (methods.xRead.expect("xRead"))(real, buf, size, off)
}

unsafe extern "C" fn io_write(
    file: *mut ffi::sqlite3_file,
    buf: *const c_void,
    size: c_int,
    off: ffi::sqlite3_int64,
) -> c_int {
    let (ours, real, methods) = parts(file);
    let write = methods.xWrite.expect("xWrite");
    let label = format!("sqlite:write:{}@{off}+{size}", ours.kind);
    match (*ours.app).plan.decide(&label, true, false) {
        Decision::Proceed => write(real, buf, size, off),
        Decision::Fail => ffi::SQLITE_IOERR_WRITE,
        Decision::Tear => {
            write(real, buf, size / 2, off);
            ffi::SQLITE_IOERR_WRITE
        }
        Decision::ProceedThenFail => {
            write(real, buf, size, off);
            ffi::SQLITE_IOERR_WRITE
        }
    }
}

unsafe extern "C" fn io_truncate(file: *mut ffi::sqlite3_file, size: ffi::sqlite3_int64) -> c_int {
    let (ours, real, methods) = parts(file);
    let truncate = methods.xTruncate.expect("xTruncate");
    let label = format!("sqlite:truncate:{}@{size}", ours.kind);
    match (*ours.app).plan.decide(&label, false, false) {
        Decision::Proceed => truncate(real, size),
        Decision::Fail | Decision::Tear => ffi::SQLITE_IOERR_TRUNCATE,
        Decision::ProceedThenFail => {
            truncate(real, size);
            ffi::SQLITE_IOERR_TRUNCATE
        }
    }
}

unsafe extern "C" fn io_sync(file: *mut ffi::sqlite3_file, flags: c_int) -> c_int {
    let (ours, real, methods) = parts(file);
    let sync = methods.xSync.expect("xSync");
    let label = format!("sqlite:sync:{}", ours.kind);
    match (*ours.app).plan.decide(&label, false, true) {
        Decision::Proceed => sync(real, flags),
        Decision::Fail | Decision::Tear => ffi::SQLITE_IOERR_FSYNC,
        Decision::ProceedThenFail => {
            sync(real, flags);
            ffi::SQLITE_IOERR_FSYNC
        }
    }
}

unsafe extern "C" fn io_file_size(
    file: *mut ffi::sqlite3_file,
    out: *mut ffi::sqlite3_int64,
) -> c_int {
    let (_, real, methods) = parts(file);
    (methods.xFileSize.expect("xFileSize"))(real, out)
}

unsafe extern "C" fn io_lock(file: *mut ffi::sqlite3_file, level: c_int) -> c_int {
    let (_, real, methods) = parts(file);
    (methods.xLock.expect("xLock"))(real, level)
}

unsafe extern "C" fn io_unlock(file: *mut ffi::sqlite3_file, level: c_int) -> c_int {
    let (_, real, methods) = parts(file);
    (methods.xUnlock.expect("xUnlock"))(real, level)
}

unsafe extern "C" fn io_check_reserved_lock(
    file: *mut ffi::sqlite3_file,
    out: *mut c_int,
) -> c_int {
    let (_, real, methods) = parts(file);
    (methods.xCheckReservedLock.expect("xCheckReservedLock"))(real, out)
}

unsafe extern "C" fn io_file_control(
    file: *mut ffi::sqlite3_file,
    operation: c_int,
    argument: *mut c_void,
) -> c_int {
    let (_, real, methods) = parts(file);
    (methods.xFileControl.expect("xFileControl"))(real, operation, argument)
}

unsafe extern "C" fn io_sector_size(file: *mut ffi::sqlite3_file) -> c_int {
    let (_, real, methods) = parts(file);
    (methods.xSectorSize.expect("xSectorSize"))(real)
}

unsafe extern "C" fn io_device_characteristics(file: *mut ffi::sqlite3_file) -> c_int {
    let (_, real, methods) = parts(file);
    (methods
        .xDeviceCharacteristics
        .expect("xDeviceCharacteristics"))(real)
}

unsafe extern "C" fn io_shm_map(
    file: *mut ffi::sqlite3_file,
    page: c_int,
    page_size: c_int,
    extend: c_int,
    out: *mut *mut c_void,
) -> c_int {
    let (_, real, methods) = parts(file);
    match methods.xShmMap {
        Some(method) => method(real, page, page_size, extend, out),
        None => ffi::SQLITE_IOERR,
    }
}

unsafe extern "C" fn io_shm_lock(
    file: *mut ffi::sqlite3_file,
    offset: c_int,
    count: c_int,
    flags: c_int,
) -> c_int {
    let (_, real, methods) = parts(file);
    match methods.xShmLock {
        Some(method) => method(real, offset, count, flags),
        None => ffi::SQLITE_IOERR,
    }
}

unsafe extern "C" fn io_shm_barrier(file: *mut ffi::sqlite3_file) {
    let (_, real, methods) = parts(file);
    if let Some(method) = methods.xShmBarrier {
        method(real)
    }
}

unsafe extern "C" fn io_shm_unmap(file: *mut ffi::sqlite3_file, delete: c_int) -> c_int {
    let (_, real, methods) = parts(file);
    match methods.xShmUnmap {
        Some(method) => method(real, delete),
        None => ffi::SQLITE_OK,
    }
}
