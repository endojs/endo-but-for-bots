---
"@endo/lal": patch
---

Retry subscription inference overloads after ignored response metadata events.
Report the first retry fence, sanitized event type, and inference attempt number
without logging response content or identifiers.
