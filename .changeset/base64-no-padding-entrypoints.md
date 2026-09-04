---
'@endo/base64': minor
'@endo/capn-web': patch
---

Add `@endo/base64/no-padding-encode` and
`@endo/base64/no-padding-decode` entry points for protocols that omit Base64's
canonical trailing padding. The decoder accepts both padded and unpadded input.

Use these shared codecs for Cap'n Web byte values instead of adapting canonical
Base64 inside `@endo/capn-web`.
