/* global process */
import os from 'os';
import { E } from '@endo/eventual-send';
import { withEndoHost } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';

/**
 * @file `endo interval list|pause|resume <name>` — the CLI surface for the
 * EndoClaw interval scheduler (endoclaw-timer design § Phase 4). `<name>` is
 * the pet name a scheduler was stored under by `host.makeIntervalScheduler`,
 * which resolves to the `{ scheduler, schedulerControl }` facet pair: `list`
 * reads through the agent-facing `scheduler` facet, while `pause` / `resume`
 * drive the host-retained `schedulerControl` (IntervalControl) facet.
 */

/** @import { IntervalEntry } from '@endo/daemon' */

/**
 * Resolve a scheduler pet name to its `{ scheduler, schedulerControl }` facet
 * pair, failing with a clear message when the name resolves to something else.
 *
 * @param {any} host
 * @param {string} name
 */
const lookupScheduler = async (host, name) => {
  const capability = await E(host).lookup(...parsePetNamePath(name));
  if (
    capability === null ||
    typeof capability !== 'object' ||
    capability.scheduler === undefined ||
    capability.schedulerControl === undefined
  ) {
    throw new Error(
      `"${name}" is not an interval scheduler (expected a { scheduler, schedulerControl } capability)`,
    );
  }
  return capability;
};

/**
 * Render a list of interval entries as aligned, human-readable lines. Pure and
 * side-effect free so it can be unit-tested without a live daemon.
 *
 * @param {IntervalEntry[]} entries
 * @returns {string[]}
 */
export const renderIntervalList = entries => {
  if (entries.length === 0) {
    return ['No intervals.'];
  }
  const header = {
    label: 'LABEL',
    period: 'PERIOD',
    status: 'STATUS',
    ticks: 'TICKS',
    id: 'ID',
  };
  const rows = entries.map(entry => ({
    label: entry.label,
    period: `${entry.periodMs}ms`,
    status: entry.status,
    ticks: `${entry.tickCount}`,
    id: entry.id,
  }));
  const widthOf = key =>
    Math.max(header[key].length, ...rows.map(row => row[key].length));
  const widths = {
    label: widthOf('label'),
    period: widthOf('period'),
    status: widthOf('status'),
    ticks: widthOf('ticks'),
    id: widthOf('id'),
  };
  const formatRow = row =>
    [
      row.label.padEnd(widths.label),
      row.period.padEnd(widths.period),
      row.status.padEnd(widths.status),
      row.ticks.padStart(widths.ticks),
      row.id,
    ].join('  ');
  return [formatRow(header), ...rows.map(formatRow)];
};

/**
 * @param {{ name: string }} args
 */
export const intervalList = async ({ name }) =>
  withEndoHost({ os, process }, async ({ host }) => {
    const { scheduler } = await lookupScheduler(host, name);
    const entries = await E(scheduler).list();
    for (const line of renderIntervalList(entries)) {
      console.log(line);
    }
  });

/**
 * @param {{ name: string }} args
 */
export const intervalPause = async ({ name }) =>
  withEndoHost({ os, process }, async ({ host }) => {
    const { schedulerControl } = await lookupScheduler(host, name);
    await E(schedulerControl).pause();
    console.log(`Paused interval scheduler "${name}".`);
  });

/**
 * @param {{ name: string }} args
 */
export const intervalResume = async ({ name }) =>
  withEndoHost({ os, process }, async ({ host }) => {
    const { schedulerControl } = await lookupScheduler(host, name);
    await E(schedulerControl).resume();
    console.log(`Resumed interval scheduler "${name}".`);
  });
