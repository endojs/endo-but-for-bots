//! Host powers backed by cap-std.
//!
//! Provides filesystem, cryptographic, network, and module loading
//! capabilities to JavaScript running in the XS engine. These are
//! registered as host functions on the XS machine and accessed
//! through the machine's context pointer.

pub mod crypto;
pub mod debug;
pub mod fs;
pub mod modules;
pub mod process;
pub mod sqlite;

use crate::ffi::XsMachine;
use cap_std::fs::Dir;
use std::collections::HashMap;

/// The `HostPowers` this machine's context points at.
///
/// Panics if no context is set: a machine restored from a snapshot has the
/// powers callbacks live before anything has called `register_powers` or
/// `set_context` on it, and the panic (caught by the callback's `guard_ffi`)
/// fails the callback closed instead of dereferencing null.
///
/// # Safety
/// Call only from a powers host callback on `the`, the machine XS passed it,
/// whose context was set by `Machine::register_powers` (or `set_context`)
/// under that fn's contract: null or a live `HostPowers`. The reference
/// must not be kept past the callback.
pub(crate) unsafe fn host_powers<'a>(the: *mut XsMachine) -> &'a HostPowers {
    // SAFETY: `the` is the live machine (host-callback contract). Its
    // context is null (rejected here) or, per `set_context`'s contract, a
    // live `HostPowers` that nothing mutates while JS runs, so a shared
    // borrow for the rest of the callback is sound.
    unsafe {
        let context = (*the).context as *const HostPowers;
        assert!(
            !context.is_null(),
            "xsnap: a powers callback ran on a machine with no HostPowers context"
        );
        &*context
    }
}

/// Host powers for an XS worker.
///
/// Holds capability-bounded handles for filesystem, crypto, and
/// module operations. Stored in the XS machine's context pointer
/// so host functions can access it.
pub struct HostPowers {
    /// Named directory handles (e.g., "state", "ephemeral", "cache").
    /// Each Dir is scoped — cap-std rejects path traversal.
    pub dirs: HashMap<String, Dir>,
    /// Module source registry: specifier → source text.
    /// Populated at setup time; queried by the importHook.
    pub module_sources: HashMap<String, String>,
}

impl Default for HostPowers {
    fn default() -> Self {
        Self::new()
    }
}

impl HostPowers {
    /// Create empty host powers (no directories, no modules).
    pub fn new() -> Self {
        HostPowers {
            dirs: HashMap::new(),
            module_sources: HashMap::new(),
        }
    }

    /// Add a directory handle with the given token name.
    pub fn add_dir(&mut self, token: &str, dir: Dir) {
        self.dirs.insert(token.to_string(), dir);
    }

    /// Get a directory handle by token name.
    pub fn get_dir(&self, token: &str) -> Option<&Dir> {
        self.dirs.get(token)
    }

    /// Register a module source by specifier.
    pub fn add_module(&mut self, specifier: &str, source: &str) {
        self.module_sources
            .insert(specifier.to_string(), source.to_string());
    }

    /// Get a module source by specifier.
    pub fn get_module(&self, specifier: &str) -> Option<&str> {
        self.module_sources.get(specifier).map(|s| s.as_str())
    }
}
