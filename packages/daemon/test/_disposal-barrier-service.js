// @ts-check
import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';

/**
 * @param {any} control
 * @param {any} context
 * @param {{env?: Record<string,string>}} [options]
 */
export const make = async (control, context, { env = {} } = {}) => {
  let closed = false;
  await E(context).addDisposalHook(
    Far('DisposalHook', async () => {
      closed = true;
      if (env.SKIP_DRAIN !== '1') await E(control).drain();
      if (env.PROBE_NAME) await E(control).probe(env.PROBE_NAME);
      if (env.FAIL_DISPOSAL === '1') throw Error('Injected disposal failure');
    }),
  );
  const incarnation = await E(control).constructed();
  return Far('DisposalBarrierService', {
    registerLate: () => E(context).addDisposalHook(Far('LateHook', () => {})),
    cancelAgain: () => E(context).cancel(Error('Repeated old cancellation')),
    read: () => {
      if (closed) throw Error('Old service is closed');
      return incarnation;
    },
  });
};
harden(make);
