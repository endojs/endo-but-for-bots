---
'@endo/preact-container': minor
---

Make `confineComponent` a mutual-suspicion component boundary, so the same
primitive that confines an untrusted guest can also carry **trusted content
into an untrusted guest** — a reader's private petname for a party, a
timestamp in the viewer's timezone, a confirmation woven inside a
less-trusted flow. The host wraps its own function and hands the wrapper to a
confined guest as a prop; the guest may place it (`h(props.PetName, {
party })`) but cannot read it. Designate by reference (pass the party object,
resolve it through a host-held `WeakMap`) rather than a guessable id.

The enabling change is a single-flight diff-invocation gate on the `Confined`
wrapper: a confined component may now only be invoked by Preact's own diff.
Calling the wrapper directly — the move that would read its rendered output
as a plain value — returns `null`. This closes an exfiltration path that
existed whenever any code other than the host held a confined wrapper, and is
belt-and-braces for the ordinary case (nothing should read a confined
component's output as data). Normal rendering, including
`setState`-during-render, is unaffected.

No new public API. Also in this change: the privileged function surface
reachable from confined code (`Confined` wrappers and the opaque-child
sentinel type) is frozen (`harden` under lockdown) so it cannot be a writable
channel between mutually-suspicious parties; and `confineComponent` drops a
raw vnode passed through a non-`children` prop (such a vnode would hand the
receiver live component references via `vnode.type`). Dropping rather than
throwing is deliberate: the boundary runs in both directions, so a throw here
would be a guest-triggerable crash of the host render; dropping keeps a host
vnode from reaching a guest and a guest vnode from reaching trusted code, and
never crashes the render — matching the renderer's model, where disallowed
tags and attributes are dropped rather than fatal. Host content crosses as
`children` or as a confined component the guest places; function-valued props
remain allowed as deliberate capability grants. `fn`'s output is always
sanitized; use `HostPassthrough` if trusted content genuinely needs
un-sanitized output.
