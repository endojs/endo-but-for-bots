---
'@endo/captp': patch
---

Forget an object's reverse slot mapping when its last export reference is
dropped, so a live local capability can be exported again with a fresh slot.
