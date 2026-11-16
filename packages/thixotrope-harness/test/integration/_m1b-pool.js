// @ts-check
/**
 * Helpers of the pool integration tests (M1b W1b.5): the m1b-pool state
 * template (`m1bTemplateOptions`: the real session program, the stand-in
 * exec program `guest/factory/standin-exec.js`, the factory's default pool
 * of 2 session spares and 1 exec spare, provisioned with its spares made
 * and asleep). AVA skips files starting with an underscore.
 */
import {
  crankBudget,
  emit,
  loadAvg,
  runIdentity,
} from '../../perf/_harness.mjs';
import {
  m1bTemplateOptions,
  standinExecEntry,
} from '../../scripts/provision-steps.js';
import { ensureTemplate } from '../template/index.js';

/** The m1b-pool template (built once per code change, then cached). */
export const poolTemplate = async () => {
  /** @type {any[]} */
  const steps = [];
  const options = await m1bTemplateOptions({
    execEntry: standinExecEntry,
    prefix: 'm1bp',
    onStep: report => steps.push(report),
  });
  const template = await ensureTemplate(options);
  if (template.built)
    emit({
      metric: 'm1b.pool.template',
      buildMs: template.buildMs,
      steps: steps.map(s => ({
        name: s.name,
        ms: s.ms,
        skipped: s.skipped,
        ...(s.detail ? { detail: s.detail } : {}),
      })),
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    });
  return template;
};
