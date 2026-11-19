// @ts-check
/**
 * The microphone capture processor (`designs/m11-interfaces.md` section 9;
 * R5-3, R5-68). The page loads this file with
 * `audioContext.audioWorklet.addModule(CAPTURE_WORKLET_PATH)`; the speech
 * extension serves it as one file, so it imports nothing. It runs in the
 * browser's `AudioWorkletGlobalScope`, off the main thread (the
 * `ScriptProcessorNode` Endo used is deprecated and runs on it).
 *
 * The processor averages the context's input down to `outRate` (16 kHz for
 * speech in), converts to s16le and posts one block of `blockSamples`
 * samples (1,360: about 85 ms) at a time with the block's RMS level:
 * `{ pcm: ArrayBuffer, rms: number }`, the buffer transferred. Both numbers
 * come from the node's `processorOptions`, so the page's constants
 * (`audio-protocol.js` `sttFormat`, `endpointing-defaults.js`
 * `captureBlockSamples`) stay the one source. The resampler keeps its
 * fraction across render quanta, so no sample is lost or doubled at a
 * quantum boundary; an input rate below `outRate` repeats samples.
 *
 * A `'stop'` message from the page ends the processor (its `process`
 * answers false). Nothing else is retained: one block of samples.
 */

/** The name `registerProcessor` and `new AudioWorkletNode` agree on. */
export const CAPTURE_PROCESSOR_NAME = 'thix-capture';

/**
 * A streaming averaging resampler from `inRate` to `outRate`, writing
 * s16le blocks of `blockSamples` samples.
 *
 * @param {object} options
 * @param {number} options.inRate the context's sample rate
 * @param {number} options.outRate
 * @param {number} options.blockSamples
 * @param {(pcm: ArrayBuffer, rms: number) => void} options.onBlock
 */
export const makeCaptureResampler = ({
  inRate,
  outRate,
  blockSamples,
  onBlock,
}) => {
  if (!(inRate > 0 && outRate > 0 && blockSamples > 0)) {
    throw RangeError('capture: rates and block size must be positive');
  }
  const ratio = inRate / outRate;
  // Input samples still owed to the output sample being averaged.
  let owed = ratio;
  let sum = 0;
  let count = 0;
  let block = new Int16Array(blockSamples);
  let filled = 0;
  let squares = 0;

  /** @param {number} value */
  const emit = value => {
    const clamped = Math.max(-1, Math.min(1, value));
    block[filled] = clamped < 0 ? clamped * 32_768 : clamped * 32_767;
    filled += 1;
    squares += clamped * clamped;
    if (filled === blockSamples) {
      const done = block;
      const rms = Math.sqrt(squares / blockSamples);
      block = new Int16Array(blockSamples);
      filled = 0;
      squares = 0;
      onBlock(done.buffer, rms);
    }
  };

  return {
    /** @param {ArrayLike<number>} input one channel of one render quantum */
    push(input) {
      for (let i = 0; i < input.length; i += 1) {
        sum += input[i];
        count += 1;
        owed -= 1;
        if (owed <= 0) {
          const value = sum / count;
          sum = 0;
          count = 0;
          while (owed <= 0) {
            emit(value);
            owed += ratio;
          }
        }
      }
    },
  };
};

/**
 * The processor class over the scope's `AudioWorkletProcessor`.
 *
 * @param {any} Base `AudioWorkletProcessor`
 * @param {number} inRate the scope's `sampleRate`
 */
export const makeCaptureProcessor = (Base, inRate) =>
  class CaptureProcessor extends Base {
    /** @param {{ processorOptions?: { outRate?: number, blockSamples?: number } }} [options] */
    constructor(options) {
      super();
      const { outRate = 16_000, blockSamples = 1360 } =
        options?.processorOptions ?? {};
      this.alive = true;
      this.resampler = makeCaptureResampler({
        inRate,
        outRate,
        blockSamples,
        onBlock: (pcm, rms) => this.port.postMessage({ pcm, rms }, [pcm]),
      });
      this.port.onmessage = (/** @type {{ data: unknown }} */ message) => {
        if (message.data === 'stop') this.alive = false;
      };
    }

    /** @param {Float32Array[][]} inputs */
    process(inputs) {
      const channel = inputs[0] && inputs[0][0];
      if (this.alive && channel) this.resampler.push(channel);
      return this.alive;
    }
  };

const scope = /** @type {any} */ (globalThis);
if (
  typeof scope.registerProcessor === 'function' &&
  typeof scope.AudioWorkletProcessor === 'function'
) {
  scope.registerProcessor(
    CAPTURE_PROCESSOR_NAME,
    makeCaptureProcessor(scope.AudioWorkletProcessor, scope.sampleRate),
  );
}
