---
'ses': patch
---

Fixed `lockdown()` to no longer emit spurious `intrinsics` warnings when auditing the WHATWG `URL` / `URLSearchParams` globals on Node.js (verified on 22 and 24, and expected to hold on 26, which shares the same V8 `URL` implementation).
No behavior change — the lockdown report is simply quieter and remains fully accurate.
