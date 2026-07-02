// gpu-inpaint.mjs — FLUX.2 mask inpainting over tinix ComfyUI (192.168.50.226:8188), as a plain async
// function (no Endo, so it can be smoke-tested headless; the cap gate lives in server.mjs's /gpu/inpaint).
//
//   inpaint(imageBuf, maskBuf, prompt, opts) → { dataUrl, info, _buf }
//
// The mask is a b/w PNG at the image's resolution: WHITE = the region to regenerate, black = keep.
// Graph: FLUX.2 GGUF (UnetLoaderGGUF + CLIPLoaderGGUF type=flux2 + VAELoader) → LoadImage(source) +
// LoadImageMask(mask, red) → CLIPTextEncode+FluxGuidance → InpaintModelConditioning(noise_mask) →
// KSampler(cfg 1, denoise 1) → VAEDecode → SaveImage. Node names verified against /object_info.

import { COMFY_URL } from './field-config.mjs';

const COMFY = COMFY_URL; // ComfyUI base (tinix :8188) — from field-config ENDPOINTS (env: COMFY_URL)
const UNET = process.env.FLUX2_UNET || 'flux2-dev-Q4_K_M.gguf';
const CLIP = process.env.FLUX2_CLIP || 'Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf';
const VAE = process.env.FLUX2_VAE || 'flux2-vae.safetensors';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Upload one image to ComfyUI's input store (manual multipart — no dep). Returns its stored name.
const uploadImage = async (buf, filename) => {
  const boundary = '----endoinpaint' + Math.floor(Date.now()).toString(36) + Math.random().toString(36).slice(2, 8);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\n` +
    `Content-Type: image/png\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, buf, tail]);
  const r = await fetch(`${COMFY}/upload/image`, { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body });
  if (!r.ok) throw new Error(`/upload/image ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  return j.name + (j.subfolder ? ` [${j.subfolder}]` : '');
};

const inpaintGraph = (imageName, maskName, prompt, { negative = '', steps = 20, guidance = 3.5, seed }) => ({
  '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: UNET } },
  '2': { class_type: 'CLIPLoaderGGUF', inputs: { clip_name: CLIP, type: 'flux2' } },
  '3': { class_type: 'VAELoader', inputs: { vae_name: VAE } },
  '10': { class_type: 'LoadImage', inputs: { image: imageName } },
  '11': { class_type: 'LoadImageMask', inputs: { image: maskName, channel: 'red' } }, // WHITE in the mask = regenerate
  '4': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['2', 0] } },
  '5': { class_type: 'FluxGuidance', inputs: { conditioning: ['4', 0], guidance } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['2', 0] } },
  '12': { class_type: 'InpaintModelConditioning', inputs: { positive: ['5', 0], negative: ['6', 0], vae: ['3', 0], pixels: ['10', 0], mask: ['11', 0], noise_mask: true } },
  '8': { class_type: 'KSampler', inputs: { seed, steps, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', denoise: 1.0, model: ['1', 0], positive: ['12', 0], negative: ['12', 1], latent_image: ['12', 2] } },
  '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
  '13': { class_type: 'SaveImage', inputs: { filename_prefix: 'endo-inpaint', images: ['9', 0] } },
});

/**
 * @param {Buffer} imageBuf source image PNG bytes
 * @param {Buffer} maskBuf  b/w mask PNG bytes (white = regenerate), same WxH as the source
 * @param {string} prompt   what should appear in the masked region
 */
export async function inpaint(imageBuf, maskBuf, prompt, opts = {}) {
  if (!Buffer.isBuffer(imageBuf) || imageBuf.length < 67) throw new Error('a valid source image is required');
  if (!Buffer.isBuffer(maskBuf) || maskBuf.length < 67) throw new Error('a valid mask image is required');
  if (!String(prompt || '').trim()) throw new Error('a prompt is required');
  const t0 = Date.now();
  const seed = opts.seed ?? Math.floor(Math.random() * 1e15);
  const client_id = globalThis.crypto?.randomUUID?.() ?? String(seed);

  // don't pile onto a busy GPU
  try {
    const q = await (await fetch(`${COMFY}/queue`)).json();
    const depth = (q.queue_running?.length || 0) + (q.queue_pending?.length || 0);
    if (depth > 2) throw new Error(`GPU busy (ComfyUI queue depth ${depth})`);
  } catch (e) { if (/queue depth/.test(e.message)) throw e; }

  const stamp = Date.now().toString(36);
  const imageName = await uploadImage(imageBuf, `inpaint-src-${stamp}.png`);
  const maskName = await uploadImage(maskBuf, `inpaint-mask-${stamp}.png`);
  const graph = inpaintGraph(imageName, maskName, prompt, { ...opts, seed });

  const pr = await fetch(`${COMFY}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: graph, client_id }) });
  if (!pr.ok) throw new Error(`/prompt ${pr.status}: ${(await pr.text()).slice(0, 400)}`);
  const { prompt_id } = await pr.json();

  let out;
  for (let i = 0; i < (opts.timeoutS ?? 180); i += 1) {
    await sleep(1000);
    const e = (await (await fetch(`${COMFY}/history/${prompt_id}`)).json())[prompt_id];
    if (e?.status?.status_str === 'error') throw new Error('comfy execution_error: ' + JSON.stringify(e.status.messages || e.status).slice(0, 500));
    const imgs = e?.outputs?.['13']?.images;
    if (imgs?.length) { out = imgs[0]; break; }
  }
  if (!out) throw new Error('timed out waiting for the inpainted image');

  const v = await fetch(`${COMFY}/view?filename=${encodeURIComponent(out.filename)}&subfolder=${encodeURIComponent(out.subfolder || '')}&type=${out.type || 'output'}`);
  const buf = Buffer.from(await v.arrayBuffer());
  return {
    dataUrl: 'data:image/png;base64,' + buf.toString('base64'),
    info: { prompt, seed, model: 'flux2-dev-Q4_K_M', mime: 'image/png', bytes: buf.length, ms: Date.now() - t0, promptId: prompt_id },
    _buf: buf,
  };
}
