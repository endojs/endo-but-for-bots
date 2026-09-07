// Capture the diagnostic power before SES removes it from guest globals.
const { gc } = globalThis;
if (!gc) throw Error('This fixture requires --expose-gc');
await import('@endo/init');
const { decodeBase64 } = await import('@endo/base64');
const { Far } = await import('@endo/far');
const { syrupCodec } = await import('@endo/ocapn/syrup');
const { setImmediate } = await import('node:timers/promises');
const { makeThixotropeDaemon } = await import('../src/daemon.js');
const { makePeerJournalReplayEngine } =
  await import('../src/peer-replay-engine.js');
const { makeMemoryStore } = await import('../src/store-fs.js');

const raw = makePeerJournalReplayEngine();
let gcFrames = 0;
const daemon = await makeThixotropeDaemon({
  store: makeMemoryStore(),
  codec: syrupCodec,
  engine: {
    ...raw,
    start: options =>
      raw.start({
        ...options,
        onOutbound: envelope => {
          if (envelope.t === 'f' && typeof envelope.b64 === 'string') {
            const reader = syrupCodec.makeReader(decodeBase64(envelope.b64));
            reader.enterRecord();
            if (reader.readSelectorAsString() === 'op:gc-exports')
              gcFrames += 1;
          }
          options.onOutbound(envelope);
        },
      }),
  },
  makeNetlayer: () => ({
    location: {
      type: 'ocapn-peer',
      transport: 'test',
      designator: 'replay-gc',
      hints: false,
    },
    shutdown: () => {},
  }),
});
try {
  const worker = await daemon.createWorker();
  for (let i = 0; i < 12; i += 1) {
    // The guest must release each temporary endowment after evaluating the call.
    // eslint-disable-next-line no-await-in-loop
    const result = await worker.evaluate('42n', {
      unused: Far('Temporary', {}),
    });
    if (result !== 42n) throw Error('Temporary import evaluation failed');
  }
  for (let i = 0; i < 30; i += 1) {
    // WeakRef targets survive their current job; collect only after a fresh turn.
    // eslint-disable-next-line no-await-in-loop
    await setImmediate();
    gc();
  }
  await setImmediate();
  if (gcFrames !== 0)
    throw Error(`Replay peer emitted ${gcFrames} nondeterministic GC frames`);
  await worker.sleep();
  if ((await worker.evaluate('43n')) !== 43n)
    throw Error('Replay failed after forced GC');
  if (gcFrames !== 0) throw Error('Replay emitted nondeterministic GC frames');
} finally {
  await daemon.shutdown();
}
console.log('no nondeterministic GC frames; replay answered');
