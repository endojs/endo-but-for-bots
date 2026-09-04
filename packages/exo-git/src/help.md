# Git - A repository capability for reading and changing a Git worktree.

A Git capability is minted in one of three cumulative postures.
A reader may only observe the repository, a writer may also stage and
commit, and a rewriter may additionally rewrite existing history.
Whichever facet you hold *is* your authority: a method that the posture
does not carry is absent, not merely rejecting.

Use readOnly() or scope(name) to hand out a weaker facet of the same
repository, worktree() for the filesystem authority, and filesystemAt(ref)
for a read-only view of a historical revision.

## help(methodName?) -> string

Get documentation for this interface or a specific method.
- help() returns an overview of the interface
- help("commit") returns documentation for the commit method

## worktree() -> Promise<Worktree>

Get the filesystem authority for the working tree.
A writable Git returns its writable mount; a read-only Git returns a
structural read-only view of the same mount lineage.

## worktreeList() -> Promise<GitWorktreeEntry[]>

List the current repository and its linked worktrees.
Each `path` is relative to this Git mount, with `.` naming the current mount
root.
Entries report their optional `head` and `branch`, and whether they are
`bare`, `detached`, `locked`, or `prunable`.

## worktreeAdd(entry, options?) -> Promise<Git>

Create a linked worktree beneath this Git mount and return a Git capability for
the new checkout.
The `entry` must be a PathEntry minted by this Git's worktree mount.
Options are `ref` for the starting revision and `newBranch` to create and
check out a branch.
The returned Git preserves the creating facet's authority posture.

## status(options?) -> Promise<GitStatusResult>

List paths whose index or worktree state differs from HEAD.
Options are `untracked` ("all", "normal", or "no") and `maxCount`.
The result carries `entries` and a `truncated` flag.

## trackingStatus() -> Promise<GitTrackingStatus>

Report how the current branch relates to its upstream.
Yields `branch`, `upstream`, `ahead`, `behind`, and `detached`.

## currentBranch() -> Promise<GitRef | undefined>

Get the branch HEAD currently points at.
Returns undefined when HEAD is detached.

## branches() -> Promise<GitRef[]>

List the repository's branches as refs.

## diff(options?) -> Promise<string>

Render a textual diff.
Options are `cached`, `base`, `head`, and either `entries` (PathEntry
capabilities minted for this worktree) or `paths`.

## log(options?) -> Promise<GitCommit[]>

List commits, most recent first.
Options are `ref`, `maxCount`, `since`, and `until`.

## show(ref) -> Promise<string>

Render one revision as text, the way `git show` does.

## revParse(ref) -> Promise<GitRef>

Resolve a revision expression to a concrete ref with its object id.
- revParse("HEAD") resolves the current commit

## stashList() -> Promise<string[]>

List the stash entries, most recent first.

## stashShow(index?) -> Promise<string>

Render the diff held by one stash entry.
Defaults to the most recent entry.

## tree(ref) -> Promise<GitTree>

Get a read-only GitTree over the tree a revision resolves to.
Nested trees resolve to further GitTree values and files to readable
blobs.
Prefer filesystemAt(ref) for general historical reads.

## filesystemAt(ref) -> Promise<Filesystem>

Get a read-only Filesystem pinned to the tree a revision resolves to.
Later movement of the ref does not affect the returned view, and two
revisions with the same tree share one memoized capability.

## followRootChanges(options?) -> PassableReader<GitRootChange>

Follow every published commit that replaces the repository root.
The first value is a snapshot of the current commit, or `position: null` for
an unborn repository. Later values are chained transitions carrying the commit
object id, complete-tree identity, and an immutable filesystem rooted at that
tree. A rejected `options.cancelled` promise closes only this follower.

## followLatestRoot(options?) -> PassableReader<GitRootSnapshot>

Follow the latest published repository root with bounded retention.
The first value is the current snapshot. A slow reader may skip intermediate
commits and observes the skipped range as a revision jump. A rejected
`options.cancelled` promise closes only this follower.

## readOnly() -> Git

Attenuate to the read-only facet of this same repository.
Every facet of one Git instance returns the identical reader reference.

## scope(name) -> Git

Downscope to a sibling facet of this same Git instance.
The vocabulary is closed and never escalates: a reader accepts only
"reader", a writer also "writer", and a rewriter also "rewriter".

## add(entries) -> Promise<void>

Stage the given PathEntry capabilities.
An entry minted by a different mount lineage is rejected before any path
reaches git.

## restore(entries, options?) -> Promise<void>

Restore the given paths from the index, or with `staged: true` restore
the index entries themselves from HEAD.

## checkoutConflict(entries, side) -> Promise<void>

Resolve conflicted paths by taking one side of the merge.
`side` is "ours" or "theirs".

## commit(message, options?) -> Promise<GitCommit>

Record a commit from the staged index.
Amending is history rewriting: `amend: true` is accepted only by the
rewriter facet, whose guard admits it.

## createBranch(name, options?) -> Promise<GitRef>

Create a branch.
Options are `startPoint` and `switchAfterCreate`.

## deleteBranch(name, options?) -> Promise<void>

Delete a branch.
`force: true` deletes a branch that is not fully merged.

## renameBranch(from, to) -> Promise<void>

Rename a branch.

## switchBranch(name) -> Promise<void>

Check out an existing branch by name, leaving HEAD attached to it.

## switch(ref) -> Promise<void>

Check out a revision.

## detach(ref) -> Promise<void>

Check out a revision with HEAD detached.

## merge(ref, options?) -> Promise<string>

Merge a revision into the current branch.
`fastForwardOnly: true` refuses anything but a fast-forward;
`noFastForward: true` always records a merge commit.

## stashPush(options?) -> Promise<string>

Stash worktree changes and return the resulting stash reference.
Options are `message`, `includeUntracked`, and either `entries` or
`paths`.

## stashApply(index?) -> Promise<void>

Apply a stash entry without removing it from the stash.

## stashPop(index?) -> Promise<void>

Apply a stash entry and drop it from the stash.

## stashDrop(index?) -> Promise<void>

Discard a stash entry without applying it.

## reword(ref, message) -> Promise<GitCommit>

Replace the message of an existing commit.
This rewrites history, so only the rewriter facet carries it.

## cherryPick(ref, options?) -> Promise<string>

Apply the changes of an existing commit onto the current branch.
`noCommit: true` leaves the result staged instead of committing it.
Only the rewriter facet carries this method.

## rebase(input) -> Promise<string>

Drive a rebase one step at a time.
`{ mode: "start", upstream, autosquash? }` begins one; `{ mode:
"continue" | "abort" | "skip" }` advances or ends the one in progress.
Only the rewriter facet carries this method.

# GitTree - A read-only view of one Git tree object.

A GitTree is content-addressed and immutable: it is pinned to the tree
object id it was minted for, so later ref movement never changes what it
reports.
Nested trees resolve to further GitTree values; files resolve to readable
blobs.

## help(methodName?) -> string

Get documentation for this interface or a specific method.
- help() returns an overview of the interface
- help("lookup") returns documentation for the lookup method

## archiveLossless() -> Promise<boolean>

Report whether a tar archive of this tree round-trips losslessly.
False when the tree holds entries tar cannot represent faithfully.

## archiveTar() -> PassableBytesReader

Stream this tree as a tar archive.
Each call starts a fresh `git archive` and returns a reader over its
bytes.

## has(...path) -> Promise<boolean>

Check whether a path exists in this tree.
- has() is true for the tree itself
- has("src", "index.js") checks a nested path

## list(...path?) -> Promise<string[]>

List the entry names of this tree or of a nested subtree.
- list() lists this tree
- list("src") lists the "src" subtree

## lookup(pathOrSegments) -> Promise<GitTree | ReadableBlob>

Resolve a path to the tree or blob it names.
Accepts a single segment string or an array of segments.
A submodule entry is not readable and is rejected.

# GitBlob - A read-only view of one Git blob object.

A GitBlob is content-addressed and immutable: it is pinned to the blob
object id it was minted for, so later ref movement never changes its bytes.
It provides whole-value convenience reads together with the range-I/O
surface used by content-addressed readers.

## help(methodName?) -> string

Get documentation for this interface or a specific method.
- help() returns an overview of the interface
- help("fetch") returns documentation for the fetch method

## streamBase64(syndicationPromise) -> Promise

Stream the blob's bytes as base64-encoded chunks.
The syndication promise drives the reader-pump flow-control protocol.

## text() -> Promise<string>

Read the complete blob as UTF-8 text.

## json() -> Promise<unknown>

Read the complete blob as UTF-8 text and parse it as JSON.

## getInfo() -> Promise<{ algorithm, hash, size }>

Get the blob's content-address identity and byte length.
The result carries `algorithm` ("sha256"), a base64 `hash`, and `size` as a
bigint.

## fetch(offset, length) -> Promise<PassableBytesReader>

Read a byte window from the blob.
The range is `[offset, offset + length)`, clamped at end of file.

# GitRemote - A policy-bound remote fetch, pull, and push capability.

A GitRemote carries a fixed remote URL and a normalized policy: which
directions are allowed, which refspecs may be fetched or pushed, and
whether tags, deletes, and force pushes are permitted.
The URL and refspecs are never taken from the caller; the policy supplies
them, and the controller is the only way to change it.

Every operation checks the policy afresh, so a policy change or a
revocation invalidates work already in flight.

## help(methodName?) -> string

Get documentation for this interface or a specific method.
- help() returns an overview of the interface
- help("push") returns documentation for the push method

## inspect() -> Promise<RemoteSnapshot>

Read the remote's name, URL, and current policy.
Throws once the remote has been revoked.

## credentialHealth() -> Promise<RemoteCredentialHealth>

Report whether the credential this remote would push with is usable,
without using it.
A credential holds its material in process memory, so a daemon restart
leaves the record unavailable and the next push would otherwise be the
first thing to say so.
`required: false` is the whole answer for a remote that needs no
credential; otherwise the result carries `kind`, `audience`, `available`,
and `revoked`.
`revoked: true` means "unusable until rotated", not "an operator
deliberately revoked this": a credential rebuilt after a restart starts out
revoked too, so this reports whether the credential works and never why it
does not.
This reports health only and never the credential material, which is why
it is separate from inspect(), whose snapshot is policy alone.
Throws once the remote has been revoked.

## fetch(options?) -> Promise<RemoteOperationResult>

Fetch the policy's fetch refspecs from the remote.
`prune: true` requires `allowDelete` and `tags: true` requires
`allowTags`.

## pull(options?) -> Promise<RemotePullResult>

Fetch and then integrate the result into the current branch.
`strategy` is "ff-only" (the default), "merge", or "rebase", and `branch`
must be a ref the fetch policy is allowed to populate.
The result reports the fetch, the integration kind, and the new head.

## push(options?) -> Promise<RemoteOperationResult>

Push to the remote under the policy's push refspecs.
Options are `source`, `destination`, `force`, `forceWithLease`, and
`setUpstream`; force pushing requires `allowForcePush`, and
`forceWithLease` names the object id the destination must still hold.

# GitRemoteController - The private policy and revocation controller for one GitRemote.

The controller is minted alongside its GitRemote and handed only to the
host, never to the holder of the remote.
It is the sole authority that can widen, narrow, or revoke the remote's
policy, and every change it makes is recorded in the audit log and
invalidates operations already in flight.

## help(methodName?) -> string

Get documentation for this interface or a specific method.
- help() returns an overview of the interface
- help("revoke") returns documentation for the revoke method

## inspect() -> Promise<RemoteControllerSnapshot>

Read the remote's current policy together with its revoked flag.

## audit() -> Promise<GitRemoteAuditEvent[]>

Read the append-only audit log of policy changes, revocations, and
operation outcomes for this remote.

## revoke() -> Promise<void>

Permanently revoke the remote.
Operations in flight are cancelled and every later operation is refused.

## setAllowedDirections(directions) -> Promise<void>

Set which directions the remote may run, as a subset of "fetch" and
"push".

## setFetchRefspecs(refspecs) -> Promise<void>

Replace the refspecs fetch() and pull() are allowed to fetch.

## setPushRefspecs(refspecs) -> Promise<void>

Replace the refspecs push() is allowed to push, clearing any
allowed-branch list.
Push refspecs and allowed branches are two spellings of the same policy;
setting one clears the other.

## setAllowedBranches(branches) -> Promise<void>

Restrict pushes to a named set of branches, clearing any push refspecs.

## setAllowForcePush(flag) -> Promise<void>

Permit or forbid force pushes, including `forceWithLease`.

## setAllowTags(flag) -> Promise<void>

Permit or forbid fetching and pushing tags.

## setAllowDelete(flag) -> Promise<void>

Permit or forbid deleting refs, including fetch pruning.

# GitCredentialController - The private controller for one Git credential.

The controller is minted alongside its credential and kept host-private.
It can inspect, rotate, and revoke the credential without ever exposing
the secret material, which the credential itself also never reveals.

## help(methodName?) -> string

Get documentation for this interface or a specific method.
- help() returns an overview of the interface
- help("rotate") returns documentation for the rotate method

## inspect() -> Promise<GitCredentialSnapshot>

Read the credential's kind and audience along with whether material is
currently available and whether it has been revoked.
The secret itself is never included.

## rotate(material) -> Promise<void>

Replace the secret material and clear the revoked flag.
A bearer credential takes `{ token }`; a basic credential takes
`{ username, password }`.

## revoke() -> Promise<void>

Revoke the credential and discard its material.
Remotes holding it stop being usable until it is rotated.

# BearerCredential - An audience-bound bearer token.

The token is held privately and is never exposed through this
capability; only the audience it is bound to can be read.
Rotation and revocation belong to the host-private
GitCredentialController minted alongside it.

## help(methodName?) -> string

Get documentation for this interface or a specific method.
- help() returns an overview of the interface
- help("audience") returns documentation for the audience method

## audience() -> string

Get the URL origin this credential may be used for.

# BasicCredential - An audience-bound username and password.

The username and password are held privately and are never exposed
through this capability; only the audience they are bound to can be read.
Rotation and revocation belong to the host-private
GitCredentialController minted alongside it.

## help(methodName?) -> string

Get documentation for this interface or a specific method.
- help() returns an overview of the interface
- help("audience") returns documentation for the audience method

## audience() -> string

Get the URL origin this credential may be used for.
