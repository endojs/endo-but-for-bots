# Confined canvas — the default for visual/interactive UI

A `<canvas>` is a **first-class, authority-free confined surface**. Drawing is pure computation, so
a confined component can own a canvas and paint on it freely — no ambient authority is involved.
Prefer a **confined-canvas island** over a host-mounted imperative widget.

## Why it's safe (and why the old "can't" was wrong)

The hazard was never the canvas — it's handing confined code a **raw DOM node**. From any DOM node you
can walk `node.ownerDocument.defaultView → window → fetch/localStorage/other frames` and escape the
sandbox. So:

- In **`confined.html`** (a real `sandbox="allow-scripts"`, null-origin, `default-src 'none'` iframe) the
  iframe itself is the boundary — code inside has no network/storage/parent reach regardless. A canvas
  there is trivially safe. The kit still vends an **attenuated** `.ctx()` facet (pure draw ops +
  `toDataURL`/`getImageData`, never the raw element) so components stay portable to the inline model too.
- In the inline **`preact-container` fork** (a SES compartment in the main page) you *must* use the
  attenuated facet — a raw canvas/context would leak `ownerDocument → window`.

## The primitive (public/confined.html)

- `ui.create('canvas').ctx()` → the 2D facet: `size(w,h)`, `clear()`, `fillStyle`/`strokeStyle`/`lineWidth`/
  `lineCap`/`lineJoin`/`alpha`/`composite`, path ops (`beginPath`/`moveTo`/`lineTo`/`arc`/`rect`/`fill`/
  `stroke`), `fillRect`/`clearRect`, `dot(x,y,r)` (brush), `drawCanvas(otherCanvasWrapper, …)`,
  `drawImageUrl(dataUrl, …)` (data: images only), `toDataURL(type)`. It never exposes the element/context.
- Pointer events with coordinates: `w.on('pointerdown'|'pointermove'|'pointerup'|'pointerleave', e => …)`
  where `e.x`/`e.y` are in **canvas-pixel** space (scaled from the display rect). `pointerdown` auto-captures.
- `ui.props` — render-safe DATA the host seeds on mount (e.g. a source image data URL).
- `ui.call(method, args) → Promise` — the ONE imperative seam: the frame holds no capability, it only
  *requests* a named action; the **host is the gate** and runs it (e.g. a cap-backed GPU/network job) and
  answers. An un-exposed method rejects.

## The host side (public/app.js `mountConfined`)

`mountConfined(container, source, { props, onCall })` mounts a component source into a fresh sandboxed
iframe: transfers a private MessagePort, seeds `props` + theme, auto-sizes to the reported height, and
routes `ui.call(method,args)` → `onCall` (the host's gate). Reuse it for any confined-canvas island.

## Reference implementation

`public/inpaint-island.js` — a FLUX.2 mask-painter: paints a native-res b/w mask on a confined canvas,
previews it translucently, and hands `{image, mask, prompt}` to the host via `ui.call('inpaint', …)` →
cap-gated `/gpu/inpaint` → tinix ComfyUI. It holds no cap; the host mediates the GPU.

## Guardrail

**Default to a confined-canvas island for anything visual/interactive** (drawing, painting, plotting,
charts, small games, image editing). A **host-mounted imperative widget** (like the trace pendant) is the
**exception** — justified only when you need WebGL/Three.js or a shared long-lived GL context that the
confined 2D facet doesn't cover. If you reach for a host widget, say why the confined canvas didn't fit.
