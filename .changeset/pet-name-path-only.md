---
'@endo/daemon': major
'@endo/cli': patch
'@endo/lal': patch
---

The daemon's Exo surface (host, guest, directory, mail, channel, and inspector
methods) now accepts only a pet-name path, an array of path components, where
it used to accept either a single pet-name string or a path. A bare string is
rejected with a `TypeError` that says the string is not a pet-name path, is
never split on a delimiter, and that the caller should try again with an array
of path components: `lookup(['counter'])`, not `lookup('counter')`, and
`lookup(['subdir', 'value'])`, not `lookup('subdir/value')`.

These methods are primarily geared toward agents, and agents are susceptible
to the same confusion as people. Accepting a string invites confusion about
whether the string may be a delimited path, and ambiguity about what the
delimiter is in the virtual file (and other capability) systems. Refusing the
string makes an agent that passed a delimited string learn that the invocation
was invalid and retry with an array of path components.

`NameOrPathShape` and `NamesOrPathsShape` in `@endo/daemon/type-guards.js`
are replaced by `NamePathArgumentShape` and `NamePathsArgumentShape`, and the
`NameOrPath` and `NamesOrPaths` types are removed in favor of `NamePath`. The
`endo` CLI already parses slash-delimited command-line names into arrays; the
`cancel`, `request`, `form`, and verbose `list` commands now do so too.
