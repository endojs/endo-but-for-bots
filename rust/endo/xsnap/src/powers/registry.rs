//! Narrow package-registry and CAS-tree host powers for the XS manager.
//!
//! The public JavaScript capability is still the guarded directory tree in
//! `@endo/exo-npm`. These callbacks are an in-process implementation seam
//! between that adapter and Endor's Rust registry mechanics.

use crate::ffi::*;
use crate::powers::HostPowers;
use crate::worker_io::{arg_str, set_result_string};
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RegistryHostErrorKind {
    NotFound,
    Offline,
    Tampered,
    Backend,
}

#[derive(Clone, Debug, Serialize)]
pub struct RegistryHostError {
    pub kind: RegistryHostErrorKind,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryPackageLeaf {
    pub tree_hash: String,
    pub integrity: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryTreeEntry {
    pub kind: String,
    pub hash: String,
    pub size: Option<u64>,
}

/// Host-owned implementation. The trait is intentionally synchronous: XS
/// and the Rust manager share one thread, while Endor's existing HTTP client
/// is blocking and its SQLite/CAS operations are local.
pub trait RegistryHost: Send {
    fn has_package(&self, name: &str) -> bool;
    fn list_versions(&self, name: &str) -> Result<Vec<String>, RegistryHostError>;
    fn provide_package_tree(
        &self,
        name: &str,
        version: &str,
    ) -> Result<RegistryPackageLeaf, RegistryHostError>;
    fn list_tree(&self, tree_hash: &str) -> Result<Vec<String>, RegistryHostError>;
    fn lookup_tree(
        &self,
        tree_hash: &str,
        name: &str,
    ) -> Result<RegistryTreeEntry, RegistryHostError>;
    fn read_blob(&self, hash: &str) -> Result<Vec<u8>, RegistryHostError>;
}

#[derive(Serialize)]
#[serde(untagged)]
enum HostEnvelope<T: Serialize> {
    Ok { ok: bool, value: T },
    Err { ok: bool, error: RegistryHostError },
}

fn encode<T: Serialize>(result: Result<T, RegistryHostError>) -> String {
    let envelope = match result {
        Ok(value) => HostEnvelope::Ok { ok: true, value },
        Err(error) => HostEnvelope::Err { ok: false, error },
    };
    serde_json::to_string(&envelope).unwrap_or_else(|error| {
        format!(
            "{{\"ok\":false,\"error\":{{\"kind\":\"backend\",\"message\":{}}}}}",
            serde_json::to_string(&error.to_string())
                .unwrap_or_else(|_| "\"serialization failure\"".to_string())
        )
    })
}

fn unavailable() -> RegistryHostError {
    RegistryHostError {
        kind: RegistryHostErrorKind::Offline,
        message: "registry host powers are unavailable".to_string(),
    }
}

unsafe fn registry_host(the: *mut XsMachine) -> Option<&'static dyn RegistryHost> {
    let powers = &*((*the).context as *const HostPowers);
    powers.registry.as_deref()
}

pub unsafe extern "C" fn host_registry_has_package(the: *mut XsMachine) {
    let name = arg_str(the, 0);
    let result = registry_host(the)
        .map(|host| host.has_package(&name))
        .ok_or_else(unavailable);
    set_result_string(the, &encode(result));
}

pub unsafe extern "C" fn host_registry_list_versions(the: *mut XsMachine) {
    let name = arg_str(the, 0);
    let result = registry_host(the)
        .ok_or_else(unavailable)
        .and_then(|host| host.list_versions(&name));
    set_result_string(the, &encode(result));
}

pub unsafe extern "C" fn host_registry_provide_package_tree(the: *mut XsMachine) {
    let name = arg_str(the, 0);
    let version = arg_str(the, 1);
    let result = registry_host(the)
        .ok_or_else(unavailable)
        .and_then(|host| host.provide_package_tree(&name, &version));
    set_result_string(the, &encode(result));
}

pub unsafe extern "C" fn host_registry_list_tree(the: *mut XsMachine) {
    let tree_hash = arg_str(the, 0);
    let result = registry_host(the)
        .ok_or_else(unavailable)
        .and_then(|host| host.list_tree(&tree_hash));
    set_result_string(the, &encode(result));
}

pub unsafe extern "C" fn host_registry_lookup_tree(the: *mut XsMachine) {
    let tree_hash = arg_str(the, 0);
    let name = arg_str(the, 1);
    let result = registry_host(the)
        .ok_or_else(unavailable)
        .and_then(|host| host.lookup_tree(&tree_hash, &name));
    set_result_string(the, &encode(result));
}

pub unsafe extern "C" fn host_registry_read_blob(the: *mut XsMachine) {
    use base64::Engine;
    let hash = arg_str(the, 0);
    let result = registry_host(the)
        .ok_or_else(unavailable)
        .and_then(|host| host.read_blob(&hash))
        .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes));
    set_result_string(the, &encode(result));
}

/// Appended to the stable snapshot callback table. Registration is
/// unconditional even when no registry implementation is installed so a
/// restored worker and a fresh manager agree on callback indexes.
pub const CALLBACKS: &[crate::ffi::XsCallback] = &[
    host_registry_has_package,
    host_registry_list_versions,
    host_registry_provide_package_tree,
    host_registry_list_tree,
    host_registry_lookup_tree,
    host_registry_read_blob,
];

pub unsafe fn register(machine: &crate::Machine) {
    machine.define_function("registryHasPackage", host_registry_has_package, 1);
    machine.define_function("registryListVersions", host_registry_list_versions, 1);
    machine.define_function(
        "registryProvidePackageTree",
        host_registry_provide_package_tree,
        2,
    );
    machine.define_function("registryListTree", host_registry_list_tree, 1);
    machine.define_function("registryLookupTree", host_registry_lookup_tree, 2);
    machine.define_function("registryReadBlob", host_registry_read_blob, 1);
}
