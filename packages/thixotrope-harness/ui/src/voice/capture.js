// @ts-check
/**
 * Microphone capture for speech in (`designs/m11-interfaces.md` section 9;
 * R5-3, R5-44, R5-55, R5-68). `openCapture` asks for the microphone with
 * `captureConstraints`, builds an `AudioContext`, loads the capture worklet
 * from `CAPTURE_WORKLET_PATH` (served by the speech extension, so CSP
 * `script-src 'self'` admits it) and hands each 85 ms block of 16 kHz
 * s16le to `onBlock(pcm, rms)`.
 *
 * Call it from inside the mic tap: `getUserMedia` and the context are
 * created synchronously, before anything is awaited, so the gesture that
 * mobile browsers require is still in effect (R5-44). The `Capture` is
 * answered at once, so the mic can be turned off while the permission
 * prompt is still open: the tracks are then released as soon as they
 * arrive. `started` settles when blocks begin to flow, or rejects with a
 * `CaptureFailure` whose `reason` names the cause (`captureFailureOf`);
 * the feature shows its own text for each.
 */
import {
  CAPTURE_WORKLET_PATH,
  sttFormat,
} from '../../../resources/agent-host/impl/speech/audio-protocol.js';
import { CAPTURE_PROCESSOR_NAME } from '../../../resources/agent-host/impl/speech/capture-worklet.js';
import {
  captureBlockSamples,
  captureConstraints,
} from './endpointing-defaults.js';

/**
 * Why the microphone could not start: `insecure` (no secure context),
 * `unsupported` (no `mediaDevices` or no `AudioWorklet`), `denied` (the user
 * or the system refused), `notFound` (no microphone), `unreadable` (the
 * device would not start), `failed` (anything else).
 *
 * @typedef {'insecure' | 'unsupported' | 'denied' | 'notFound' | 'unreadable' | 'failed'} CaptureFailureReason
 */

/**
 * @typedef {Error & { reason: CaptureFailureReason }} CaptureFailure
 */

/**
 * @typedef {object} Capture
 * @property {Promise<void>} started blocks flow (or the capture was
 *   stopped first); a `CaptureFailure` otherwise
 * @property {number} inputRate the context's own sample rate (0 when
 *   none)
 * @property {() => void} stop release the tracks, the nodes and the context
 *   (idempotent)
 */

/**
 * @param {CaptureFailureReason} reason
 * @param {string} [message]
 * @returns {CaptureFailure}
 */
const failure = (reason, message = reason) =>
  /** @type {CaptureFailure} */ (Object.assign(Error(message), { reason }));

/**
 * The reason for a `getUserMedia` or worklet failure, from the error's
 * DOM name (never its message).
 *
 * @param {unknown} error
 * @returns {CaptureFailureReason}
 */
export const captureFailureOf = error => {
  const name = /** @type {{ name?: unknown }} */ (error)?.name;
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'denied';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'notFound';
    case 'NotReadableError':
    case 'AbortError':
      return 'unreadable';
    default:
      return 'failed';
  }
};
harden(captureFailureOf);

/**
 * @param {object} options
 * @param {(pcm: Uint8Array, rms: number) => void} options.onBlock one block
 *   of `captureBlockSamples` samples
 * @param {{ getUserMedia: (constraints: { audio: object }) => Promise<any> }} [options.mediaDevices]
 *   `navigator.mediaDevices`
 * @param {() => any} [options.makeContext] `() => new AudioContext()`
 * @param {new (context: any, name: string, options: object) => any} [options.WorkletNode]
 *   `AudioWorkletNode`
 * @param {boolean} [options.secure] `globalThis.isSecureContext`
 * @param {string} [options.workletUrl] the worklet's URL (default the
 *   extension's path on this origin)
 * @returns {Capture}
 */
export const openCapture = ({
  onBlock,
  mediaDevices = /** @type {any} */ (globalThis).navigator?.mediaDevices,
  makeContext = () => new /** @type {any} */ (globalThis).AudioContext(),
  WorkletNode = /** @type {any} */ (globalThis).AudioWorkletNode,
  secure = /** @type {any} */ (globalThis).isSecureContext !== false,
  workletUrl = CAPTURE_WORKLET_PATH,
}) => {
  let stopped = false;
  /** @type {any} */
  let stream;
  /** @type {any} */
  let context;
  /** @type {any[]} */
  const nodes = [];

  const release = () => {
    for (const node of nodes) {
      try {
        node.disconnect();
      } catch {
        // already disconnected
      }
    }
    nodes.length = 0;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = undefined;
    }
    if (context) {
      const closing = context;
      context = undefined;
      Promise.resolve()
        .then(() => closing.close())
        .catch(() => {});
    }
  };

  /**
   * Before anything is awaited: still inside the tap's gesture.
   *
   * @returns {Promise<any>}
   */
  const ask = () => {
    if (!secure) return Promise.reject(failure('insecure'));
    if (
      !mediaDevices ||
      typeof mediaDevices.getUserMedia !== 'function' ||
      typeof WorkletNode !== 'function'
    ) {
      return Promise.reject(failure('unsupported'));
    }
    /** @type {Promise<any>} */
    let asked;
    try {
      asked = Promise.resolve(
        mediaDevices.getUserMedia({ audio: { ...captureConstraints } }),
      );
    } catch (error) {
      return Promise.reject(failure(captureFailureOf(error)));
    }
    try {
      context = makeContext();
    } catch {
      // the stream, when it comes, has no context to play into
      asked
        .then(got => {
          for (const track of got.getTracks()) track.stop();
        })
        .catch(() => {});
      return Promise.reject(failure('unsupported'));
    }
    return asked.catch(error => {
      throw failure(captureFailureOf(error));
    });
  };
  const asked = ask();

  const start = async () => {
    stream = await asked.catch(error => {
      release();
      throw error;
    });
    if (stopped) {
      release();
      return;
    }
    try {
      if (context.state === 'suspended') await context.resume();
      await context.audioWorklet.addModule(workletUrl);
    } catch {
      release();
      throw failure('unsupported');
    }
    if (stopped) {
      release();
      return;
    }
    const source = context.createMediaStreamSource(stream);
    const node = new WorkletNode(context, CAPTURE_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      processorOptions: {
        outRate: sttFormat.sampleRate,
        blockSamples: captureBlockSamples,
      },
    });
    // A silent path to the destination keeps the node rendering in every
    // browser; nothing is heard.
    const mute = context.createGain();
    mute.gain.value = 0;
    nodes.push(source, node, mute);
    node.port.onmessage = (
      /** @type {{ data: { pcm: ArrayBuffer, rms: number } }} */ message,
    ) => {
      if (stopped) return;
      const { pcm, rms } = message.data;
      onBlock(new Uint8Array(pcm), rms);
    };
    source.connect(node);
    node.connect(mute);
    mute.connect(context.destination);
  };
  const started = start();
  started.catch(() => {});

  return harden({
    started,
    get inputRate() {
      return context ? context.sampleRate : 0;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const node of nodes) {
        if (node.port) node.port.postMessage('stop');
      }
      release();
    },
  });
};
harden(openCapture);
