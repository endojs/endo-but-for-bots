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
use crate::host_ledger::{self, Descriptor, Outcome};
use crate::worker_io::{abort_if_ffi_panicked, arg_str, set_result_string};
use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;
use sha2::{Digest, Sha256};
use slot_machine_transcript::HostClass;
use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};

// Handle tables belong to the dedicated worker thread. A caught callback panic
// cannot expose a torn mutation to a sibling worker, and thread exit drops all
// remaining native resources. `host_ledger::call` allocates the ids.
thread_local! {
    static HASHER_MAP: RefCell<HashMap<u32, Hasher>> = RefCell::new(HashMap::new());
    /// Hashers fed during the open crank, redescribed once at its commit.
    static FED_THIS_CRANK: RefCell<BTreeSet<u32>> = const { RefCell::new(BTreeSet::new()) };
}

/// An incremental hasher and, under a transcript, every byte fed to it up
/// to [`host_ledger::HASHER_DESCRIPTOR_LIMIT`] (`None` past the limit).
struct Hasher {
    sha256: Sha256,
    fed: Option<Vec<u8>>,
}

impl Hasher {
    fn new(fed: Option<Vec<u8>>) -> Hasher {
        let mut sha256 = Sha256::new();
        if let Some(fed) = &fed {
            sha256.update(fed);
        }
        Hasher { sha256, fed }
    }
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
        // A read of nondeterministic state: the transcript records the value.
        let result = host_ledger::call("randomHex256", None, b"[]", || {
            let mut buf = [0u8; 32];
            rand::RngCore::fill_bytes(&mut OsRng, &mut buf);
            let hex = hex::encode(buf);
            set_result_string(the, &hex);
            Outcome {
                reply: hex.into_bytes(),
                ..Outcome::default()
            }
        });
        if let Err(msg) = result {
            set_result_string(the, &msg);
        }
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
        let request = format!("[{byte_length}]").into_bytes();
        let result = host_ledger::call("randomFillBytes", None, &request, || {
            let mut buf = vec![0u8; byte_length];
            rand::RngCore::fill_bytes(&mut OsRng, &mut buf);
            crate::worker_io::write_typed_array_bytes(the, slot, &buf);
            Outcome {
                reply: buf,
                ..Outcome::default()
            }
        });
        if let Err(msg) = result {
            set_result_string(the, &msg);
        }
    });
}

/// `ed25519Keygen() -> string`
///
/// Generates an Ed25519 keypair. Returns JSON:
/// `{"publicKey":"<hex>","privateKey":"<hex>"}`
pub unsafe extern "C" fn host_ed25519_keygen(the: *mut XsMachine) {
    crate::worker_io::guard_ffi(|| unsafe {
        let result = host_ledger::call("ed25519Keygen", None, b"[]", || {
            let signing_key = SigningKey::generate(&mut OsRng);
            let verifying_key = signing_key.verifying_key();

            let json = format!(
                "{{\"publicKey\":\"{}\",\"privateKey\":\"{}\"}}",
                hex::encode(verifying_key.as_bytes()),
                hex::encode(signing_key.as_bytes()),
            );
            set_result_string(the, &json);
            Outcome {
                reply: json.into_bytes(),
                ..Outcome::default()
            }
        });
        if let Err(msg) = result {
            set_result_string(the, &msg);
        }
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
        let result = host_ledger::call("sha256Init", None, b"", || Outcome {
            opens: Some(Descriptor::hasher(b"")),
            ..Outcome::default()
        });
        match result {
            Ok(Some(handle)) => {
                let fed = host_ledger::attached().then(Vec::new);
                HASHER_MAP.with(|m| m.borrow_mut().insert(handle, Hasher::new(fed)));
                fxInteger(the, &mut (*the).scratch, handle as i32);
                *(*the).frame.add(1) = (*the).scratch;
            }
            Err(msg) => set_result_string(the, &msg),
            Ok(None) => {}
        }
    });
}

/// Update `handle`'s hasher with `data`, keeping the bytes within the
/// retention limits ([`feed`]). Returns whether the hasher keeps (or just
/// stopped keeping) its bytes, so its descriptor needs restaging.
fn update(hashers: &mut HashMap<u32, Hasher>, handle: u32, data: &[u8]) -> bool {
    let retained: usize = hashers
        .values()
        .filter_map(|h| h.fed.as_ref().map(Vec::len))
        .sum();
    let Some(hasher) = hashers.get_mut(&handle) else {
        return false;
    };
    hasher.sha256.update(data);
    let Some(fed) = &mut hasher.fed else {
        return false;
    };
    if fed.len() + data.len() > host_ledger::HASHER_DESCRIPTOR_LIMIT
        || retained + data.len() > host_ledger::HASHERS_RETAINED_LIMIT
    {
        hasher.fed = None;
    } else {
        fed.extend_from_slice(data);
    }
    true
}

/// Feed `data` to a hasher under the host-call ledger. Under a transcript
/// the hasher keeps every fed byte, up to
/// [`host_ledger::HASHER_DESCRIPTOR_LIMIT`] for the hasher and
/// [`host_ledger::HASHERS_RETAINED_LIMIT`] across every open hasher, so a
/// guest cannot grow native memory the crank meter does not see by opening
/// more hashers. A hasher past either limit stops keeping its bytes and is
/// re-seated as broken. It is redescribed once when
/// the crank commits ([`take_redescriptions`]), so each call records only
/// its own bytes.
///
/// # Safety
/// `the` must be valid.
unsafe fn feed(the: *mut XsMachine, callback: &str, handle: u32, data: &[u8]) {
    let mut request = handle.to_be_bytes().to_vec();
    request.extend_from_slice(data);
    let result = host_ledger::call(callback, Some(handle), &request, || {
        HASHER_MAP.with(|m| {
            if update(&mut m.borrow_mut(), handle, data) {
                FED_THIS_CRANK.with(|f| f.borrow_mut().insert(handle));
            }
        });
        Outcome::default()
    });
    if let Err(msg) = result {
        set_result_string(the, &msg);
    }
}

/// The descriptor of every hasher still open and fed since the last call,
/// for the transcript to record as of the crank's commit. A hasher fed past
/// the limit has none and is re-seated as broken.
pub(crate) fn take_redescriptions() -> Vec<(u32, Option<Descriptor>)> {
    let fed = FED_THIS_CRANK.with(|f| std::mem::take(&mut *f.borrow_mut()));
    HASHER_MAP.with(|m| {
        let m = m.borrow();
        fed.into_iter()
            .filter_map(|handle| {
                let hasher = m.get(&handle)?;
                Some((handle, hasher.fed.as_deref().and_then(Descriptor::hasher)))
            })
            .collect()
    })
}

/// `sha256Update(handle, data) -> undefined`
///
/// Feeds data into an incremental SHA-256 hasher.
pub unsafe extern "C" fn host_sha256_update(the: *mut XsMachine) {
    crate::worker_io::guard_ffi(|| unsafe {
        let handle_slot = (*the).frame.sub(1);
        let handle = fxToInteger(the, handle_slot) as u32;
        abort_if_ffi_panicked();
        let data = arg_str(the, 1);
        feed(the, "sha256Update", handle, data.as_bytes());
    });
}

/// `sha256UpdateBytes(handle, uint8Array) -> undefined`
///
/// Feeds binary data (Uint8Array) into an incremental SHA-256 hasher.
/// This bypasses the slow TextDecoder path used by `sha256Update`.
pub unsafe extern "C" fn host_sha256_update_bytes(the: *mut XsMachine) {
    crate::worker_io::guard_ffi(|| unsafe {
        let handle_slot = (*the).frame.sub(1);
        let handle = fxToInteger(the, handle_slot) as u32;
        abort_if_ffi_panicked();
        let data_slot = (*the).frame.sub(2);
        if let Some(buf) = crate::worker_io::read_typed_array_bytes(the, data_slot) {
            feed(the, "sha256UpdateBytes", handle, &buf);
        }
    });
}

/// `sha256Finish(handle) -> string`
///
/// Finalizes the incremental SHA-256 hasher and returns the hex digest.
/// The handle is consumed and cannot be reused.
pub unsafe extern "C" fn host_sha256_finish(the: *mut XsMachine) {
    crate::worker_io::guard_ffi(|| unsafe {
        let handle_slot = (*the).frame.sub(1);
        let handle = fxToInteger(the, handle_slot) as u32;
        abort_if_ffi_panicked();
        let request = handle.to_string().into_bytes();
        let result = host_ledger::call("sha256Finish", Some(handle), &request, || {
            let text = match HASHER_MAP.with(|m| m.borrow_mut().remove(&handle)) {
                Some(hasher) => hex::encode(hasher.sha256.finalize()),
                None => "Error: invalid hasher handle".to_string(),
            };
            set_result_string(the, &text);
            Outcome {
                closes: !text.starts_with("Error"),
                reply: text.into_bytes(),
                ..Outcome::default()
            }
        });
        if let Err(msg) = result {
            set_result_string(the, &msg);
        }
    });
}

/// Native handles cannot be serialized with the XS heap.
/// Drop every open hasher handle.
pub(crate) fn drop_open_handles() {
    HASHER_MAP.with(|map| map.borrow_mut().clear());
    FED_THIS_CRANK.with(|fed| fed.borrow_mut().clear());
}

pub(crate) fn has_open_handles() -> bool {
    HASHER_MAP.with(|map| !map.borrow().is_empty())
}

/// Rebuild a hasher from its descriptor by re-feeding its recorded bytes.
pub(crate) fn reseat(handle: u32, descriptor: &Descriptor) -> Result<(), String> {
    let fed = descriptor.hasher_fed().ok_or("not a hasher descriptor")?;
    HASHER_MAP.with(|m| m.borrow_mut().insert(handle, Hasher::new(Some(fed))));
    Ok(())
}

/// Every callback in [`CALLBACKS`], by guest name, with its host-call
/// classification.
pub const CLASSES: &[(&str, HostClass)] = &[
    ("sha256", HostClass::Pure),
    ("randomHex256", HostClass::Read),
    ("randomFillBytes", HostClass::Read),
    ("ed25519Keygen", HostClass::Read),
    ("ed25519Sign", HostClass::Pure),
    ("sha256Init", HostClass::Read),
    ("sha256Update", HostClass::Read),
    ("sha256UpdateBytes", HostClass::Read),
    ("sha256Finish", HostClass::Read),
    ("sha256Bytes", HostClass::Pure),
];

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

    /// Retention stops at the aggregate limit across hashers, flipping only
    /// the hasher whose byte crosses it, and only at the crossing.
    #[test]
    fn hashers_stop_retaining_exactly_at_the_aggregate_limit() {
        let per = host_ledger::HASHER_DESCRIPTOR_LIMIT;
        let full = host_ledger::HASHERS_RETAINED_LIMIT / per;
        assert_eq!(full * per, host_ledger::HASHERS_RETAINED_LIMIT);
        let mut hashers = HashMap::new();
        for handle in 0..full as u32 {
            hashers.insert(handle, Hasher::new(Some(vec![1; per - 1])));
        }
        let (last, spare) = (full as u32 - 1, full as u32);
        hashers.insert(spare, Hasher::new(Some(Vec::new())));
        // One byte short of the aggregate limit: `full - 1` more bytes fill it.
        for handle in 0..last {
            assert!(update(&mut hashers, handle, &[2]));
        }
        let retained = |h: &HashMap<u32, Hasher>| -> usize {
            h.values().filter_map(|h| h.fed.as_ref().map(Vec::len)).sum()
        };
        assert_eq!(retained(&hashers), host_ledger::HASHERS_RETAINED_LIMIT - 1);
        assert!(update(&mut hashers, spare, &[3]));
        assert_eq!(retained(&hashers), host_ledger::HASHERS_RETAINED_LIMIT);
        assert_eq!(hashers[&spare].fed.as_deref(), Some(&[3][..]));
        // At the limit, the next byte breaks the hasher it is fed to alone.
        assert!(update(&mut hashers, last, &[4]));
        assert!(hashers[&last].fed.is_none());
        assert!(hashers[&spare].fed.is_some());
        assert!((0..last).all(|h| hashers[&h].fed.as_ref().map(Vec::len) == Some(per)));
        // A broken hasher still hashes but no longer needs restaging.
        assert!(!update(&mut hashers, last, &[5]));
    }

    #[test]
    fn worker_panic_does_not_expose_hasher_state_to_siblings() {
        std::thread::spawn(|| {
            crate::worker_io::guard_ffi(|| {
                HASHER_MAP.with(|hashers| {
                    let mut hashers = hashers.borrow_mut();
                    hashers.insert(42, Hasher::new(None));
                    std::thread::spawn(|| {
                        HASHER_MAP.with(|hashers| {
                            assert!(!hashers.borrow().contains_key(&42));
                            let mut hashers = hashers.borrow_mut();
                            hashers.insert(42, Hasher::new(None));
                            hashers.get_mut(&42).unwrap().sha256.update(b"sibling");
                            assert_eq!(
                                hashers.remove(&42).unwrap().sha256.finalize(),
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
