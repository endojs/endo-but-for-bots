// @ts-check

// Bootstrap setups named by ENDO_EXTRA run once per daemon start, and a
// failing one used to leave no trace outside the journal: the daemon logged
// the error and carried on, so a setup could do nothing at all for weeks while
// looking configured. On a host where the daemon user cannot read the journal,
// that is indistinguishable from success. Recording each outcome next to the
// daemon's other state makes "did my setup run?" answerable by anyone holding
// the state directory, without granting log access.

/**
 * @typedef {object} ExtraSetupOutcome
 * @property {string} specifier
 * @property {boolean} ok
 * @property {string} at
 * @property {string} [error]
 */

/**
 * Run each specifier's `main(host)`, in order, and report what happened.
 *
 * A setup that throws is reported and does not stop the ones after it — the
 * daemon must come up even when an optional setup cannot. The importer and
 * clock are injected so this is testable without a daemon.
 *
 * @param {object} args
 * @param {string[]} args.specifiers
 * @param {unknown} args.host
 * @param {(specifier: string) => Promise<{ main: (host: unknown) => unknown }>} args.importModule
 * @param {() => string} args.now  ISO timestamp for the record
 * @param {(message: string, error?: unknown) => void} [args.log]
 * @returns {Promise<ExtraSetupOutcome[]>}
 */
export const runExtraSetups = async ({
  specifiers,
  host,
  importModule,
  now,
  log = () => {},
}) => {
  await null;
  /** @type {ExtraSetupOutcome[]} */
  const outcomes = [];
  for (const specifier of specifiers) {
    try {
      log(`Endo extra: running ${specifier}`);
      // eslint-disable-next-line no-await-in-loop
      const namespace = await importModule(specifier);
      // eslint-disable-next-line no-await-in-loop
      await namespace.main(host);
      log(`Endo extra: ${specifier} done`);
      outcomes.push({ specifier, ok: true, at: now() });
    } catch (error) {
      log(`Endo extra: ${specifier} failed:`, error);
      const message =
        error instanceof Error ? error.message : String(error);
      outcomes.push({ specifier, ok: false, at: now(), error: message });
    }
  }
  return outcomes;
};
harden(runExtraSetups);
