---
'@endo/daemon': minor
'@endo/agentry': minor
'@endo/agent-tools': patch
---

Extend `EndoHost.provideGuest` with an immutable, host-validated named authority
graph for mounts, Git capabilities, and Git remotes.
The singular collections use their object keys as guest binding names, and all
Git and remote dependencies are explicit.
Repeated provide calls reacquire the retained guest without caller-held daemon
persistence and reject policy changes or widening.

Keep `@endo/agentry/code-mode-provisioning` as the connection- and Pi-aware
adapter that returns the authority-bearing guest and policy-derived inert
code-mode globals, using the same singular `mount`, `git`, and `gitRemote`
object-key convention.
Caller reconstruction state is now only a schema version and opaque guest
name; the owning host retains the policy and introduction map needed to rebuild
the projection for recovery and forks.
Remove the repository-local capability-plus-declaration grant abstraction.
