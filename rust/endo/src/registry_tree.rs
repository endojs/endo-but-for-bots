//! Endor mechanics adapter for the shared package-registry tree.
//!
//! This is deliberately a narrow host-power seam, not a second public
//! registry API. The XS-hosted JavaScript adapter in `@endo/exo-npm` consumes
//! these three operations (`has_package`, `list_versions`, and
//! `provide_package_tree`) and presents the same guarded tree Exos as Node.

use crate::cas::ContentStore;
use crate::fetch::{fetch_metadata_cached, fetch_package, FetchError, HttpClient};
use crate::npmrc::NpmConfig;
use crate::registry::RegistryTable;
use crate::semver::Version;

/// Exact-version leaf information projected into the XS adapter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RegistryVersionLeaf {
    pub tree_hash: String,
    pub integrity: Option<String>,
}

/// Contract failures the XS adapter maps to the shared JS error family.
#[derive(Debug)]
pub enum RegistryTreeError {
    NotFound(String),
    Offline(String),
    Tampered(String),
    Backend(FetchError),
}

impl std::fmt::Display for RegistryTreeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RegistryTreeError::NotFound(path) => write!(formatter, "not found: {path}"),
            RegistryTreeError::Offline(path) => write!(formatter, "offline: {path}"),
            RegistryTreeError::Tampered(message) => write!(formatter, "tampered: {message}"),
            RegistryTreeError::Backend(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for RegistryTreeError {}

fn map_fetch_error(error: FetchError, path: &str) -> RegistryTreeError {
    match error {
        FetchError::Offline { .. } => RegistryTreeError::Offline(path.to_string()),
        FetchError::VersionMissing { .. } | FetchError::PackageMissing { .. } => {
            RegistryTreeError::NotFound(path.to_string())
        }
        FetchError::IntegrityMismatch { .. } | FetchError::UnsupportedIntegrity(_) => {
            RegistryTreeError::Tampered(error.to_string())
        }
        other => RegistryTreeError::Backend(other),
    }
}

/// Narrow Rust powers consumed by `makeEndorNpmRegistryTree` inside XS.
pub struct EndorRegistryTreeAdapter<'a, H: HttpClient + ?Sized> {
    http: &'a H,
    cas: &'a ContentStore,
    registry_table: &'a RegistryTable,
    config: NpmConfig,
}

impl<'a, H: HttpClient + ?Sized> EndorRegistryTreeAdapter<'a, H> {
    pub fn new(
        http: &'a H,
        cas: &'a ContentStore,
        registry_table: &'a RegistryTable,
        registry_url: &str,
    ) -> Self {
        Self::with_config(
            http,
            cas,
            registry_table,
            NpmConfig::with_registry(registry_url),
        )
    }

    /// Construct with the complete npm configuration so scoped registries
    /// and credentials keep following the same routing rules as Endor's
    /// resolver and fetch commands.
    pub fn with_config(
        http: &'a H,
        cas: &'a ContentStore,
        registry_table: &'a RegistryTable,
        config: NpmConfig,
    ) -> Self {
        Self {
            http,
            cas,
            registry_table,
            config,
        }
    }

    /// No-throw membership probe. An offline undecidable result folds to
    /// false; callers needing absent-vs-offline use the listing/lookup path.
    pub fn has_package(&self, name: &str) -> bool {
        self.list_versions(name)
            .map(|versions| !versions.is_empty())
            .unwrap_or(false)
    }

    /// Cached-or-live published exact versions in ascending semver order.
    pub fn list_versions(&self, name: &str) -> Result<Vec<String>, RegistryTreeError> {
        let registry_url = self.config.registry_for(name);
        let metadata = fetch_metadata_cached(self.http, self.registry_table, registry_url, name)
            .map_err(|error| map_fetch_error(error, name))?;
        let document: serde_json::Value = serde_json::from_slice(&metadata).map_err(|error| {
            RegistryTreeError::Backend(FetchError::BadMetadata(error.to_string()))
        })?;
        let versions = document
            .get("versions")
            .and_then(serde_json::Value::as_object)
            .ok_or_else(|| RegistryTreeError::NotFound(name.to_string()))?;
        let mut names: Vec<String> = versions.keys().cloned().collect();
        // Total order across the mixed set: parseable versions sort by semver
        // and strictly before any unparseable spelling, which then sort
        // lexicographically among themselves. A per-pair `left.cmp(right)`
        // fallback would be intransitive, which `sort_by` may resolve into an
        // arbitrary order driven by registry-supplied key order.
        names.sort_by(
            |left, right| match (Version::parse(left), Version::parse(right)) {
                (Some(left_version), Some(right_version)) => left_version.cmp(&right_version),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => left.cmp(right),
            },
        );
        Ok(names)
    }

    /// Existing idempotent fetch/integrity/CAS/table path for one exact leaf.
    pub fn provide_package_tree(
        &self,
        name: &str,
        version: &str,
    ) -> Result<RegistryVersionLeaf, RegistryTreeError> {
        let path = format!("{name}@{version}");
        let registry_url = self.config.registry_for(name);
        let result = fetch_package(
            self.http,
            self.cas,
            self.registry_table,
            registry_url,
            name,
            version,
        )
        .map_err(|error| map_fetch_error(error, &path))?;
        Ok(RegistryVersionLeaf {
            tree_hash: result.tree_hash,
            integrity: result.integrity,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MetadataClient {
        metadata: Vec<u8>,
    }

    impl HttpClient for MetadataClient {
        fn get_metadata(&self, _url: &str) -> Result<Vec<u8>, FetchError> {
            Ok(self.metadata.clone())
        }

        fn get_tarball(&self, url: &str) -> Result<Vec<u8>, FetchError> {
            Err(FetchError::Http(format!(
                "unexpected tarball request: {url}"
            )))
        }
    }

    #[test]
    fn lists_versions_in_semver_order_and_reuses_cached_exact_leaf() {
        let temporary = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(&temporary.path().join("cas")).unwrap();
        let table = RegistryTable::open_in_memory().unwrap();
        let registry_url = "https://registry.example/";
        let client = MetadataClient {
            metadata:
                br#"{"versions":{"2.0.0":{"dist":{}},"1.10.0":{"dist":{}},"1.2.0":{"dist":{}}}}"#
                    .to_vec(),
        };
        let tree_hash = cas.store_tree(br#"{"entries":{}}"#).unwrap();
        table
            .insert(
                registry_url,
                "fixture",
                "1.10.0",
                &tree_hash,
                Some("sha512-fixture"),
            )
            .unwrap();
        let adapter = EndorRegistryTreeAdapter::new(&client, &cas, &table, registry_url);

        assert_eq!(
            adapter.list_versions("fixture").unwrap(),
            vec!["1.2.0", "1.10.0", "2.0.0"]
        );
        assert!(adapter.has_package("fixture"));
        assert_eq!(
            adapter.provide_package_tree("fixture", "1.10.0").unwrap(),
            RegistryVersionLeaf {
                tree_hash,
                integrity: Some("sha512-fixture".to_string()),
            }
        );
    }

    #[test]
    fn offline_unknown_is_false_for_has_and_distinct_for_lookup() {
        let temporary = tempfile::tempdir().unwrap();
        let cas = ContentStore::open(&temporary.path().join("cas")).unwrap();
        let table = RegistryTable::open_in_memory().unwrap();
        let adapter = EndorRegistryTreeAdapter::new(
            &crate::fetch::OfflineClient,
            &cas,
            &table,
            "https://registry.example/",
        );
        assert!(!adapter.has_package("unknown"));
        assert!(matches!(
            adapter.list_versions("unknown"),
            Err(RegistryTreeError::Offline(_))
        ));
    }

    #[test]
    fn package_level_http_not_found_maps_to_tree_not_found() {
        assert!(matches!(
            map_fetch_error(
                FetchError::PackageMissing {
                    url: "https://registry.example/missing".to_string(),
                },
                "missing",
            ),
            RegistryTreeError::NotFound(path) if path == "missing"
        ));
    }

    #[test]
    fn integrity_failure_maps_to_tree_tampered() {
        assert!(matches!(
            map_fetch_error(
                FetchError::IntegrityMismatch {
                    expected: "sha512-expected".to_string(),
                    actual: "sha512-actual".to_string(),
                },
                "fixture@1.0.0",
            ),
            RegistryTreeError::Tampered(message) if message.contains("integrity mismatch")
        ));
    }
}
