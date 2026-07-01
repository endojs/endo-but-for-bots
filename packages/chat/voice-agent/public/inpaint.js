// inpaint.js — the FLUX.2 inpainting widget: load an image, PAINT a mask over the region to regenerate,
// type a prompt, Generate. A rich imperative 2D-canvas surface (like the trace pendant), mounted by the
// host — it holds NO capability: the cap-gated GPU call is the host's `onSubmit` handler → server → tinix
// ComfyUI (FLUX.2). The widget only produces render-safe data (the source image + a b/w mask + a prompt).
//
// makeInpaint(host) → { el, open, reset, setBusy, setResult, setError, onSubmit, getState, paintNative }
//   open(dataUrl)        — load an image to edit (or leave empty for the upload zone)
//   onSubmit(fn)         — fn({ imageDataUrl, maskDataUrl, prompt, opts }) → Promise; wire it to the GPU
//   setResult(dataUrl)   — show a generated result (host calls after onSubmit resolves)
//   paintNative(x,y,r)   — paint one mask dab in NATIVE image coords (used by the headless test)

const THEME = {
  panel: 'var(--panel, #11141f)', ink: 'var(--ink, #e6edf3)', mut: 'var(--mut, #8b949e)',
  edge: 'var(--edge, #262c3d)', acc: 'var(--acc, #7c5cff)', bg: 'var(--bg, #0a0c14)',
};
const el = (tag, css, txt) => { const e = document.createElement(tag); if (css) e.style.cssText = css; if (txt != null) e.textContent = txt; return e; };

export const makeInpaint = host => {
  // ── state ───────────────────────────────────────────────────────────────
  let img = null;            // the loaded HTMLImageElement (source)
  let nW = 0, nH = 0;        // native image size
  let scale = 1;             // display px per native px
  let brush = 40;            // brush diameter in DISPLAY px
  let painting = false, painted = false;
  let submitFn = null;
  let busy = false;

  // ── DOM ─────────────────────────────────────────────────────────────────
  const root = el('div', `display:flex;flex-direction:column;gap:10px;padding:12px;background:${THEME.panel};color:${THEME.ink};border:1px solid ${THEME.edge};border-radius:12px;max-width:560px;font:13px/1.4 system-ui,sans-serif`);
  const title = el('div', `font-weight:600;display:flex;align-items:center;gap:8px`, '🖌 Inpaint (FLUX.2)');
  const sub = el('span', `font-weight:400;color:${THEME.mut};font-size:11px`, '— paint the area to regenerate, describe it, Generate');
  title.appendChild(sub);

  // upload zone (shown until an image is loaded)
  const drop = el('label', `display:flex;align-items:center;justify-content:center;height:180px;border:1.5px dashed ${THEME.edge};border-radius:10px;color:${THEME.mut};cursor:pointer;text-align:center`, '📁 Drop or choose an image to edit');
  const file = el('input'); file.type = 'file'; file.accept = 'image/*'; file.style.display = 'none';
  drop.appendChild(file);

  // stage: source canvas + paint overlay (both display-scaled), stacked
  const stage = el('div', 'position:relative;line-height:0;align-self:center;touch-action:none;display:none;border-radius:8px;overflow:hidden');
  const imgCanvas = el('canvas', 'display:block;max-width:100%');
  const paintCanvas = el('canvas', 'position:absolute;left:0;top:0;cursor:crosshair;max-width:100%');
  stage.appendChild(imgCanvas); stage.appendChild(paintCanvas);
  const maskCanvas = el('canvas'); // OFFSCREEN, native size: white = inpaint region, black = keep

  // controls
  const controls = el('div', 'display:none;flex-direction:column;gap:8px');
  const brushRow = el('div', 'display:flex;align-items:center;gap:8px');
  const brushLabel = el('span', `color:${THEME.mut};font-size:11px;min-width:64px`, `brush ${brush}px`);
  const brushInput = el('input'); brushInput.type = 'range'; brushInput.min = '8'; brushInput.max = '140'; brushInput.value = String(brush); brushInput.style.cssText = 'flex:1';
  const clearBtn = el('button', btnCss(false), 'clear mask');
  brushRow.append(brushLabel, brushInput, clearBtn);

  const prompt = el('textarea', `width:100%;box-sizing:border-box;min-height:52px;resize:vertical;background:${THEME.bg};color:${THEME.ink};border:1px solid ${THEME.edge};border-radius:8px;padding:8px;font:inherit`);
  prompt.placeholder = 'what should appear in the painted area? (e.g. "a golden retriever puppy, same lighting")';

  const actionRow = el('div', 'display:flex;align-items:center;gap:8px');
  const genBtn = el('button', btnCss(true), 'Generate'); genBtn.disabled = true;
  const changeBtn = el('label', btnCss(false) + ';cursor:pointer', 'change image');
  const changeFile = el('input'); changeFile.type = 'file'; changeFile.accept = 'image/*'; changeFile.style.display = 'none'; changeBtn.appendChild(changeFile);
  const status = el('span', `color:${THEME.mut};font-size:11px`, '');
  actionRow.append(genBtn, changeBtn, status);
  controls.append(brushRow, prompt, actionRow);

  // result
  const resultWrap = el('div', 'display:none;flex-direction:column;gap:6px');
  const resultImg = el('img', `max-width:100%;border-radius:8px;border:1px solid ${THEME.edge}`);
  const resultBar = el('div', 'display:flex;gap:8px');
  const useBtn = el('button', btnCss(false), 'use result as source');
  const dlLink = el('a', btnCss(false) + ';text-decoration:none'); dlLink.textContent = 'download'; dlLink.download = 'inpaint.png';
  resultBar.append(useBtn, dlLink);
  resultWrap.append(el('div', `color:${THEME.mut};font-size:11px`, 'result'), resultImg, resultBar);

  root.append(title, drop, stage, controls, resultWrap);
  if (host) host.appendChild(root);

  function btnCss(primary) {
    return `all:unset;box-sizing:border-box;padding:6px 12px;border-radius:8px;font:600 12px system-ui;cursor:pointer;` +
      (primary ? `background:${THEME.acc};color:#fff` : `background:transparent;color:${THEME.ink};border:1px solid ${THEME.edge}`);
  }

  // ── image load + layout ───────────────────────────────────────────────────
  const layout = () => {
    const maxW = Math.min(520, (host && host.clientWidth) || 520);
    scale = Math.min(1, maxW / nW);
    const dW = Math.round(nW * scale), dH = Math.round(nH * scale);
    imgCanvas.width = dW; imgCanvas.height = dH; paintCanvas.width = dW; paintCanvas.height = dH;
    stage.style.width = dW + 'px'; stage.style.height = dH + 'px';
    imgCanvas.getContext('2d').drawImage(img, 0, 0, dW, dH);
    redrawOverlay();
  };
  const loadDataUrl = src => new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => {
      img = i; nW = i.naturalWidth; nH = i.naturalHeight;
      maskCanvas.width = nW; maskCanvas.height = nH;
      const mc = maskCanvas.getContext('2d'); mc.fillStyle = '#000'; mc.fillRect(0, 0, nW, nH); // start: keep everything
      painted = false;
      drop.style.display = 'none'; stage.style.display = 'block'; controls.style.display = 'flex';
      layout(); updateGen(); res();
    };
    i.onerror = () => rej(new Error('could not load image'));
    i.src = src;
  });

  // ── mask painting ─────────────────────────────────────────────────────────
  // Paint one dab in NATIVE mask coords (white) — the single source of truth for export.
  const paintNative = (nx, ny, nr) => {
    const mc = maskCanvas.getContext('2d');
    mc.fillStyle = '#fff'; mc.beginPath(); mc.arc(nx, ny, nr, 0, Math.PI * 2); mc.fill();
    painted = true;
  };
  // Re-render the translucent accent overlay from the b/w mask (so display always matches the export).
  const redrawOverlay = () => {
    const pc = paintCanvas.getContext('2d');
    pc.clearRect(0, 0, paintCanvas.width, paintCanvas.height);
    if (!painted) return;
    // draw the native mask scaled down, then tint it: use the mask's white as an alpha stencil.
    pc.save();
    pc.globalAlpha = 0.45; pc.drawImage(maskCanvas, 0, 0, paintCanvas.width, paintCanvas.height);
    pc.globalCompositeOperation = 'source-in';
    pc.globalAlpha = 0.5; pc.fillStyle = getComputedStyle(root).getPropertyValue('--acc') || '#7c5cff';
    pc.fillRect(0, 0, paintCanvas.width, paintCanvas.height);
    pc.restore();
  };
  const dabAtEvent = e => {
    const rect = paintCanvas.getBoundingClientRect();
    const dispX = (e.clientX - rect.left) * (paintCanvas.width / rect.width);
    const dispY = (e.clientY - rect.top) * (paintCanvas.height / rect.height);
    const nx = dispX / scale, ny = dispY / scale, nr = (brush / 2) / scale;
    paintNative(nx, ny, nr); redrawOverlay(); updateGen();
  };
  paintCanvas.addEventListener('pointerdown', e => { if (busy) return; painting = true; paintCanvas.setPointerCapture(e.pointerId); dabAtEvent(e); });
  paintCanvas.addEventListener('pointermove', e => { if (painting) dabAtEvent(e); });
  paintCanvas.addEventListener('pointerup', () => { painting = false; });
  paintCanvas.addEventListener('pointercancel', () => { painting = false; });

  // ── wiring ──────────────────────────────────────────────────────────────
  const readFile = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f); });
  file.addEventListener('change', async () => { if (file.files[0]) await loadDataUrl(await readFile(file.files[0])).catch(setErr); });
  changeFile.addEventListener('change', async () => { if (changeFile.files[0]) { hideResult(); await loadDataUrl(await readFile(changeFile.files[0])).catch(setErr); } });
  brushInput.addEventListener('input', () => { brush = Number(brushInput.value) || 40; brushLabel.textContent = `brush ${brush}px`; });
  clearBtn.addEventListener('click', () => { const mc = maskCanvas.getContext('2d'); mc.fillStyle = '#000'; mc.fillRect(0, 0, nW, nH); painted = false; redrawOverlay(); updateGen(); });
  prompt.addEventListener('input', updateGen);
  useBtn.addEventListener('click', () => { if (resultImg.src) { hideResult(); loadDataUrl(resultImg.src).catch(setErr); } });

  function updateGen() { genBtn.disabled = busy || !img || !painted || !prompt.value.trim(); }
  function setErr(e) { status.style.color = 'var(--bad,#f85149)'; status.textContent = '⚠️ ' + ((e && e.message) || e); }
  function hideResult() { resultWrap.style.display = 'none'; resultImg.removeAttribute('src'); }

  const setBusy = b => { busy = b; genBtn.textContent = b ? 'Generating…' : 'Generate'; if (b) { status.style.color = THEME.mut; status.textContent = 'FLUX.2 is working…'; } updateGen(); };
  const setResult = (dataUrl, info) => { setBusy(false); status.textContent = info && info.ms ? `done in ${(info.ms / 1000).toFixed(1)}s` : 'done'; resultImg.src = dataUrl; dlLink.href = dataUrl; resultWrap.style.display = 'flex'; };
  const setError = msg => { setBusy(false); setErr(msg); };

  genBtn.addEventListener('click', async () => {
    if (!submitFn || genBtn.disabled) return;
    setBusy(true);
    try {
      const payload = { imageDataUrl: imgToDataUrl(), maskDataUrl: maskCanvas.toDataURL('image/png'), prompt: prompt.value.trim(), opts: {} };
      const out = await submitFn(payload);
      if (out && out.dataUrl) setResult(out.dataUrl, out.info); // host may also call setResult itself
    } catch (e) { setError(e); }
  });
  // export the SOURCE at native resolution (a clean PNG the server re-uploads to ComfyUI)
  const imgToDataUrl = () => { const c = el('canvas'); c.width = nW; c.height = nH; c.getContext('2d').drawImage(img, 0, 0, nW, nH); return c.toDataURL('image/png'); };

  return {
    el: root,
    open: dataUrl => (dataUrl ? loadDataUrl(dataUrl) : Promise.resolve()),
    reset: () => { img = null; painted = false; hideResult(); drop.style.display = 'flex'; stage.style.display = 'none'; controls.style.display = 'none'; status.textContent = ''; },
    setBusy, setResult, setError,
    onSubmit: fn => { submitFn = fn; },
    getState: () => ({ hasImage: !!img, painted, prompt: prompt.value.trim(), nW, nH, canGenerate: !genBtn.disabled }),
    paintNative: (nx, ny, nr) => { paintNative(nx, ny, nr); redrawOverlay(); updateGen(); },
    maskDataUrl: () => maskCanvas.toDataURL('image/png'),
  };
};
