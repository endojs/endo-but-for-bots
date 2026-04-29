---
"@endo/pass-style": patch
---

Fix `passStyleOf` and `isPrimitive` so that values with the `[[IsHTMLDDA]]` internal slot (`document.all` in browsers) are no longer mis-classified as the primitive `undefined`. They are now treated as objects and rejected by `passStyleOf` because they cannot be frozen.
