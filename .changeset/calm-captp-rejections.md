---
'@endo/captp': minor
'@endo/agentry': patch
'@endo/daemon': patch
---

Give CapTP rejection observers structured context that distinguishes
promise-delivered application failures from disconnect and protocol failures.
Existing one-argument observers continue to receive the same error reasons.

Route daemon-backed Pi application rejections exclusively through their tool
promises while retaining one structured lifecycle diagnostic for an unexpected
connection or protocol failure.
