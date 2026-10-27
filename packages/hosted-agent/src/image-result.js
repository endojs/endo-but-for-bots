// @ts-check

// Tool results and durable transcripts currently carry text. A versioned wire
// envelope preserves image bytes through those seams; only tool-result fields
// are decoded, never user/assistant prose. Providers must decode before sending
// context, and presentation must use imageResultText instead of showing base64.
const PREFIX = '\u001eendo-image-v1\n';
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
harden(MAX_IMAGE_BYTES);

/** @typedef {{ mimeType: 'image/png' | 'image/jpeg' | 'image/webp', data: string }} ImageResult */

/**
 * @param {unknown} candidate
 * @returns {ImageResult}
 */
const validate = candidate => {
  const image = /** @type {ImageResult} */ (candidate);
  if (
    !image ||
    typeof image !== 'object' ||
    Array.isArray(image) ||
    Object.keys(image).length !== 2 ||
    !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType) ||
    typeof image.data !== 'string' ||
    !image.data.length ||
    image.data.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3) ||
    image.data.length % 4 !== 0 ||
    /[^A-Za-z0-9+/]/.test(image.data.replace(/={1,2}$/, ''))
  )
    throw Error('Invalid image tool result (PNG, JPEG or WebP; maximum 2 MiB)');
  const padding = image.data.endsWith('==')
    ? 2
    : image.data.endsWith('=')
      ? 1
      : 0;
  if ((image.data.length / 4) * 3 - padding > MAX_IMAGE_BYTES)
    throw Error('Image exceeds the 2 MiB limit; resize it before reading');
  return harden({ mimeType: image.mimeType, data: image.data });
};

/** @param {ImageResult} image */
export const encodeImageResult = image =>
  PREFIX + JSON.stringify(validate(image));
harden(encodeImageResult);

/**
 * @param {unknown} text
 * @returns {ImageResult | undefined}
 */
export const decodeImageResult = text => {
  if (typeof text !== 'string' || !text.startsWith(PREFIX)) return undefined;
  if (text.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3) + 128)
    throw Error('Image tool result exceeds its wire limit');
  return validate(JSON.parse(text.slice(PREFIX.length)));
};
harden(decodeImageResult);

/** @param {string} text */
export const imageResultText = text => {
  const image = decodeImageResult(text);
  return image
    ? `[Image ${image.mimeType}; bytes retained for model input]`
    : text;
};
harden(imageResultText);

/** @param {ImageResult} image */
export const imageDataUrl = image =>
  `data:${image.mimeType};base64,${image.data}`;
harden(imageDataUrl);

/** @param {string} text */
export const anthropicToolContent = text => {
  const image = decodeImageResult(text);
  return image
    ? [
        {
          type: /** @type {const} */ ('image'),
          source: {
            type: /** @type {const} */ ('base64'),
            media_type: image.mimeType,
            data: image.data,
          },
        },
      ]
    : text;
};
harden(anthropicToolContent);

/** @param {string} text */
export const responsesToolOutput = text => {
  const image = decodeImageResult(text);
  return image
    ? [{ type: 'input_image', image_url: imageDataUrl(image), detail: 'auto' }]
    : text;
};
harden(responsesToolOutput);

/**
 * Recover the single-image result emitted by our provider adapters. Mixed
 * native content remains the adapter's responsibility and is not discarded.
 * @param {unknown} blocks
 */
export const imageResultFromBlocks = blocks => {
  if (!Array.isArray(blocks) || blocks.length !== 1) return undefined;
  const block = blocks[0];
  if (block?.type === 'image' && block.source?.type === 'base64')
    return encodeImageResult({
      mimeType: block.source.media_type,
      data: block.source.data,
    });
  if (block?.type === 'image' && typeof block.data === 'string')
    return encodeImageResult({ mimeType: block.mimeType, data: block.data });
  const url =
    block?.type === 'inputImage'
      ? block.imageUrl
      : block?.type === 'input_image'
        ? block.image_url
        : undefined;
  if (typeof url !== 'string') return undefined;
  const match = /^data:(image\/(?:png|jpeg|webp));base64,(.*)$/.exec(url);
  if (!match) return undefined;
  return encodeImageResult({
    mimeType: /** @type {ImageResult['mimeType']} */ (match[1]),
    data: match[2],
  });
};
harden(imageResultFromBlocks);
