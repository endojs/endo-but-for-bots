# Legacy Claude topology retirement

The inbox-form factory, sidecar-file credential factory, and client formula are
planned removal candidates, not the topology used by current hosted sessions.
The current entrypoints are `setup-host.js` and `setup-hosted.js`.
Source deletion is pending explicit approval; the files and their old tests remain.

## Deployment gate

Deleting source is not proof that retained daemon formulas or native resources stopped.
Before deploying this removal, inventory and stop legacy clients while their old release
is still available; verify container, 9P mount, listener, and credential-grant cleanup.
Retire legacy formula bindings only after cleanup, or stop native work before resetting
disposable daemon state.
Preserve Secrets blobs, current subscription renewal owners, and retained workspaces.
No runtime retirement, source deletion, or disk deletion is performed by this preparation.

## Coverage to retain when removing the old entrypoints

| Removed coverage | Current coverage or explicit retirement |
| --- | --- |
| Static powers retain exact dependency identities across rebinding, restart, and GC | `daemon/test/endo.test.js`, static dependency bundle test, using `_dependency-bundle.js` rather than a production legacy module |
| A remote presence cannot be stored directly, but send/adopt makes it endowable by name | `daemon/test/endo.test.js`, adopted remote capability test |
| Session startup, MCP mount confinement, credential placeholders | `test/claude-native-controller.test.js`, activation and credential-kind tests |
| Cancellation before/during acquisition, context loss, ordered teardown, failed cleanup retry | `test/claude-native-controller.test.js` and shared session supervisor tests |
| CLI stream parsing and actual slice/9P edges | Retained `test/claude-client.test.js`, `test/integration.test.js`, `test/ninep-flow.test.js` |
| Filesystem bridge authority, read-only propagation, failed mount cleanup | Retained `test/container-mount-bridge.test.js` |
| Floot attach persistence, restart/rollback, and bridge ownership | Retained `floot/test/container-mounts.test.js` and `container-mounts-hosted.test.js` |
| Successful arbitrary `/mnt` binds through the old client formula | Not a current Claude backend capability; current backend refuses `containerMounts`, covered in `test/claude-backend-factory.test.js` |
| Inbox forms, credential sidecar creation/materialization, old client formula reincarnation | Intentionally retired; these are not APIs the current native controller implements |

The legacy Floot `container-mounts-sandbox` test exercises successful attachments through
the old client formula, not through today's hosted backend.
Do not interpret a future removal as claiming that native Claude arbitrary attachments work.
Adding those requires a recorded plan, authorized mount rows, and attestation coverage
before the current backend's refusal can be removed.
