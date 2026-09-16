---
'ses': patch
---

Fixed `lockdown()` to no longer emit spurious `intrinsics` warnings when auditing the WHATWG `URL` / `URLSearchParams` family of globals on Node.js — both the blob-registry statics' undeletable `.prototype` and the non-standard `nodejs.util.inspect.custom` symbol on the URL-family prototypes (verified on Node.js 22 and 24, the versions this package's CI exercises; unverified on Node.js 26, though the same V8 `URL` implementation is expected to hold).
No behavior change — the lockdown report is simply quieter and remains fully accurate.
