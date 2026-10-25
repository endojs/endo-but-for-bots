---
'@endo/exo-git': minor
---

Add `splitGitCapabilityUrl`, exported from the new
`@endo/exo-git/src/git-remote-policy.js` subpath, which splits a git capability URL
(`https://x-access-token:<token>@host/<partition>`) into a credential-free
endpoint `url` plus the `audience`, `username`, and `password` that
`provideBasicCredential` takes, so a host can adopt the URL as a `GitRemote`
without the token reaching the daemon's formulas or a git process's argv.

`normalizeGitRemoteUrl` no longer echoes a rejected URL's credentials.
An embedded-credentials rejection prints the URL with its userinfo replaced
by `***`, a non-`https:` rejection prints only the scheme, and an unparseable
URL is not printed at all.
