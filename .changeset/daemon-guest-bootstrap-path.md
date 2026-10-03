---
'@endo/daemon': minor
---

Add `EndoBootstrap.guestBootstrapPath(id)`, which serves one local guest on its own private Unix socket and returns the path.
The socket's CapTP bootstrap is the guest facet itself, so a connection to it reaches that guest and carries no host authority.
Issuing again for the same guest returns the same path.
The socket lives until the daemon stops or the guest is collected; collecting the guest also removes the pathname and closes the connections made on it.
The Node daemon serves guest sockets in a `0700` directory beside its own socket.
On Windows, where named pipes have no private directory, `guestBootstrapPath` resolves to `undefined`; the Go and Rust supervisors serve none.
