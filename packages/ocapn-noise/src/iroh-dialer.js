// @ts-nocheck
// iroh-dialer.js — dial a remote endo-iroh capability and invoke one method,
// over the iroh QUIC transport, under the unchanged CapTP/ocap layer.
//
// Lives in ocapn-noise (next to the transport) because the dial needs
// @endo/ocapn, which resolves from this package's node_modules but not from
// every consumer's. Consumers (e.g. the voice-agent `objects` power) import
// this via a relative path. The dial is the inverse of the service side: it
// stands up an ocapn-noise network over makeIrohTransport(), connects BY
// EndpointId (no host:port), enlivens the swissnum-bearing sturdyref, and
// calls the method.
//
// cap-hygiene: the swissnum is used host-side only and is NEVER rendered.
//
// SES note: @number0/iroh is a NAPI addon outside the SES sandbox; it hands
// an authenticated byte-stream into the confined vat.

import { E } from '@endo/eventual-send';

import { makeOcapn } from '@endo/ocapn';
import { cborCodec } from '@endo/ocapn/cbor';

import { makeOcapnNoiseNetwork } from '../index.js';
import { makeIrohTransport } from './transports/iroh.js';

/**
 * Parse the stored `address` of an accepted iroh ref into dial hints.
 *
 * Accepted forms (the part of the invite link before `#cap=`):
 *   iroh://<endpointId>
 *   iroh://<endpointId>?addr=<ip:port>                  (direct StaticProvider hint)
 *   iroh://<endpointId>?addr=<ip:port>&key=<noiseKeyIdHex>
 *
 * `key` is the ocapn-noise designator (the Ed25519 key the Noise handshake
 * authenticates) where the remote vends both identities; otherwise the
 * EndpointId is the designator fallback (correct once the clean,
 * Noise-retired netlayer lands).
 *
 * @param {string} address
 * @returns {{ id: string, addr?: string, key?: string }}
 */
export const parseIrohAddress = address => {
  const s = String(address || '').trim();
  const m = /^iroh:\/\/([^/?#]+)/i.exec(s);
  const id = m ? m[1] : '';
  let addr;
  let key;
  try {
    const u = new URL(s);
    addr = u.searchParams.get('addr') || undefined;
    key = u.searchParams.get('key') || undefined;
  } catch {
    // no query string
  }
  return { id, addr, key };
};

/**
 * @param {{ id: string, addr?: string, key?: string }} hints
 */
const locationForIroh = ({ id, addr, key }) => ({
  type: 'ocapn-peer',
  network: 'np',
  transport: 'np',
  designator: key || id,
  hints: {
    'iroh:id': id,
    ...(addr ? { 'iroh:addr': addr } : {}),
  },
});

/**
 * Dial an endo-iroh object and invoke one method. Single-use: stands up a
 * fresh dialer endpoint, calls, and tears down. (A future optimisation can
 * pool one dialer endpoint across calls.)
 *
 * @param {object} args
 * @param {string} args.address     stored iroh:// address (before `#cap=`)
 * @param {string} args.swissnum    held swissnum (host-side only; never shown)
 * @param {string} args.method      method name (e.g. 'describe', 'hello')
 * @param {unknown[]} [args.args]   method arguments
 * @param {Uint8Array} [args.secretKey] 32-byte seed for a STABLE dialer
 *   EndpointId (so a callee accept-allowlist can recognise us)
 * @param {'minimal' | 'n0' | 'n0-no-relay'} [args.preset] default 'minimal'
 * @param {number} [args.timeoutMs] default 15000
 * @returns {Promise<{ ok: true, value: unknown } | { ok: false, error: string }>}
 */
export const dialIrohObject = async ({
  address,
  swissnum,
  method,
  args = [],
  secretKey,
  preset = 'minimal',
  timeoutMs = 15000,
}) => {
  const hints = parseIrohAddress(address);
  if (!hints.id) {
    return { ok: false, error: `not a dialable iroh address: ${address}` };
  }

  const network = makeOcapnNoiseNetwork({ codec: cborCodec });
  network.addSigningKeys(network.generateSigningKeys());
  const transport = await makeIrohTransport({
    secretKey,
    alpn: 'field/captp/0',
    preset,
  });
  await network.addTransport(transport);

  const client = await makeOcapn({
    codec: cborCodec,
    network,
    debugLabel: 'objects-dialer',
    debugMode: false,
  });

  let timer;
  const withTimeout = promise =>
    Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(Error(`iroh dial timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);

  try {
    const location = locationForIroh(hints);
    const sturdyRef = client.makeSturdyRef(location, swissnum);
    const obj = await withTimeout(client.enlivenSturdyRef(sturdyRef));
    const value = await withTimeout(
      E(obj)[String(method || 'describe')](...args),
    );
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (timer) clearTimeout(timer);
    try {
      client.shutdown();
    } catch {
      // best-effort
    }
    transport.shutdown();
  }
};
