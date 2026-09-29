---
"@endo/pass-style": patch
---

Fix `passStyleOf` and `isPrimitive` so that values with the `[[IsHTMLDDA]]` internal slot are no longer mis-classified as the primitive `undefined`. They are now treated as objects and rejected by `passStyleOf` because they cannot be frozen.

`document.all` (in browsers) is the only known JS value with this internal slot, and is the only JS value the current TC39 specification permits to have it (Annex B `[[IsHTMLDDA]]`).
