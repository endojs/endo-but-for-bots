// @ts-check
import { E } from '@endo/eventual-send';
import harden from '@endo/harden';

/**
 * Operator view of session execution, separate from cooperative turn cancel.
 * Selection epochs prevent a late stop/resume result painting another session.
 * @param {{ notify: () => void }} options
 */
export const makeFlootExecution = ({ notify }) => {
  let epoch = 0n;
  let selected;
  let changing = false;
  let action = '';
  let supported = false;
  let state = 'unavailable';
  let error = '';
  const accept = value => {
    if (
      !value ||
      typeof value.supported !== 'boolean' ||
      !['running', 'stopping', 'stopped'].includes(value.state)
    )
      throw Error('Invalid session execution state');
    supported = value.supported;
    state = value.state;
  };
  const refresh = async () => {
    if (!selected || changing) return;
    epoch += 1n;
    const generation = epoch;
    const facet = selected;
    try {
      // eslint-disable-next-line no-underscore-dangle
      const methods = await E(facet).__getMethodNames__();
      if (generation !== epoch) return;
      if (
        !['getExecutionState', 'emergencyStop', 'resume'].every(name =>
          methods.includes(name),
        )
      ) {
        supported = false;
        state = 'unavailable';
      } else {
        const value = await E(facet).getExecutionState();
        if (generation !== epoch) return;
        accept(value);
        error = '';
      }
    } catch (reason) {
      if (generation !== epoch) return;
      error = reason instanceof Error ? reason.message : String(reason);
    }
    if (generation === epoch) notify();
  };
  const change = async method => {
    if (
      !selected ||
      !supported ||
      (changing && !(method === 'emergencyStop' && action === 'resume'))
    )
      return;
    if (method === 'resume' && state !== 'stopped') return;
    epoch += 1n;
    const generation = epoch;
    const facet = selected;
    changing = true;
    action = method;
    error = '';
    if (method === 'emergencyStop') state = 'stopping';
    notify();
    try {
      const value = await E(facet)[method]();
      if (generation !== epoch) return;
      accept(value);
    } catch (reason) {
      if (generation !== epoch) return;
      error = reason instanceof Error ? reason.message : String(reason);
    } finally {
      if (generation === epoch) {
        changing = false;
        action = '';
        notify();
      }
    }
  };
  return harden({
    select: async facet => {
      epoch += 1n;
      selected = facet;
      changing = false;
      action = '';
      supported = false;
      state = 'unavailable';
      error = '';
      notify();
      await refresh();
    },
    refresh,
    stop: () => change('emergencyStop'),
    resume: () => change('resume'),
    getState: () => ({
      state,
      supported,
      changing,
      action,
      error,
      blocked: supported && (changing || state !== 'running'),
    }),
  });
};
harden(makeFlootExecution);
