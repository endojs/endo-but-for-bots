// @ts-check
//
// The steward-view surface: the autonomous-loop posture rendered as a
// read-only cockpit projection (designs/garden-cockpit.md § "Later"). The MVP
// derives it from the live thread registry; a full steward view would also
// tail the standing-monitor daemon logs.

/**
 * @param {object} options
 * @param {{ list: () => Array<{ id: string, templateName: string, status: string, o11y: { turns: number } }> }} options.registry
 */
export const makeSteward = ({ registry }) => {
  const view = () => {
    const threads = registry.list();
    const running = threads.filter(t => t.status === 'running');
    return harden({
      autonomousLoop: {
        posture: 'steward',
        status: running.length > 0 ? 'active' : 'idle',
        runningThreads: running.length,
        totalThreads: threads.length,
      },
      feed: threads
        .slice(-12)
        .reverse()
        .map(
          t =>
            `${t.id} · ${t.templateName} · ${t.status} · ${t.o11y.turns} turns`,
        ),
    });
  };
  return harden({ view });
};
harden(makeSteward);
