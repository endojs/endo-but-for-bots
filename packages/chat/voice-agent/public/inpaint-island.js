// inpaint-island.js — the FLUX.2 mask-painter as a PROPER CONFINED ISLAND.
//
// The exported function is the component SOURCE: the host does `inpaintIsland.toString()` and mounts it into
// a /confined.html iframe (it never runs in the app realm). It uses ONLY the confined `ui` kit — the canvas
// primitive (ui.create('canvas').ctx()), pointer events (ui.on('pointer…', e=>{e.x,e.y})), ui.props (the
// render-safe source image the host seeds), and ui.call('inpaint', …) (the ONE host-mediated, cap-gated seam
// — the island holds NO capability). So it stays fully inside the confinement boundary; the host only
// mediates the GPU job. Keep it SELF-CONTAINED: reference only `ui`, `Math`, and its own locals (toString()
// captures the body — no outer closures, no imports).

export const inpaintIsland = ui => {
  const P = ui.props || {};
  const src = String(P.image || '');
  const nW = Math.max(1, Number(P.width) || 512);
  const nH = Math.max(1, Number(P.height) || 512);
  const DISP = Math.min(480, nW);
  const scale = DISP / nW;
  const dW = Math.round(nW * scale);
  const dH = Math.round(nH * scale);
  let brush = 40;
  let painting = false;
  let painted = false;
  let busy = false;

  const root = ui.create('div').style({ display: 'flex', 'flex-direction': 'column', gap: '10px', padding: '12px', 'max-width': (DISP + 24) + 'px', color: '#e6edf3', background: '#11141f', border: '1px solid #262c3d', 'border-radius': '12px' });
  root.push(ui.create('div').style({ 'font-weight': '600', 'font-size': '13px' }).text('🖌 Inpaint (FLUX.2) — paint the area to regenerate'));

  // stage: the source image on a base canvas + a paint-overlay canvas stacked on top
  const stage = ui.create('div').style({ position: 'relative', width: dW + 'px', height: dH + 'px', 'align-self': 'center', 'touch-action': 'none', 'border-radius': '8px', overflow: 'hidden' });
  const imgCanvas = ui.create('canvas').style({ display: 'block', width: dW + 'px', height: dH + 'px' });
  const paintCanvas = ui.create('canvas').style({ position: 'absolute', left: '0', top: '0', width: dW + 'px', height: dH + 'px', cursor: 'crosshair' });
  const ictx = imgCanvas.ctx().size(dW, dH);
  const pctx = paintCanvas.ctx().size(dW, dH);
  // offscreen NATIVE-res b/w mask (white = regenerate) — the artifact the GPU consumes
  const mctx = ui.create('canvas').ctx().size(nW, nH).fillStyle('#000').fillRect(0, 0, nW, nH);
  ictx.drawImageUrl(src, 0, 0, dW, dH);
  stage.push(imgCanvas).push(paintCanvas);
  root.push(stage);

  const dab = (x, y) => {
    const nr = (brush / 2) / scale;
    mctx.fillStyle('#fff').dot(x / scale, y / scale, nr);          // the real mask (native)
    pctx.fillStyle('rgba(124,92,255,0.45)').dot(x, y, brush / 2);  // the translucent preview (display)
    painted = true;
    status.text('');
  };
  paintCanvas.on('pointerdown', e => { if (busy) return; painting = true; dab(e.x, e.y); });
  paintCanvas.on('pointermove', e => { if (painting && !busy) dab(e.x, e.y); });
  paintCanvas.on('pointerup', () => { painting = false; });
  paintCanvas.on('pointerleave', () => { painting = false; });

  // brush size + clear
  const brow = ui.create('div').style({ display: 'flex', gap: '8px', 'align-items': 'center', 'font-size': '11px' });
  const blabel = ui.create('span').style({ color: '#8b949e', 'min-width': '58px' }).text('brush ' + brush);
  const brange = ui.create('input').attr('type', 'range').attr('min', '8').attr('max', '140').attr('value', String(brush)).style({ flex: '1' });
  brange.on('input', e => { brush = Number(e.value) || 40; blabel.text('brush ' + brush); });
  const clr = ui.create('button').class('cu-btn').text('clear');
  clr.on('click', () => { mctx.fillStyle('#000').fillRect(0, 0, nW, nH); pctx.clear(); painted = false; status.text(''); });
  brow.push(blabel).push(brange).push(clr);
  root.push(brow);

  // prompt
  let promptText = '';
  const prompt = ui.create('textarea').attr('placeholder', 'what should appear in the painted area?').style({ width: '100%', 'box-sizing': 'border-box', 'min-height': '48px', background: '#0a0c14', color: '#e6edf3', border: '1px solid #262c3d', 'border-radius': '8px', padding: '8px', font: 'inherit' });
  prompt.on('input', e => { promptText = String(e.value || ''); });
  root.push(prompt);

  // generate + status + result
  const gen = ui.create('button').class('cu-btn primary').text('Generate');
  const status = ui.create('span').style({ 'font-size': '11px', color: '#8b949e', 'margin-left': '8px' });
  root.push(ui.create('div').style({ display: 'flex', 'align-items': 'center' }).push(gen).push(status));
  const result = ui.create('img').style({ 'max-width': '100%', 'margin-top': '8px', 'border-radius': '8px', display: 'none', border: '1px solid #262c3d' });
  root.push(result);

  gen.on('click', async () => {
    if (busy) return;
    if (!painted) { status.text('paint a region first'); return; }
    if (!promptText.trim()) { status.text('type a prompt first'); return; }
    busy = true; gen.text('Generating…'); status.text('FLUX.2 is working…');
    try {
      // ui.call is the ONLY authority the island holds: a REQUEST the host gates + runs (cap-gated GPU job).
      const out = await ui.call('inpaint', { image: src, mask: mctx.toDataURL('image/png'), prompt: promptText.trim() });
      if (out && out.dataUrl) { result.attr('src', out.dataUrl).style({ display: 'block' }); status.text('done'); }
      else { status.text('no result'); }
    } catch (e) { status.text('⚠️ ' + ((e && e.message) || e)); }
    busy = false; gen.text('Generate');
  });

  return root;
};
