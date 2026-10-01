---
'@endo/daemon': minor
---

Add `EndoBootstrap.guestBootstrapPath(id)`, which serves one local guest on
its own private Unix socket and returns the path. The socket's CapTP
bootstrap is the guest facet itself, so a connection to it reaches that guest
and carries no host authority. Issuing again for the same guest returns the
same path; the socket lives until the daemon stops. The Node daemon serves
guest sockets in a `0700` directory beside its own socket; Windows named pipes
and the Go and Rust supervisors serve none.
