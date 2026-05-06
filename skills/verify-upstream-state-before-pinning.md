# Verify upstream state before pinning external deps

## Trigger

A reviewer (or your own dispatch) asks you to pin an external
dependency to a specific version, capture a sha256, or
otherwise embed metadata about an upstream artifact.

## Why

Dispatching prompts and reviewer suggestions often quote a
version or release date the agent guessed from training data,
not from a fresh fetch of the upstream. The guessed value is
frequently months stale. Committing the guess ships wrong
metadata in a workflow's documentation comments and can
silently mismatch a download cache.

## What to do

1. Fetch the upstream's directory listing or release page
   yourself. `curl`, `gh release list`, or the project's
   downloads index, depending on the source.
2. Read the actual current release: name, date, URL, sha256.
3. Compute the sha256 from a fresh download
   (`curl -fsSL <url> | sha256sum`); do not trust a sha256
   from elsewhere.
4. Embed the version and sha256 as workflow-level env vars so
   a future bump is a two-line change.
5. Key any download cache by both the version AND the sha256
   so a stale blob cannot shadow a version bump.
6. Cite the verification source in the commit message body
   (the directory listing URL, the release page).

## Session example

PR 82 received a follow-up commit promoting a pinned Guix
release to the primary install path. The dispatching prompt
guessed the version had shipped in 2025-04; the upstream
directory listing showed 2026-01-22. The prompt-claimed sha256
placeholder had to be replaced with the value computed by
downloading and hashing the tarball locally.
