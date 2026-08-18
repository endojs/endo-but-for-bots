// @ts-check

import harden from '@endo/harden';
import { h } from 'preact';
import { useEffect, useErrorBoundary, useMemo, useState } from 'preact/hooks';
import { E } from '@endo/eventual-send';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { makeRunSyncClient } from '@endo/workflow/src/sync.js';

import { StatechartView } from './StatechartView.js';
import { TimelineView } from './TimelineView.js';

/** @import { VNode } from 'preact' */

/**
 * The workflow space: a runs rail fed by `followRuns()`, the run's own
 * chart drawn as a statechart with active-path and pending overlays,
 * and the journal timeline with a time-travel scrubber over the
 * client-side fold.
 *
 * Authority-scoped by construction: the space receives the service (or
 * any narrower object exposing `list` / `followRuns` / `run`) and every
 * run surface it touches is the read-only `WorkflowRun` facet — the
 * space can watch, never steer.
 *
 * @param {{ service: any }} props
 * @returns {VNode}
 */
export const WorkflowApp = ({ service }) => {
  const [summaries, setSummaries] = useState(/** @type {any[]} */ ([]));
  const [selectedRunId, setSelectedRunId] = useState(
    /** @type {string | undefined} */ (undefined),
  );
  const [chart, setChart] = useState(/** @type {any} */ (undefined));
  const [client, setClient] = useState(/** @type {any} */ (undefined));
  const [, setEntryCount] = useState(0);
  const [scrubSeq, setScrubSeq] = useState(
    /** @type {number | undefined} */ (undefined),
  );
  const [filter, setFilter] = useState('');
  const [stale, setStale] = useState(false);
  // A malformed chart body or an exotic value in an entry must not
  // blank the whole space; catch render throws in the center/timeline
  // subtree and show a recoverable notice instead.
  const [renderError, resetRenderError] = useErrorBoundary();

  // Runs rail: dedupe followRuns() summaries by runId, last-writer-wins
  // on seq.
  useEffect(() => {
    let disposed = false;
    // The exo reader has no `return` method; disposal goes through the
    // LOCAL iterator, whose `return()` sends the close signal to the
    // responder so the daemon-side follower is released promptly (the
    // same discipline as the other spaces' change followers).
    /** @type {any} */
    let iterator;
    (async () => {
      const initial = await E(service).list();
      if (disposed) return;
      setSummaries(initial);
      setStale(false);
      const reader = await E(service).followRuns();
      iterator = iterateReader(reader);
      // Cleanup may have run while followRuns() was in flight; close the
      // iterator we just made rather than parking on it forever.
      if (disposed) {
        iterator.return(undefined).catch(() => {});
        return;
      }
      for await (const summary of /** @type {AsyncIterable<any>} */ (
        iterator
      )) {
        if (disposed) break;
        setSummaries(previous => {
          const kept = previous.find(
            existing => existing.runId === summary.runId,
          );
          if (kept !== undefined && Number(kept.seq) > Number(summary.seq)) {
            return previous;
          }
          const next = previous.filter(
            existing => existing.runId !== summary.runId,
          );
          return [...next, summary];
        });
      }
    })().catch(() => {
      if (!disposed) {
        setStale(true);
      }
    });
    return () => {
      disposed = true;
      if (iterator !== undefined) {
        iterator.return(undefined).catch(() => {});
      }
    };
  }, [service]);

  // Selected run: its self-contained chart snapshot plus a sync client
  // over its read-only facet.
  useEffect(() => {
    if (selectedRunId === undefined) return undefined;
    let disposed = false;
    /** @type {any} */
    let syncClient;
    (async () => {
      const run = await E(service).run(selectedRunId);
      const runChart = await E(run).chart();
      // Re-check after every await: the user may have switched runs
      // while these eventual-sends were in flight. Continuing would leak
      // an unmanaged sync client and tear the render (chart from the old
      // run, state from the new).
      if (disposed) return;
      setChart(runChart);
      setStale(false);
      syncClient = makeRunSyncClient(run, {
        iterateEntries: iterateReader,
        onEntry: () => {
          if (!disposed) setEntryCount(count => count + 1);
        },
        onError: () => {
          if (!disposed) setStale(true);
        },
      });
      setClient(() => syncClient);
    })().catch(() => {
      if (!disposed) {
        setStale(true);
      }
    });
    return () => {
      disposed = true;
      if (syncClient) syncClient.stop();
    };
  }, [service, selectedRunId]);

  const entries = client === undefined ? [] : client.entries();
  const current = client === undefined ? undefined : client.current();
  const lastSeq = current === undefined ? 0 : Number(current.seq) - 1;
  const scrubbed = useMemo(
    () =>
      scrubSeq === undefined || client === undefined
        ? undefined
        : client.stateAt(BigInt(scrubSeq) + 1n),
    [client, scrubSeq, entries.length],
  );
  const shownState = scrubbed ?? current;
  // Client-side audit: re-verify the received journal's hash chain.
  const chain = useMemo(
    () => (client === undefined ? undefined : client.verify()),
    [client, entries.length],
  );
  /** @param {number | undefined} seq */
  const scrub = seq =>
    setScrubSeq(seq !== undefined && seq >= lastSeq ? undefined : seq);

  return h('div', { class: 'wf-app' }, [
    h('nav', { class: 'wf-rail' }, [
      h('h3', { class: 'wf-rail-title' }, 'Runs'),
      h(
        'ul',
        { class: 'wf-rail-list' },
        summaries.map(summary =>
          h(
            'li',
            { key: summary.runId },
            h(
              'button',
              {
                class:
                  summary.runId === selectedRunId
                    ? 'wf-rail-run wf-rail-run-selected'
                    : 'wf-rail-run',
                onClick: () => {
                  // A render error from one run must not stick to the
                  // next selection.
                  resetRenderError();
                  setSelectedRunId(summary.runId);
                  setScrubSeq(undefined);
                },
              },
              [
                h(
                  'span',
                  {
                    class: `wf-rail-badge wf-rail-badge-${summary.outcome ?? 'live'}`,
                  },
                  `${summary.integrity !== undefined ? '⚠ ' : ''}${
                    summary.outcome ??
                    (summary.paused ? 'paused' : (summary.state ?? 'live'))
                  }`,
                ),
                h(
                  'span',
                  { class: 'wf-rail-name' },
                  `${summary.chartName ?? '?'} ${summary.runId}`,
                ),
              ],
            ),
          ),
        ),
      ),
      stale
        ? h(
            'div',
            { class: 'wf-stale' },
            'workflow service unreachable — provision @endo/workflow and name it in this space, then reopen',
          )
        : null,
    ]),
    renderError
      ? h('main', { class: 'wf-main' }, [
          h('div', { class: 'wf-placeholder' }, [
            h('p', null, 'This run could not be rendered.'),
            h(
              'button',
              {
                onClick: () => {
                  resetRenderError();
                  setScrubSeq(undefined);
                },
              },
              'Retry',
            ),
          ]),
        ])
      : h('main', { class: 'wf-main' }, [
          chart !== undefined && shownState !== undefined
            ? h(StatechartView, {
                chart,
                configuration: shownState.configuration,
                liveConfiguration: current?.configuration,
                outcome: shownState.outcome,
                pending: shownState.pending ?? [],
              })
            : h(
                'div',
                { class: 'wf-placeholder' },
                selectedRunId === undefined ? 'Select a run' : 'Loading run…',
              ),
          chain !== undefined && chain.ok === false
            ? h(
                'div',
                { class: 'wf-stale' },
                `⚠ journal hash chain broken at #${chain.badSeq}`,
              )
            : null,
          client !== undefined && lastSeq > 0
            ? h('div', { class: 'wf-scrubber' }, [
                h('input', {
                  type: 'range',
                  min: 0,
                  max: lastSeq,
                  value: scrubSeq ?? lastSeq,
                  onInput: (/** @type {any} */ event) => {
                    scrub(Number(event.currentTarget.value));
                  },
                }),
                h(
                  'span',
                  { class: 'wf-scrubber-label' },
                  scrubSeq === undefined ? 'live' : `#${scrubSeq}`,
                ),
              ])
            : null,
        ]),
    renderError
      ? null
      : h('aside', { class: 'wf-side' }, [
          h('input', {
            class: 'wf-filter',
            placeholder: 'filter events…',
            value: filter,
            onInput: (/** @type {any} */ event) =>
              setFilter(event.currentTarget.value),
          }),
          h(TimelineView, {
            // Keyed by run so expansion state cannot bleed across runs.
            key: selectedRunId ?? 'none',
            entries,
            scrubSeq,
            onScrub: scrub,
            filter,
          }),
        ]),
  ]);
};
harden(WorkflowApp);
