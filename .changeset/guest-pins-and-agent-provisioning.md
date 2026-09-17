---
'@endo/daemon': minor
---

Introduce caller-elected pins, networks, and special/pet names for freshly
provisioned hosts and guests.

- `provideHost`/`provideGuest` (`makeGuest`/`makeChildHost`) accept `pins` and
  `networks` options. A guest gains a guest-visible, guest-mutable `@pins`
  directory distinct from a host-only pin directory retained by the guest
  formula (a connected agent the guest cannot inadvertently delete). The
  `networks` option accepts a caller-selected directory to expose as the agent's
  `@nets`.
- Pin directories are reincarnated on every mail delivery
  (`reincarnateMailboxPins`), best-effort (`Promise.allSettled`), before the
  message-received notification — keeping an explicitly pinned agent live across
  a daemon restart or a mid-life worker cancellation.
- Add `NameHub.listValues()`, an atomic snapshot of a directory's immediate
  values (used by pin reincarnation).
- The formula inspector surfaces the new guest `guestPins`/`hostPins`/`networks`/
  `planes` references and the host `registry` reference.
