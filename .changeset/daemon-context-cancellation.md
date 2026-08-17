---
'@endo/daemon': patch
---

Ensure daemon context disposal runs every cancellation hook and reports all
failures, and immediately cancel dependents registered after their dependency.
