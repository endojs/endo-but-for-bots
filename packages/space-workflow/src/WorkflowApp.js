// @ts-check

import harden from '@endo/harden';
import { h } from 'preact';
import { useEffect, useErrorBoundary, useMemo, useState } from 'preact/hooks';
import { E } from '@endo/eventual-send';
import { makeWorkflowSyncClient } from '@endo/workflow/src/sync.js';

import { StatechartView } from './StatechartView.js';
import { TimelineView } from './TimelineView.js';

/** @import { VNode } from 'preact' */

/**
 * The workflow space: a runs rail fed by `followRuns()`, the definition
 * statechart with live overlays, and the event timeline with a
 * time-travel scrubber over the client-side fold.
 *
 * Authority-scoped by construction: the space receives the service (or
 * a narrower object exposing `runs`/`followRuns`/`run`) and renders
 * only what its facets can do — an observer facet is read-only.
 *
 * @param {{ service: any }} props
 * @returns {VNode}
 */
export const WorkflowApp = ({ service }) => {
  const [summaries, setSummaries] = useState(/** @type {any[]} */ ([]));
  const [selectedRunId, setSelectedRunId] = useState(
    /** @type {string | undefined} */ (undefined),
  );
  const [definition, setDefinition] = useState(/** @type {any} */ (undefined));
  const [client, setClient] = useState(/** @type {any} */ (undefined));
  const [, setEventCount] = useState(0);
  const [scrubSeq, setScrubSeq] = useState(
    /** @type {number | undefined} */ (undefined),
  );
  const [filter, setFilter] = useState('');
  const [stale, setStale] = useState(false);
  // A malformed definition body or an exotic (e.g. bigint) value in a
  // record must not blank the whole space; catch render throws in the
  // center/timeline subtree and show a recoverable notice instead.
  const [renderError, resetRenderError] = useErrorBoundary();

  // Runs rail: dedupe followRuns() summaries by runId,
  // last-writer-wins on throughSeq.
  useEffect(() => {
    let disposed = false;
    /** @type {any} */
    let reader;
    (async () => {
      const initial = await E(service).runs();
      if (disposed) return;
      setSummaries(initial);
      reader = await E(service).followRuns();
      // Cleanup may have run while followRuns() was in flight; close the
      // reader we just received rather than parking on it forever.
      if (disposed) {
        await reader.return?.(undefined);
        return;
      }
      for await (const summary of reader) {
        if (disposed) break;
        setSummaries(previous => {
          const next = previous.filter(
            existing => existing.runId !== summary.runId,
          );
          const kept = previous.find(
            existing => existing.runId === summary.runId,
          );
          if (
            kept !== undefined &&
            Number(kept.throughSeq) > Number(summary.throughSeq)
          ) {
            return previous;
          }
          return [...next, summary];
        });
      }
    })().catch(() => setStale(true));
    return () => {
      disposed = true;
      if (reader?.return) reader.return(undefined);
    };
  }, [service]);

  // Selected run: a sync client over its observer facet.
  useEffect(() => {
    if (selectedRunId === undefined) return undefined;
    let disposed = false;
    /** @type {any} */
    let syncClient;
    (async () => {
      const observer = await E(service).run(selectedRunId);
      const status = await E(observer).status();
      if (disposed) return;
      // The definition body travels with the summary in a later cut; for
      // now the graph renders from the definitions registry when
      // available, else from the run's own definition name lookup.
      const definitions = await E(service)
        .definitionBody?.(status.definition)
        .catch(() => undefined);
      // Re-check after every await: the user may have switched runs while
      // these eventual-sends were in flight. Continuing would leak an
      // unmanaged sync client and tear the render (definition from the
      // old run, state from the new).
      if (disposed) return;
      setDefinition(definitions);
      syncClient = makeWorkflowSyncClient(observer, {
        onEvent: () => {
          if (!disposed) setEventCount(count => count + 1);
        },
        onError: () => {
          if (!disposed) setStale(true);
        },
      });
      setClient(() => syncClient);
    })().catch(() => setStale(true));
    return () => {
      disposed = true;
      if (syncClient) syncClient.stop();
    };
  }, [service, selectedRunId]);

  const records = client?.records ?? [];
  const liveState = client?.state;
  const scrubbed = useMemo(
    () => (scrubSeq === undefined ? undefined : client?.stateAt(scrubSeq)),
    [client, scrubSeq, records.length],
  );
  const shownState = scrubbed ?? liveState;

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
                style: summary.parent ? 'margin-left: 1em' : undefined,
                onClick: () => {
                  setSelectedRunId(summary.runId);
                  setScrubSeq(undefined);
                },
              },
              [
                h(
                  'span',
                  {
                    class: `wf-rail-badge wf-rail-badge-${summary.final ?? 'live'}`,
                  },
                  summary.final ?? summary.state,
                ),
                h(
                  'span',
                  { class: 'wf-rail-name' },
                  `${summary.definition?.name ?? '?'} ${summary.runId}`,
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
          definition !== undefined && shownState !== undefined
            ? h(StatechartView, {
                definition,
                activeState: shownState.state,
                liveState: liveState?.state,
                pending: shownState.pending ?? {},
              })
            : h(
                'div',
                { class: 'wf-placeholder' },
                selectedRunId === undefined
                  ? 'Select a run'
                  : 'No definition body available to draw',
              ),
          client !== undefined
            ? h('div', { class: 'wf-scrubber' }, [
                h('input', {
                  type: 'range',
                  min: 1,
                  max: client.lastSeq,
                  value: scrubSeq ?? client.lastSeq,
                  onInput: (/** @type {any} */ event) => {
                    const seq = Number(event.currentTarget.value);
                    setScrubSeq(
                      seq >= Number(client.lastSeq) ? undefined : seq,
                    );
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
            records,
            scrubSeq,
            onScrub: setScrubSeq,
            filter,
          }),
        ]),
  ]);
};
harden(WorkflowApp);
