---
'@endo/ocapn-noise': minor
'@endo/daemon': patch
---

OCapN-Noise transports now advertise a **priority-ordered list** of
connection hints instead of a single hint per transport. A transport
listener's `hints` is an ordered array of self-describing dial-URL
strings (each URL's scheme selects the transport), and a transport's
`connect(hint)` takes a single such URL. This lets one transport
advertise **multiple link-layer addresses** — e.g. both an IPv6 and an
IPv4 `tcp://` URL — with the network trying them in priority order until
one connects.

The `tcp` and `ws` transports now:

- **Prefer omitting a hint to advertising loopback.** A wildcard bind
  (`0.0.0.0` / `::`) enumerates routable, non-internal interface
  addresses (`node:os` `networkInterfaces()`) and advertises them
  **IPv6-first**; with no routable address it advertises an empty list
  rather than an undialable `127.0.0.1` / `::1`. A specific bind
  advertises that host as chosen.
- Expose a **pluggable public-IP discovery seam** — a `hosts` override
  and a `discoverHosts` callback whose results fold into the advertised
  priority list (the transports ship only the plug point, not STUN or
  any discovery mechanism).
- The `ws` transport carries a path on its dial URLs (default
  `/ocapn-cbor-np`, the gateway's canonical OCapN-CBOR-on-`np`
  endpoint).

**Wire-format note.** The OCapN `OcapnLocation.hints` component stays a
`Record<string, string>` (it is Syrup-serialized and signed via
`@endo/ocapn`'s dictionary-of-strings locator codec, and shared with the
other netlayers, so switching it to a raw array would be an OCapN-wide
codec/wire change). The ordered list is carried across it as a
**positional dictionary** — decimal-index keys (`'0'`, `'1'`, …) mapping
to dial-URL strings — with the order reconstructed from the numeric keys
on the reading side. The pet daemon's OCapN network (`@endo/daemon`)
reads the first `tcp:`-scheme URL out of that ordered list when building
its advertised address.
