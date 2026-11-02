---
"@endo/floot": patch
---

Default implementation deadlines to Infinity, creating no timer and consuming no
review rounds for elapsed time. Allow trusted workflow setup to opt into a finite
`implementationTimeoutMs` through chart construction or dev-review provisioning.
Existing factories and runs retain their saved chart policy.
