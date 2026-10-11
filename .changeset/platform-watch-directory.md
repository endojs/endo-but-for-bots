---
'@endo/platform': minor
'@endo/daemon': patch
---

Factor the `watchDirectory` primitive out of `@endo/daemon`'s `makeFilePowers`
into `@endo/platform` as a node-fs adapter. `@endo/platform/fs/node/watch-directory`
exports `makeWatchDirectory(fs, options?)`, which returns a
`(dirPath, cancelled, options?) => AsyncIterable<{ kind, name }>` directory-name-change
watcher: an `fs.watch` wrapper with a per-filename debounce/coalesce window that
defaults to 50 ms and is configurable through an advisory `options.debounceMs` hint
(settable as a factory default or per call, threaded up through
`FilePowers.watchDirectory` and the mount so `followNameChanges` can tune it, and
free to be ignored by an implementation: the XS fallback ignores it),
best-effort `{ kind: 'add' | 'remove' | 'replace', name }` events (the `kind` is a
hint the consumer reconciles against its own snapshot set), and an
`fs.watch`-unavailable fallback that surfaces as an immediately-terminated stream.
Cancellation follows the accept-a-`cancelled`-promise idiom rather than a returned
`cancel()` function: settling the `cancelled` promise closes the OS watcher handle
and terminates the stream, and the returned async iterator is additionally
cancellable through its own `return()`. The daemon's `FilePowers.watchDirectory`
delegates to this adapter; the observable behavior of `EndoMount.followNameChanges`
is unchanged except that a `followNameChanges` subscription is now also torn down
when the mount formula itself is cancelled (the mount threads `context.cancelled`
into every watcher it opens). The primitive's unit coverage moves to
`@endo/platform`; the daemon retains the end-to-end `followNameChanges` integration
coverage.

Each node-fs adapter also gains a dedicated subpath export
(`@endo/platform/fs/node/local-tree`, `.../local-blob`, `.../tree-writer`,
`.../watch-directory`); the aggregate `@endo/platform/fs/node` barrel is retained
alongside them.
