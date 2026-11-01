// @ts-check
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { inflateSync } from 'node:zlib';

// Chromium screenshots use non-interlaced, 8-bit RGB or RGBA PNGs.
// Decode their scanlines so a blank screenshot cannot satisfy this smoke check.
const decodePng = png => {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((byte, index) => png[index] === byte)) {
    throw Error('Expected a PNG screenshot');
  }
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  let channels = 0;
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const size = view.getUint32(offset);
    const kind = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
    const start = offset + 8;
    if (kind === 'IHDR') {
      width = view.getUint32(start);
      height = view.getUint32(start + 4);
      const depth = png[start + 8];
      const color = png[start + 9];
      if (depth !== 8 || ![2, 6].includes(color) || png[start + 12] !== 0) {
        throw Error('Unsupported screenshot PNG format');
      }
      channels = color === 2 ? 3 : 4;
    } else if (kind === 'IDAT') {
      chunks.push(png.subarray(start, start + size));
    }
    offset += size + 12;
  }
  if (!width || !height || width > 4096 || height > 4096 || !channels) {
    throw Error('Unexpected screenshot dimensions');
  }
  const compressed = new Uint8Array(
    chunks.reduce((n, chunk) => n + chunk.length, 0),
  );
  let cursor = 0;
  for (const chunk of chunks) {
    compressed.set(chunk, cursor);
    cursor += chunk.length;
  }
  const stride = width * channels;
  const raw = inflateSync(compressed, {
    maxOutputLength: (stride + 1) * height,
  });
  if (raw.length !== (stride + 1) * height)
    throw Error('Incomplete screenshot');
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const index = y * stride + x;
      const left = x >= channels ? pixels[index - channels] : 0;
      const above = y > 0 ? pixels[index - stride] : 0;
      const corner =
        y > 0 && x >= channels ? pixels[index - stride - channels] : 0;
      const estimate = left + above - corner;
      const distances = [
        Math.abs(estimate - left),
        Math.abs(estimate - above),
        Math.abs(estimate - corner),
      ];
      const paeth =
        distances[0] <= distances[1] && distances[0] <= distances[2]
          ? left
          : distances[1] <= distances[2]
            ? above
            : corner;
      const predictors = [
        0,
        left,
        above,
        Math.floor((left + above) / 2),
        paeth,
      ];
      if (filter > 4) throw Error('Unknown PNG filter');
      pixels[index] = raw[y * (stride + 1) + x + 1] + predictors[filter];
    }
  }
  return { width, height, channels, pixels };
};

const assertPainted = ({ width, height, channels, pixels }) => {
  if (width < 256 || height < 128) throw Error('Screenshot too small');
  let ink = 0;
  let blue = 0;
  for (let y = 8; y < 128; y += 1) {
    for (let x = 8; x < 248; x += 1) {
      const index = (y * width + x) * channels;
      const [r, g, b] = pixels.subarray(index, index + 3);
      if (y < 48 && r < 100 && g < 100 && b < 100) ink += 1;
      if (y >= 64 && x < 72 && r < 10 && g >= 120 && g <= 136 && b > 245)
        blue += 1;
    }
  }
  if (ink < 100 || blue < 3500)
    throw Error(
      'Screenshot must contain visible text and painted WebGL pixels',
    );
};

// Exercise the pixel acceptance rule without requiring a container in unit tests.
if (process.argv.includes('--self-test')) {
  const pixels = new Uint8Array(256 * 128 * 3).fill(255);
  const fixture = { width: 256, height: 128, channels: 3, pixels };
  const expectRejected = () => {
    let rejected = false;
    try {
      assertPainted(fixture);
    } catch {
      rejected = true;
    }
    if (!rejected) throw Error('Blank or incomplete rendering passed');
  };
  expectRejected();
  for (let y = 64; y < 128; y += 1) {
    for (let x = 8; x < 72; x += 1)
      pixels.set([0, 128, 255], (y * 256 + x) * 3);
  }
  expectRejected();
  for (let x = 8; x < 208; x += 1) pixels.set([0, 0, 0], (8 * 256 + x) * 3);
  assertPainted(fixture);
} else {
  const directory = await mkdtemp(path.join(tmpdir(), 'endo-browser-smoke-'));
  try {
    const screenshot = path.join(directory, 'render.png');
    const html = `<html><body style="background:white"><span style="position:absolute;left:8px;top:8px;font:32px sans-serif;color:black">Browser ready</span>
      <canvas width="64" height="64" style="position:absolute;left:8px;top:64px"></canvas><script>
      const gl = document.querySelector('canvas').getContext('webgl2');
      if (gl) { gl.clearColor(0, 0.5, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
      document.body.dataset.result = gl ? 'browser-smoke-passed' : 'browser-smoke-failed';
      </script></body></html>`;
    const { stdout } = await promisify(execFile)(
      '/usr/bin/chromium',
      [
        '--headless',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--no-first-run',
        '--window-size=320,240',
        '--force-device-scale-factor=1',
        `--user-data-dir=${path.join(directory, 'profile')}`,
        `--screenshot=${screenshot}`,
        '--dump-dom',
        `data:text/html,${encodeURIComponent(html)}`,
      ],
      {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          HOME: directory,
          XDG_CACHE_HOME: path.join(directory, 'cache'),
          XDG_CONFIG_HOME: path.join(directory, 'config'),
        },
      },
    );
    if (!stdout.includes('data-result="browser-smoke-passed"'))
      throw Error('Chromium must initialize software WebGL');
    assertPainted(decodePng(await readFile(screenshot)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
