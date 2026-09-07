//! Cryptographic host functions.
//!
//! Stateless operations and worker-local incremental SHA-256 hashers.
//!
//! JS calling convention:
//!   sha256(data) -> string (hex)
//!   sha256Bytes(data) -> ArrayBuffer (32 raw bytes)
//!   randomHex256() -> string (64-char hex, 256 bits)
//!   randomFillBytes(view) -> undefined (fills a TypedArray view in place)
//!   ed25519Keygen() -> string (JSON: {publicKey, privateKey} as hex)
//!   ed25519Sign(privateKeyHex, messageHex) -> string (signature hex)

use crate::ffi::*;
use crate::worker_io::{abort_if_ffi_panicked, arg_str, set_result_string};
use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};

// Handle tables belong to the dedicated worker thread. A caught callback panic
// cannot expose a torn mutation to a sibling worker, and thread exit drops all
// remaining native resources. Global IDs prevent a sibling's handle from aliasing
// an entry in this worker's table.
static NEXT_HASHER_HANDLE: AtomicU32 = AtomicU32::new(1);
thread_local! {
    static HASHER_MAP: RefCell<HashMap<u32, Sha256>> = RefCell::new(HashMap::new());
}

/// `sha256(data) -> string`
///
/// Computes SHA-256 of the UTF-8 encoded input string.
/// Returns the hash as a lowercase hex string.
pub unsafe extern "C" fn host_sha256(the: *mut XsMachine) {
    crate::worker_io::guard_ffi(|| unsafe {
        let data = arg_str(the, 0);
        let hash = Sha256::digest(data.as_bytes());
        set_result_string(the, &hex::encode(hash));
    });
}

/// `sha256Bytes(uint8Array) -> ArrayBuffer`
///
/// Computes SHA-256 over binary input and returns the 32 raw digest bytes.
pub unsafe extern "C" fn host_sha256_bytes(the: *mut XsMachine) {
    crate::worker_io::guard_ffi(|| unsafe {
        let data_slot = (*the).frame.sub(1);
        let data = crate::worker_io::read_typed_array_bytes(the, data_slot).unwrap_or_default();
        let hash = Sha256::digest(&data);
        let len = hash.len() as i32;
        fxArrayBuffer(
            the,
            &mut (*the).scratch,
            hash.as_ptr() as *mut std::os::raw::c_void,
            len,
            len,
        );
        *(*the).frame.add(1) = (*the).scratch;
    });
}

/// `randomHex256() -> string`
///
/// Returns 256 bits of cryptographically secure random data
/// as a 64-character hex string.
pub unsafe extern "C" fn host_random_hex256(the: *mut XsMachine) {
    crate::worker_io::guard_ffi(|| unsafe {
        let mut buf = [0u8; 32];
        rand::RngCore::fill_bytes(&mut OsRng, &mut buf);
        set_result_string(the, &hex::encode(buf));
    });
}

/// `randomFillBytes(view) -> undefined`
///
/// Fills the bytes of a TypedArray view in place with
/// cryptographically secure random data — the byte-level primitive
/// under the archive `crypto.getRandomValues` veneer, so it populates
/// the caller's view directly with no hexadecimal round-trip.
pub unsafe extern "C" fn host_random_fill(the: *mut XsMachine) {
    crate::worker_io::guard_ffi(|| unsafe {
        let slot = (*the).frame.sub(1);
        let byte_length = crate::worker_io::typed_array_byte_length(the, slot);
        if byte_length == 0 {
            return;
        }
        let mut buf = vec![0u8; byte_length];
        rand::RngCore::fill_bytes(&mut OsRng, &mut buf);
        crate::worker_io::write_typed_array_bytes(the, slot, &buf);
    });
}

/// `ed25519Keygen() -> string`
///
/// Generates an Ed25519 keypair. Returns JSON:
/// `{"publicKey":"<hex>","privateKey":"<hex>"}`
pub unsafe extern "C" fn host_ed25519_keygen(the: *mut XsMachine) {
    crate::worker_io::guard_ffi(|| unsafe {
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();

        let json = format!(
            "{{\"publicKey\":\"{}\",\"privateKey\":\"{}\"}}",
            hex::encode(verifying_key.as_bytes()),
            hex::encode(signing_key.as_bytes()),
        );
        set_result_string(the, &json);
    });
}

/// `ed25519Sign(privateKeyHex, messageHex) -> string`
///
/// Signs a message with an Ed25519 private key.
/// Both inputs are hex-encoded. Returns the signature as hex.
pub unsafe extern "C" fn host_ed25519_sign(the: *mut XsMachine) {
    crate::worker_io::guard_ffi(|| unsafe {
        let private_key_hex = arg_str(the, 0);
        let message_hex = arg_str(the, 1);

        let private_key_bytes = match hex::decode(private_key_hex) {
            Ok(b) => b,
            Err(_) => {
                set_result_string(the, "Error: invalid private key hex");
                return;
            }
        };
        let message_bytes = match hex::decode(message_hex) {
            Ok(b) => b,
            Err(_) => {
                set_result_string(the, "Error: invalid message hex");
                return;
            }
        };

        if private_key_bytes.len() != 32 {
            set_result_string(the, "Error: private key must be 32 bytes");
            return;
        }

        let mut key_array = [0u8; 32];
        key_array.copy_from_slice(&private_key_bytes);
        let signing_key = SigningKey::from_bytes(&key_array);
        let signature = signing_key.sign(&message_bytes);
        set_result_string(the, &hex::encode(signature.to_bytes()));
    });
}

/// `sha256Init() -> number`
///
/// Creates a new incremental SHA-256 hasher and returns its handle.
pub unsafe extern "C" fn host_sha256_init(the: *mut XsMachine) {
    crate::worker_io::guard_ffi(|| unsafe {
        HASHER_MAP.with(|hasher_map| {
            let handle = NEXT_HASHER_HANDLE.fetch_add(1, Ordering::SeqCst);
            let mut map = hasher_map.borrow_mut();
            map.insert(handle, Sha256::new());
            fxInteger(the, &mut (*the).scratch, handle as i32);
            *(*the).frame.add(1) = (*the).scratch;
        });
    });
}

/// `sha256Update(handle, data) -> undefined`
///
/// Feeds data into an incremental SHA-256 hasher.
pub unsafe extern "C" fn host_sha256_update(the: *mut XsMachine) {
    crate::worker_io::guard_ffi(|| unsafe {
        HASHER_MAP.with(|hasher_map| {
            let handle_slot = (*the).frame.sub(1);
            let handle = fxToInteger(the, handle_slot) as u32;
            abort_if_ffi_panicked();
            let data = arg_str(the, 1);

            let mut map = hasher_map.borrow_mut();
            if let Some(hasher) = map.get_mut(&handle) {
                hasher.update(data.as_bytes());
            }
        });
    });
}

/// `sha256UpdateBytes(handle, uint8Array) -> undefined`
///
/// Feeds binary data (Uint8Array) into an incremental SHA-256 hasher.
/// This bypasses the slow TextDecoder path used by `sha256Update`.
pub unsafe extern "C" fn host_sha256_update_bytes(the: *mut XsMachine) {
    crate::worker_io::guard_ffi(|| unsafe {
        HASHER_MAP.with(|hasher_map| {
            let handle_slot = (*the).frame.sub(1);
            let handle = fxToInteger(the, handle_slot) as u32;
            abort_if_ffi_panicked();
            let data_slot = (*the).frame.sub(2);
            if let Some(buf) = crate::worker_io::read_typed_array_bytes(the, data_slot) {
                let mut map = hasher_map.borrow_mut();
                if let Some(hasher) = map.get_mut(&handle) {
                    hasher.update(&buf);
                }
            }
        });
    });
}

/// `sha256Finish(handle) -> string`
///
/// Finalizes the incremental SHA-256 hasher and returns the hex digest.
/// The handle is consumed and cannot be reused.
pub unsafe extern "C" fn host_sha256_finish(the: *mut XsMachine) {
    crate::worker_io::guard_ffi(|| unsafe {
        HASHER_MAP.with(|hasher_map| {
            let handle_slot = (*the).frame.sub(1);
            let handle = fxToInteger(the, handle_slot) as u32;
            abort_if_ffi_panicked();

            let mut map = hasher_map.borrow_mut();
            match map.remove(&handle) {
                Some(hasher) => {
                    let hash = hasher.finalize();
                    set_result_string(the, &hex::encode(hash));
                }
                None => {
                    set_result_string(the, "Error: invalid hasher handle");
                }
            }
        });
    });
}

/// Native handles cannot be serialized with the XS heap.
pub(crate) fn has_open_handles() -> bool {
    HASHER_MAP.with(|map| !map.borrow().is_empty())
}

/// All host callbacks in registration order for snapshot tables.
pub const CALLBACKS: &[crate::ffi::XsCallback] = &[
    host_sha256,
    host_random_hex256,
    host_random_fill,
    host_ed25519_keygen,
    host_ed25519_sign,
    host_sha256_init,
    host_sha256_update,
    host_sha256_update_bytes,
    host_sha256_finish,
    // Append only: snapshot callback table indices are persistent.
    host_sha256_bytes,
];

/// Register all crypto host functions on the machine.
pub unsafe fn register(machine: &crate::Machine) {
    machine.define_function("sha256", host_sha256, 1);
    machine.define_function("randomHex256", host_random_hex256, 0);
    machine.define_function("randomFillBytes", host_random_fill, 1);
    machine.define_function("ed25519Keygen", host_ed25519_keygen, 0);
    machine.define_function("ed25519Sign", host_ed25519_sign, 2);
    machine.define_function("sha256Init", host_sha256_init, 0);
    machine.define_function("sha256Update", host_sha256_update, 2);
    machine.define_function("sha256UpdateBytes", host_sha256_update_bytes, 2);
    machine.define_function("sha256Finish", host_sha256_finish, 1);
    machine.define_function("sha256Bytes", host_sha256_bytes, 1);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_panic_does_not_expose_hasher_state_to_siblings() {
        std::thread::spawn(|| {
            crate::worker_io::guard_ffi(|| {
                HASHER_MAP.with(|hashers| {
                    let mut hashers = hashers.borrow_mut();
                    hashers.insert(42, Sha256::new());
                    std::thread::spawn(|| {
                        HASHER_MAP.with(|hashers| {
                            assert!(!hashers.borrow().contains_key(&42));
                            let mut hashers = hashers.borrow_mut();
                            hashers.insert(42, Sha256::new());
                            hashers.get_mut(&42).unwrap().update(b"sibling");
                            assert_eq!(
                                hashers.remove(&42).unwrap().finalize(),
                                Sha256::digest(b"sibling")
                            );
                        });
                    })
                    .join()
                    .unwrap();
                    panic!("hasher mutation panic");
                });
            });
            assert!(crate::worker_io::ffi_panicked());
        })
        .join()
        .unwrap();
        HASHER_MAP.with(|hashers| assert!(!hashers.borrow().contains_key(&42)));
    }
}
